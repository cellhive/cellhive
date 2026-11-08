import {
  idOf,
  MCP_AUTOMATION_DRAFT_TTL_SECONDS,
  MCP_AUTOMATION_DRAFTS_PER_USER,
  mcpAutomationDraftSchema,
  newId,
  type AutomationDefinition,
  type Id,
  type McpAutomationDraft,
} from '@cellhive/contracts';
import {
  AppError,
  automationDigestTableIds,
  automationDraftDigest,
  automationDraftOfInput,
  automationValidationProblems,
  canManageAutomation,
  compileAutomationDraft,
  literalChatWarnings,
  managesAnyAutomation,
  OrganizationsRepository,
  orgEmailSettingsOf,
  SecretsRepository,
  ViewsRepository,
  type AiOutputProblem,
  type AiValidation,
  type AppConfig,
  type AutomationDraft,
  type AutomationDraftDigest,
  type AutomationDraftInput,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import {
  AccessService,
  notFound,
  permissionDenied,
  type BaseAccess,
} from '../../common/access/access.service.js';
import { CACHE_KEY_PREFIX, cacheCommand } from '../../common/rate-limit/rate-limiter.js';
import { APP_CONFIG, CACHE_CLIENT } from '../../common/tokens.js';

import { AutomationService } from './automation.service.js';

import type { Principal } from '../../common/auth/principal.js';
import type { Redis } from 'ioredis';
import type { z } from 'zod';

function cannotManage(): AppError {
  return permissionDenied(
    'Automations are managed by base admins and by people with manage rights on the trigger table.',
  );
}

/** What a draft of the caller is compiled and checked against (T908, T1015). */
export interface AutomationDraftScope {
  readonly base: BaseAccess;
  /** The caller's digest; `recordData`: the AI actions may be drafted (T911). */
  digestOf(recordData: boolean): AutomationDraftDigest;
}

/** A draft kept for its creator (Valkey): the DTO plus who and where. */
const storedDraftSchema = mcpAutomationDraftSchema.extend({
  user_id: idOf('usr'),
  organization_id: idOf('org'),
});

const draftKey = (draftId: string) => `${CACHE_KEY_PREFIX}mcp-draft:${draftId}`;
/** The ids of a user's drafts, newest first (at most `MCP_AUTOMATION_DRAFTS_PER_USER`). */
const userDraftsKey = (userId: string) => `${CACHE_KEY_PREFIX}mcp-drafts:${userId}`;

/** Problems of a client's draft as `VALIDATION_FAILED` items under `draft`. */
function draftInvalid(problems: readonly AiOutputProblem[]): AppError {
  return new AppError('VALIDATION_FAILED', {
    detail:
      'The draft does not compile, or does not pass the check of saving it, with your permissions.',
    errors: problems.map((problem) => ({
      path: problem.path === '' ? 'draft' : `draft.${problem.path}`,
      code: problem.code,
      message: problem.message,
    })),
  });
}

/**
 * Drafts of automations (CONTRACTS §29.3, §30.8; BACKLOG T908, T1015):
 *
 * - the caller's digest and the check of a draft by name, shared by "Create
 *   with AI" (T908) and the MCP tool `draft_automation` — compiled with
 *   {@link compileAutomationDraft}, then checked exactly like
 *   `POST /bases/:baseId/automations` would for the caller
 *   (`AutomationService.validate` + the trigger-table right);
 * - a client's draft (MCP): checked, then kept in Valkey for 24 hours,
 *   bound to its creator, organization and base (`ob:mcp-draft:<mdr_…>`,
 *   at most `MCP_AUTOMATION_DRAFTS_PER_USER` per user); nothing in
 *   `meta.automations`, no event, no call to the organization's AI;
 * - `GET /bases/:baseId/automation-drafts/:draftId` (session only, the
 *   route table): the builder of the creator reads it; anyone else →
 *   `404`.
 */
@Injectable()
export class AutomationDraftsService {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AutomationService) private readonly automations: AutomationService,
    @Inject(ViewsRepository) private readonly views: ViewsRepository,
    @Inject(SecretsRepository) private readonly secrets: SecretsRepository,
    @Inject(OrganizationsRepository) private readonly organizations: OrganizationsRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CACHE_CLIENT) private readonly cache: Redis,
  ) {}

  /**
   * The base and the caller's digest (BACKLOG T908), with the right to
   * create automations in the base (ADR-25) like the automation routes:
   * the base unreachable → `404`; readable without managing anything →
   * `403`; `tableId` not readable (trash, another base) → `404`, readable
   * but not managed → `403`.
   */
  async scopeOf(
    principal: Principal,
    baseId: Id<'bse'>,
    tableId: Id<'tbl'> | null,
  ): Promise<AutomationDraftScope> {
    const base = await this.access.requireBase(principal, baseId, 'read');
    if (!managesAnyAutomation(base.access)) throw cannotManage();
    const context = await this.automations.schemaContext(base);
    if (tableId !== null) {
      const readable =
        base.access.tables[tableId] !== undefined &&
        context.tables.some((table) => table.id === tableId);
      if (!readable) throw notFound();
      if (!canManageAutomation(base.access, tableId)) throw cannotManage();
    }
    const scope = base.org.scope;
    const tableIds = automationDigestTableIds(context, tableId);
    const views = await Promise.all(tableIds.map((id) => this.views.listByTable(scope, id, null)));
    const bots = await this.secrets.listUsableInBase(scope, base.base.id, 'telegram_bot');
    const organization = await this.organizations.findById(base.org.organizationId);
    // The system sender: a draft never picks a sender identity (the builder can).
    const email =
      this.config.mail !== null && orgEmailSettingsOf(organization?.settings).systemSenderEnabled;
    return {
      base,
      digestOf: (recordData) =>
        automationDraftDigest({
          context,
          views: views.flat(),
          bots,
          email,
          currentTableId: tableId,
          recordData,
        }),
    };
  }

  /**
   * A draft by name compiled to a definition with ids and checked like
   * `POST /automations` for the caller (a draft is never enabled: no
   * `NO_ACTIONS`); problems name draft paths, never an id.
   */
  async check(
    base: BaseAccess,
    digest: AutomationDraftDigest,
    draft: AutomationDraft,
  ): Promise<AiValidation<{ readonly definition: AutomationDefinition }>> {
    const compiled = compileAutomationDraft(draft, digest);
    if (!compiled.ok) return compiled;
    try {
      const saved = await this.automations.validate(base, compiled.definition, null);
      if (!canManageAutomation(base.access, saved.triggerTableId)) {
        return {
          ok: false,
          problems: [
            {
              path: 'trigger',
              code: 'PERMISSION_DENIED',
              message: 'You cannot manage automations of this trigger',
            },
          ],
        };
      }
      return { ok: true, value: { definition: saved.definition } };
    } catch (error) {
      if (error instanceof AppError && error.code === 'AUTOMATION_INVALID') {
        return { ok: false, problems: automationValidationProblems(error.errors ?? [], digest) };
      }
      throw error;
    }
  }

  /**
   * MCP `draft_automation` (CONTRACTS §30.8): the client's draft checked
   * with the caller's digest — `VALIDATION_FAILED` with `draft.…` paths
   * otherwise — plus the server's warnings (`literal_chat_id`), then kept
   * for 24 hours for the caller in this base. Never stored in the base,
   * never sent to the organization's AI provider.
   */
  async draftFromClient(
    principal: Principal,
    baseId: Id<'bse'>,
    tableId: Id<'tbl'> | null,
    input: AutomationDraftInput,
  ): Promise<McpAutomationDraft> {
    const scope = await this.scopeOf(principal, baseId, tableId);
    const digest = scope.digestOf(false);
    const converted = automationDraftOfInput(input, digest);
    if (!converted.ok) throw draftInvalid(converted.problems);
    const checked = await this.check(scope.base, digest, converted.draft);
    if (!checked.ok) throw draftInvalid(checked.problems);
    const { definition } = checked.value;
    const draft: McpAutomationDraft = {
      id: newId('mdr'),
      base_id: scope.base.base.id,
      name: input.name,
      definition,
      explanation: input.explanation,
      warnings: literalChatWarnings(definition),
      expires_at: new Date(Date.now() + MCP_AUTOMATION_DRAFT_TTL_SECONDS * 1000).toISOString(),
    };
    await this.keep(principal.userId, scope.base.org.organizationId, draft);
    return draft;
  }

  /**
   * `GET /bases/:baseId/automation-drafts/:draftId` (CONTRACTS §30.8): the
   * draft of the caller in this base. The base unreachable, a draft that
   * does not exist, has expired, is someone else's, of another organization
   * or another base → `404`; its creator who no longer manages an
   * automation of the base → `403`.
   */
  async get(
    principal: Principal,
    baseId: Id<'bse'>,
    draftId: Id<'mdr'>,
  ): Promise<McpAutomationDraft> {
    const base = await this.access.requireBase(principal, baseId, 'read');
    const raw = await cacheCommand(this.cache, (client) => client.get(draftKey(draftId)));
    const stored = raw === null ? undefined : this.parse(raw);
    if (
      stored?.id !== draftId ||
      stored.user_id !== principal.userId ||
      stored.organization_id !== base.org.organizationId ||
      stored.base_id !== base.base.id ||
      Date.parse(stored.expires_at) <= Date.now()
    ) {
      throw notFound();
    }
    if (!managesAnyAutomation(base.access)) throw cannotManage();
    return {
      id: stored.id,
      base_id: stored.base_id,
      name: stored.name,
      definition: stored.definition,
      explanation: stored.explanation,
      warnings: stored.warnings,
      expires_at: stored.expires_at,
    };
  }

  private parse(raw: string): z.output<typeof storedDraftSchema> | undefined {
    try {
      const parsed = storedDraftSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Keeps `draft` for 24 hours and adds it to its creator's list; drafts
   * past `MCP_AUTOMATION_DRAFTS_PER_USER` are removed, oldest first, so
   * that a client cannot fill Valkey.
   */
  private async keep(
    userId: Id<'usr'>,
    organizationId: Id<'org'>,
    draft: McpAutomationDraft,
  ): Promise<void> {
    const value = JSON.stringify({ ...draft, user_id: userId, organization_id: organizationId });
    const list = userDraftsKey(userId);
    await cacheCommand(this.cache, async (client) => {
      const results = await client
        .multi()
        .set(draftKey(draft.id), value, 'EX', MCP_AUTOMATION_DRAFT_TTL_SECONDS)
        .lpush(list, draft.id)
        .lrange(list, MCP_AUTOMATION_DRAFTS_PER_USER, -1)
        .ltrim(list, 0, MCP_AUTOMATION_DRAFTS_PER_USER - 1)
        .expire(list, MCP_AUTOMATION_DRAFT_TTL_SECONDS)
        .exec();
      const failed = results?.find(([error]) => error !== null)?.[0];
      if (results === null || failed !== undefined) {
        throw failed ?? new AppError('DEPENDENCY_UNAVAILABLE');
      }
      const dropped = (results[2]?.[1] ?? []) as string[];
      if (dropped.length > 0) await client.del(...dropped.map(draftKey));
    });
  }
}
