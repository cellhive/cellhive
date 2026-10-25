import {
  automationDefinitionSchema,
  type AutomationDefinition,
  type EffectiveAccess,
  type Id,
} from '@cellhive/contracts';
import { resolveBaseAccess } from '@cellhive/permissions';

import { loadBaseSchemaRows, type BaseSchemaRows } from '../../computed/definition/schema-rows.js';
import { withTxScope, type OrgScope } from '../../db/repository.js';
import {
  loadMemberAccessBase,
  resolveMemberBaseAccess,
  type AccessDefaults,
  type MemberAccessBase,
  type MemberBaseAccess,
} from '../../import/member-access.js';
import { enqueue } from '../../jobs/enqueue.js';
import { ViewsRepository } from '../../views/views.repository.js';
import { IncomingWebhooksRepository } from '../../webhooks/incoming/incoming-webhooks.repository.js';
import {
  validateAutomationDefinition,
  type AutomationValidationContext,
  type AutomationViewMeta,
} from '../definition/validate.js';
import { automationSchemaOf } from '../engine/schema-context.js';
import { disableAutomationBySystem } from '../engine/system-disable.js';
import { canManageAutomation } from '../permissions/manage.js';
import { AutomationsRepository } from '../repository/automations.repository.js';

import { REVALIDATE_RUN_AS_TASK } from './request.js';

import type { Db } from '../../db/create-db.js';
import type { AutomationRow, JsonObject } from '../../db/schema.js';
import type { AutomationNotifier } from '../dispatch/notifier.js';

/** Automations read per page. */
export const REVALIDATE_RUN_AS_PAGE = 100;
/** Automations one job checks before it hands over to a new job (large organizations). */
export const REVALIDATE_RUN_AS_PER_JOB = 1_000;
/** Most validation issues (path + code, never values) kept in the audit entry. */
export const REVALIDATE_RUN_AS_AUDIT_ISSUES = 20;

/** Why `run_as` lost access (audit `after.cause`, ADR-25 §5). */
export type RunAsLostAccessCause =
  /** Not an active member of the organization any more, or no access to the base. */
  | 'no_base_access'
  /** No longer manages the automation (base admin, or `manage` on the trigger table). */
  | 'cannot_manage'
  /** The definition is no longer valid with `run_as`'s permissions. */
  | 'definition_invalid';

/**
 * Why an automation was left alone although something is wrong — not a
 * matter of `run_as`'s permissions: the stored definition no longer parses
 * or is invalid for a base admin too (a table or field was deleted: the run
 * reports it, T504), its base or trigger table is in the trash.
 */
export type RunAsCheckSkip =
  'invalid_definition' | 'schema_changed' | 'base_unavailable' | 'trigger_table_unavailable';

export type RunAsVerdict =
  | { readonly kind: 'ok' }
  | { readonly kind: 'skip'; readonly reason: RunAsCheckSkip }
  | {
      readonly kind: 'lost';
      readonly cause: RunAsLostAccessCause;
      readonly issues: readonly { readonly path: string; readonly code: string }[];
    };

export interface RunAsRevalidationResult {
  readonly checked: number;
  /** Automations turned off (`run_as_lost_access`). */
  readonly disabled: readonly Id<'aut'>[];
  /** Left alone, by reason (see {@link RunAsCheckSkip}; `changed`: changed meanwhile). */
  readonly skipped: Readonly<Record<string, number>>;
  /** The job continuing after this one (more automations left), else `null`. */
  readonly continuedAfter: Id<'aut'> | null;
}

export interface RunAsRevalidatorOptions {
  readonly defaults: AccessDefaults;
  readonly notifier?: AutomationNotifier;
  readonly pageSize?: number;
  readonly maxPerJob?: number;
  readonly now?: () => Date;
}

/** One base as read once for every automation of a job. */
interface BaseState {
  readonly loaded: MemberAccessBase;
  readonly rows: BaseSchemaRows;
  readonly tableIds: ReadonlySet<string>;
  /** Access of each `run_as` (`undefined`: none). */
  readonly members: Map<Id<'usr'>, MemberBaseAccess | undefined>;
  readonly contexts: Map<Id<'usr'>, AutomationValidationContext>;
  /** The base seen by an admin: tells a permission problem from a schema one. */
  full?: AutomationValidationContext;
}

/**
 * The `run_as` check of ADR-25 §5 (BACKLOG T507, job
 * `automation.revalidate_run_as`): every enabled automation of a base (or
 * of the organization) is checked against the **current** access of its
 * `run_as` with the save-time rules of T502 (ADR-25 §3,
 * `validateAutomationDefinition`). `run_as` lost access when it is no
 * longer an active member with access to the base, no longer manages the
 * automation, or the definition is no longer valid for it while it still
 * is for a base admin (otherwise the schema changed, not the permissions:
 * left alone). Lost → in one transaction per automation, the row locked
 * and unchanged since the check: `enabled = false`,
 * `disabled_reason = run_as_lost_access`, `queued`/`waiting` runs
 * `cancelled`, event + audit `automation.disabled`, notification
 * `automation.disabled` (T511, mandatory) to `run_as` + base owner/admins.
 * Running runs end at their failing step (`permission_denied`, T505).
 *
 * Idempotent: an automation already off is not listed; a job delivered
 * twice changes nothing more. Reads in pages of {@link REVALIDATE_RUN_AS_PAGE}
 * by id; after {@link REVALIDATE_RUN_AS_PER_JOB} automations it adds a job
 * continuing after the last id. Never logs or stores record values.
 */
export class RunAsRevalidator {
  private readonly automations: AutomationsRepository;
  private readonly views: ViewsRepository;
  private readonly hooks: IncomingWebhooksRepository;
  private readonly pageSize: number;
  private readonly maxPerJob: number;

  constructor(
    private readonly db: Db,
    private readonly options: RunAsRevalidatorOptions,
  ) {
    this.automations = new AutomationsRepository(db);
    this.views = new ViewsRepository(db);
    this.hooks = new IncomingWebhooksRepository(db);
    this.pageSize = options.pageSize ?? REVALIDATE_RUN_AS_PAGE;
    this.maxPerJob = options.maxPerJob ?? REVALIDATE_RUN_AS_PER_JOB;
  }

  async revalidate(
    scope: OrgScope,
    input: { readonly baseId: Id<'bse'> | null; readonly after: Id<'aut'> | null },
  ): Promise<RunAsRevalidationResult> {
    const bases = new Map<Id<'bse'>, BaseState | null>();
    const disabled: Id<'aut'>[] = [];
    const skipped: Record<string, number> = {};
    let checked = 0;
    let after = input.after;
    for (;;) {
      const page = await this.automations.listEnabledPage(scope, {
        baseId: input.baseId,
        after,
        limit: this.pageSize,
      });
      for (const row of page) {
        checked += 1;
        const verdict = await this.check(scope, row, bases);
        if (verdict.kind === 'skip') {
          skipped[verdict.reason] = (skipped[verdict.reason] ?? 0) + 1;
        } else if (verdict.kind === 'lost') {
          if (await this.turnOff(scope, row, verdict)) disabled.push(row.id);
          else skipped['changed'] = (skipped['changed'] ?? 0) + 1;
        }
      }
      const last = page.at(-1);
      if (page.length < this.pageSize || last === undefined) {
        return { checked, disabled, skipped, continuedAfter: null };
      }
      after = last.id;
      if (checked >= this.maxPerJob) {
        await this.db.withTx((tx) =>
          enqueue(tx, REVALIDATE_RUN_AS_TASK, {
            organization_id: scope.organizationId,
            base_id: input.baseId,
            after,
          }),
        );
        return { checked, disabled, skipped, continuedAfter: after };
      }
    }
  }

  /** Whether `run_as` of `row` still has what the automation needs (no write). */
  async check(
    scope: OrgScope,
    row: AutomationRow,
    bases: Map<Id<'bse'>, BaseState | null> = new Map(),
  ): Promise<RunAsVerdict> {
    const parsed = automationDefinitionSchema.safeParse(row.definition);
    if (!parsed.success) return { kind: 'skip', reason: 'invalid_definition' };
    const base = await this.baseState(scope, row.base_id, bases);
    // The base is in the trash (or gone): nothing runs there, nothing to decide.
    if (base === null) return { kind: 'skip', reason: 'base_unavailable' };
    if (row.trigger_table_id !== null && !base.tableIds.has(row.trigger_table_id)) {
      return { kind: 'skip', reason: 'trigger_table_unavailable' };
    }
    const member = await this.memberAccess(scope, base, row);
    if (member === undefined) return { kind: 'lost', cause: 'no_base_access', issues: [] };
    const access = member.record.resolved.access;
    if (!canManageAutomation(access, row.trigger_table_id)) {
      return { kind: 'lost', cause: 'cannot_manage', issues: [] };
    }
    const definition = parsed.data;
    const views = await this.viewsOf(scope, definition, base);
    const incomingWebhookIds = await this.hooksOf(scope, definition, row.base_id);
    let context = base.contexts.get(row.run_as_user_id);
    if (context === undefined) {
      context = automationSchemaOf(base.rows, access, base.loaded.base.settings);
      base.contexts.set(row.run_as_user_id, context);
    }
    const result = validateAutomationDefinition(definition, {
      ...context,
      views,
      incomingWebhookIds,
    });
    if (result.ok) return { kind: 'ok' };
    base.full ??= automationSchemaOf(
      base.rows,
      adminAccessOf(base.loaded, row.run_as_user_id),
      base.loaded.base.settings,
    );
    if (!validateAutomationDefinition(definition, { ...base.full, views, incomingWebhookIds }).ok) {
      return { kind: 'skip', reason: 'schema_changed' };
    }
    return {
      kind: 'lost',
      cause: 'definition_invalid',
      issues: result.errors
        .slice(0, REVALIDATE_RUN_AS_AUDIT_ISSUES)
        .map((issue) => ({ path: issue.path, code: issue.code })),
    };
  }

  /** Turns `row` off unless it changed since it was checked; whether it did. */
  private async turnOff(
    scope: OrgScope,
    row: AutomationRow,
    verdict: Extract<RunAsVerdict, { kind: 'lost' }>,
  ): Promise<boolean> {
    return this.db.withTx(async (tx) => {
      const current = await this.automations.lockEnabled(withTxScope(scope, tx), row.id);
      // Turned off, edited, enabled or taken over meanwhile: that save was checked (ADR-25 §3).
      if (
        current === undefined ||
        current.version !== row.version ||
        current.run_as_user_id !== row.run_as_user_id
      ) {
        return false;
      }
      const detail: JsonObject = {
        cause: verdict.cause,
        ...(verdict.issues.length === 0
          ? {}
          : { issues: verdict.issues.map((issue) => ({ path: issue.path, code: issue.code })) }),
      };
      const updated = await disableAutomationBySystem(
        this.db,
        tx,
        scope,
        current,
        'run_as_lost_access',
        {
          cancelQueued: true,
          auditDetail: detail,
          ...(this.options.notifier === undefined ? {} : { notifier: this.options.notifier }),
          ...(this.options.now === undefined ? {} : { now: this.options.now }),
        },
      );
      return updated !== undefined;
    });
  }

  private async baseState(
    scope: OrgScope,
    baseId: Id<'bse'>,
    bases: Map<Id<'bse'>, BaseState | null>,
  ): Promise<BaseState | null> {
    const known = bases.get(baseId);
    if (known !== undefined) return known;
    const loaded = await loadMemberAccessBase(this.db, scope, baseId);
    let state: BaseState | null = null;
    if (loaded !== undefined) {
      const rows = await loadBaseSchemaRows(this.db, scope, baseId);
      state = {
        loaded,
        rows,
        tableIds: new Set(rows.tables.map((table) => table.id)),
        members: new Map(),
        contexts: new Map(),
      };
    }
    bases.set(baseId, state);
    return state;
  }

  private async memberAccess(
    scope: OrgScope,
    base: BaseState,
    row: AutomationRow,
  ): Promise<MemberBaseAccess | undefined> {
    if (base.members.has(row.run_as_user_id)) return base.members.get(row.run_as_user_id);
    const access = await resolveMemberBaseAccess(
      this.db,
      scope,
      { userId: row.run_as_user_id, baseId: row.base_id },
      this.options.defaults,
      base.loaded,
    );
    base.members.set(row.run_as_user_id, access);
    return access;
  }

  /** The hook a `webhook.received` trigger names when live in the base (T604), as when saved. */
  private async hooksOf(
    scope: OrgScope,
    definition: AutomationDefinition,
    baseId: Id<'bse'>,
  ): Promise<Set<string>> {
    if (definition.trigger.type !== 'webhook.received') return new Set();
    const hook = await this.hooks.findById(scope, definition.trigger.incoming_webhook_id);
    return hook?.base_id === baseId ? new Set([hook.id]) : new Set();
  }

  /** The form a `form.submitted` trigger names, as the save-time check sees it. */
  private async viewsOf(
    scope: OrgScope,
    definition: AutomationDefinition,
    base: BaseState,
  ): Promise<Map<string, AutomationViewMeta>> {
    const views = new Map<string, AutomationViewMeta>();
    if (definition.trigger.type !== 'form.submitted') return views;
    const view = await this.views.getById(scope, definition.trigger.view_id);
    if (view !== undefined && base.tableIds.has(view.table_id)) {
      views.set(view.id, {
        id: view.id,
        table_id: view.table_id,
        type: view.type,
        is_personal: view.is_personal,
      });
    }
    return views;
  }
}

/** Full access to the base: what an organization owner sees (every table and field). */
function adminAccessOf(loaded: MemberAccessBase, userId: Id<'usr'>): EffectiveAccess {
  const resolved = resolveBaseAccess({
    principal: { userId, groupIds: [], orgRole: 'owner', workspaceRole: null, isBaseOwner: true },
    roles: [...loaded.roles],
    assignments: [...loaded.assignments],
    schema: loaded.schema,
  });
  // An organization owner always resolves. Otherwise nothing is readable, so
  // a failing definition counts as a schema problem: left alone.
  return (
    resolved?.access ?? {
      role: null,
      is_admin: false,
      base_rule: { copy: false, download: false, share_link: false },
      tables: {},
      dashboards: {},
    }
  );
}
