import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';

import { jsonb } from '../../db/json.js';
import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../../db/repository.js';

import type { Db } from '../../db/create-db.js';
import type { Page, PageRequest } from '../../db/page.js';
import type {
  AutomationDisabledReasonKind,
  AutomationRow,
  Database,
  JsonObject,
} from '../../db/schema.js';
import type { Id } from '@cellhive/contracts';

export interface InsertAutomationInput {
  readonly id: Id<'aut'>;
  readonly baseId: Id<'bse'>;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly definition: JsonObject;
  readonly triggerType: string;
  readonly triggerTableId: Id<'tbl'> | null;
  readonly createdBy: Id<'usr'>;
}

/**
 * A change of an automation. Every update bumps `version` and records
 * `updated_by`; `runAs` moves `run_as_user_id` and resets `run_as_since`.
 */
export interface UpdateAutomationInput {
  readonly updatedBy: Id<'usr'>;
  readonly name?: string;
  readonly description?: string;
  readonly enabled?: boolean;
  readonly disabledReason?: AutomationDisabledReasonKind | null;
  readonly definition?: JsonObject;
  readonly triggerType?: string;
  readonly triggerTableId?: Id<'tbl'> | null;
  readonly runAs?: Id<'usr'>;
}

/** Which automations of a base a list returns. */
export interface AutomationListFilter {
  /**
   * Only automations triggered on one of these tables (a manager who is
   * not base admin: the tables they `manage`). `undefined` = every one.
   */
  readonly triggerTableIds?: readonly Id<'tbl'>[];
  /** Only automations triggered on this table. */
  readonly tableId?: Id<'tbl'>;
}

/** An automation with the names the API shows. */
export interface AutomationListRow extends AutomationRow {
  readonly run_as_name: string;
  readonly created_by_name: string;
  readonly updated_by_name: string;
}

type Aliases = Database & { a: Database['meta.automations'] };

/** `trigger_type` of the automations attached to a button field (T517). */
const BUTTON_TRIGGER_TYPE = 'button.clicked';
/** `trigger_type` of the automations started by an incoming webhook (T604). */
const WEBHOOK_TRIGGER_TYPE = 'webhook.received';

/**
 * `meta.automations` (SPEC §5.10, §11; BACKLOG T502). Every query is
 * scoped by `organization_id`; soft-deleted automations are invisible to
 * every method. Permission checks belong to the callers.
 */
export class AutomationsRepository
  extends TenantRepository<'automations'>
  implements TenantRepositoryContract<AutomationsRepository>
{
  constructor(db: Db) {
    super(db, 'automations');
  }

  async insert(scope: OrgScope, input: InsertAutomationInput): Promise<AutomationRow> {
    return this.executor(scope)
      .insertInto('meta.automations')
      .values({
        id: input.id,
        organization_id: scope.organizationId,
        base_id: input.baseId,
        name: input.name,
        description: input.description,
        enabled: input.enabled,
        definition: input.definition,
        trigger_type: input.triggerType,
        trigger_table_id: input.triggerTableId,
        created_by: input.createdBy,
        updated_by: input.createdBy,
        run_as_user_id: input.createdBy,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** An automation that is not deleted, with names. */
  async get(scope: OrgScope, id: Id<'aut'>): Promise<AutomationListRow | undefined> {
    return this.selectListRows(scope).where('a.id', '=', id).executeTakeFirst();
  }

  /** An automation that is not deleted, locked `FOR UPDATE` until the transaction ends. */
  async lockForUpdate(scope: OrgScope, id: Id<'aut'>): Promise<AutomationRow | undefined> {
    if (scope.tx === undefined) throw new TypeError('lockForUpdate needs a transaction scope');
    return this.executor(scope)
      .selectFrom('meta.automations')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
  }

  /** Automations of a base that are not deleted, oldest first, with names. */
  async listPage(
    scope: OrgScope,
    baseId: Id<'bse'>,
    filter: AutomationListFilter,
    page: PageRequest,
  ): Promise<Page<AutomationListRow>> {
    if (filter.triggerTableIds?.length === 0) return { items: [], total: 0 };
    const where = (eb: ExpressionBuilder<Aliases, 'a'>) => {
      const conditions: Expression<SqlBool>[] = [
        eb('a.base_id', '=', baseId),
        eb('a.deleted_at', 'is', null),
      ];
      if (filter.triggerTableIds !== undefined) {
        conditions.push(eb('a.trigger_table_id', 'in', [...filter.triggerTableIds]));
      }
      if (filter.tableId !== undefined) {
        conditions.push(eb('a.trigger_table_id', '=', filter.tableId));
      }
      return eb.and(conditions);
    };
    const items = await this.selectListRows(scope)
      .where(where)
      .orderBy('a.created_at')
      .orderBy('a.id')
      .limit(page.limit)
      .offset(page.offset)
      .execute();
    const { n } = await this.executor(scope)
      .selectFrom('meta.automations as a')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('a.organization_id', '=', scope.organizationId)
      .where(where)
      .executeTakeFirstOrThrow();
    return { items, total: n };
  }

  /** Applies `patch` to an automation that is not deleted; bumps `version`. */
  async update(
    scope: OrgScope,
    id: Id<'aut'>,
    patch: UpdateAutomationInput,
  ): Promise<AutomationRow | undefined> {
    return this.executor(scope)
      .updateTable('meta.automations')
      .set((eb) => ({
        version: eb('version', '+', 1),
        updated_by: patch.updatedBy,
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        ...(patch.disabledReason === undefined ? {} : { disabled_reason: patch.disabledReason }),
        ...(patch.definition === undefined ? {} : { definition: jsonb(patch.definition) }),
        ...(patch.triggerType === undefined ? {} : { trigger_type: patch.triggerType }),
        ...(patch.triggerTableId === undefined ? {} : { trigger_table_id: patch.triggerTableId }),
        ...(patch.runAs === undefined
          ? {}
          : { run_as_user_id: patch.runAs, run_as_since: sql<Date>`now()` }),
      }))
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
  }

  /** Soft-deletes (and turns off) an automation; `undefined` when already gone. */
  async softDelete(
    scope: OrgScope,
    id: Id<'aut'>,
    deletedBy: Id<'usr'>,
  ): Promise<AutomationRow | undefined> {
    return this.executor(scope)
      .updateTable('meta.automations')
      .set((eb) => ({
        version: eb('version', '+', 1),
        updated_by: deletedBy,
        enabled: false,
        deleted_at: sql<Date>`now()`,
      }))
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Enabled automations whose trigger is `triggerType` on `tableId`
   * (`events.dispatch`, T503; index `automations_trigger_idx`), oldest
   * first. Read without lock: the dispatcher locks each one before it
   * creates a run.
   */
  async listEnabledForTrigger(
    scope: OrgScope,
    triggerType: string,
    tableId: Id<'tbl'>,
  ): Promise<AutomationRow[]> {
    return this.executor(scope)
      .selectFrom('meta.automations')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('trigger_table_id', '=', tableId)
      .where('trigger_type', '=', triggerType)
      .where('enabled', '=', true)
      .where('deleted_at', 'is', null)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  /**
   * Enabled automations whose trigger is `webhook.received` on `hookId`
   * (`events.dispatch`, T604), oldest first, read without lock like
   * {@link listEnabledForTrigger}. Few rows per organization: no index on
   * the JSON path.
   */
  async listEnabledForWebhook(scope: OrgScope, hookId: Id<'hok'>): Promise<AutomationRow[]> {
    return this.executor(scope)
      .selectFrom('meta.automations')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('trigger_type', '=', WEBHOOK_TRIGGER_TYPE)
      .where(sql<string>`definition -> 'trigger' ->> 'incoming_webhook_id'`, '=', hookId)
      .where('enabled', '=', true)
      .where('deleted_at', 'is', null)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  /**
   * An enabled automation that is not deleted, locked `FOR UPDATE` until
   * the transaction ends (T503: fan-out counters and the circuit breaker of
   * one automation are decided one event at a time); `undefined` when it
   * was turned off or deleted meanwhile.
   */
  async lockEnabled(scope: OrgScope, id: Id<'aut'>): Promise<AutomationRow | undefined> {
    if (scope.tx === undefined) throw new TypeError('lockEnabled needs a transaction scope');
    return this.executor(scope)
      .selectFrom('meta.automations')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('enabled', '=', true)
      .where('deleted_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
  }

  /**
   * Turns an automation off for a system reason (`circuit_breaker`,
   * `run_as_lost_access`): bumps `version`, keeps `updated_by` and
   * `run_as` (no person made the change). `undefined` when it was already
   * off or deleted.
   */
  async disableBySystem(
    scope: OrgScope,
    id: Id<'aut'>,
    reason: AutomationDisabledReasonKind,
  ): Promise<AutomationRow | undefined> {
    return this.executor(scope)
      .updateTable('meta.automations')
      .set((eb) => ({
        version: eb('version', '+', 1),
        enabled: false,
        disabled_reason: reason,
      }))
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('enabled', '=', true)
      .where('deleted_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * The automations (not deleted) attached to these button fields — trigger
   * `button.clicked` on the field (BACKLOG T517; index
   * `automations_button_field_key`: at most one per button). Read without
   * lock: cells and the save check; a click locks the one it runs.
   */
  async listForButtons(scope: OrgScope, fieldIds: readonly Id<'fld'>[]): Promise<AutomationRow[]> {
    if (fieldIds.length === 0) return [];
    return this.executor(scope)
      .selectFrom('meta.automations')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('trigger_type', '=', BUTTON_TRIGGER_TYPE)
      .where('deleted_at', 'is', null)
      .where(sql<string>`definition -> 'trigger' ->> 'field_id'`, 'in', [...fieldIds])
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  /**
   * Of `baseIds`, the bases with at least one enabled automation (BACKLOG
   * T507: only they need a `run_as` check after a permission change).
   */
  async baseIdsWithEnabled(scope: OrgScope, baseIds: readonly Id<'bse'>[]): Promise<Id<'bse'>[]> {
    if (baseIds.length === 0) return [];
    const rows = await this.executor(scope)
      .selectFrom('meta.automations')
      .select('base_id')
      .distinct()
      .where('organization_id', '=', scope.organizationId)
      .where('base_id', 'in', [...new Set(baseIds)])
      .where('enabled', '=', true)
      .where('deleted_at', 'is', null)
      .orderBy('base_id')
      .execute();
    return rows.map((row) => row.base_id);
  }

  /**
   * One page of enabled automations by id (BACKLOG T507 `run_as` check),
   * of one base or of the whole organization (`baseId = null`), after the
   * id `after` (keyset). Read without lock: whoever turns one off locks it.
   */
  async listEnabledPage(
    scope: OrgScope,
    input: {
      readonly baseId: Id<'bse'> | null;
      readonly after: Id<'aut'> | null;
      readonly limit: number;
    },
  ): Promise<AutomationRow[]> {
    let query = this.executor(scope)
      .selectFrom('meta.automations')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('enabled', '=', true)
      .where('deleted_at', 'is', null);
    if (input.baseId !== null) query = query.where('base_id', '=', input.baseId);
    if (input.after !== null) query = query.where('id', '>', input.after);
    return query.orderBy('id').limit(input.limit).execute();
  }

  /** The base of an automation that is not deleted (route scope). */
  async baseIdOf(scope: OrgScope, id: Id<'aut'>): Promise<Id<'bse'> | undefined> {
    const row = await this.executor(scope)
      .selectFrom('meta.automations')
      .select('base_id')
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row?.base_id;
  }

  private selectListRows(scope: OrgScope) {
    return this.executor(scope)
      .selectFrom('meta.automations as a')
      .innerJoin('meta.users as r', 'r.id', 'a.run_as_user_id')
      .innerJoin('meta.users as c', 'c.id', 'a.created_by')
      .innerJoin('meta.users as u', 'u.id', 'a.updated_by')
      .selectAll('a')
      .select([
        'r.display_name as run_as_name',
        'c.display_name as created_by_name',
        'u.display_name as updated_by_name',
      ])
      .where('a.organization_id', '=', scope.organizationId)
      .where('a.deleted_at', 'is', null);
  }
}
