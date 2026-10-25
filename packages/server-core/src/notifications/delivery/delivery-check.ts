import {
  IMPORT_JOB_TYPE,
  isMandatoryNotificationType,
  NOTIFICATION_DATA_SCHEMAS,
  NOTIFICATION_DEFAULTS,
  type Id,
  type NotificationType,
} from '@cellhive/contracts';

import { canSeeAutomation } from '../../automation/permissions/manage.js';
import { AutomationRunsRepository } from '../../automation/repository/automation-runs.repository.js';
import { AutomationsRepository } from '../../automation/repository/automations.repository.js';
import { orgScope, type OrgScope } from '../../db/repository.js';
import {
  loadMemberAccessBase,
  resolveMemberBaseAccess,
  type AccessDefaults,
  type MemberBaseAccess,
} from '../../import/member-access.js';
import { JobsRepository } from '../../jobs/jobs.repository.js';
import { FieldsRepository } from '../../schema/fields.repository.js';
import { reminderOf } from '../../schema/reminders.js';
import { TablesRepository } from '../../schema/tables.repository.js';
import { batchOverflowSkipped } from '../batch-overflow.js';
import {
  NotificationBaseMutesRepository,
  NotificationPreferencesRepository,
} from '../notification-preferences.repository.js';
import { readableRecordTitles } from '../record-titles.js';

import { preferenceOf } from './recipient.js';

import type { EmailDeliverySkipCode } from './email-outbox.repository.js';
import type { PendingDelivery } from './notification-outbox.repository.js';
import type { Db } from '../../db/create-db.js';
import type { User } from '../../db/schema.js';
import type { NotificationEmailItem } from '../../mail/templates/notification-email.js';
import type { AssignedRecordLine } from '../../mail/templates/notification-items/index.js';
import type { RecordQueryService } from '../../records/record-query.service.js';
import type { NotificationDeliveryChannel } from '../notifications.repository.js';

/**
 * Why a queued delivery is left out when it is checked at send time — the
 * reasons shared by every channel (CONTRACTS §22.4). Channels add their own
 * (email: `smtp_not_configured`, `email_off`; Telegram:
 * `telegram_not_configured`, `channel_error`).
 */
export type DeliveryCheckSkipCode = Extract<
  EmailDeliverySkipCode,
  | 'preference_off'
  | 'muted'
  | 'cannot_read_base'
  | 'cannot_read_record'
  | 'cannot_read_field'
  | 'unsupported_type'
>;

/** A pending delivery the recipient may still receive, as the templates show it. */
export interface CheckedDelivery {
  readonly row: PendingDelivery;
  /** Channel-neutral view of the notification (the email and Telegram templates render it). */
  readonly item: NotificationEmailItem;
}

export interface DeliveryCheckResult {
  readonly kept: CheckedDelivery[];
  readonly dropped: Map<DeliveryCheckSkipCode, PendingDelivery[]>;
}

export interface NotificationDeliveryCheckerOptions {
  /** `PUBLIC_URL`: links of the items. */
  readonly publicUrl: string;
  readonly defaults: AccessDefaults;
  readonly now?: () => Date;
}

/** A base the recipient opens: their access and its name. */
interface BaseView {
  readonly access: MemberBaseAccess;
  readonly name: string;
}

/**
 * The send-time check of queued notification deliveries (ADR-29 §1, BACKLOG
 * T512 for email, T550 for Telegram — one implementation for both): for
 * one recipient whose membership was already checked, applies **now**
 * their preference of the channel and their base mutes (a mandatory type is
 * never muted), and their current access — reads the base, the table, the
 * record (primary field only, when readable; through `RecordQueryService`),
 * the fields the type is about — and builds what the templates show:
 * names of what the recipient may see, links to `PUBLIC_URL`. Anything
 * else is dropped with its reason, without a trace in the message.
 */
export class NotificationDeliveryChecker {
  readonly #now: () => Date;

  constructor(
    private readonly db: Db,
    private readonly query: RecordQueryService,
    private readonly options: NotificationDeliveryCheckerOptions,
  ) {
    this.#now = options.now ?? (() => new Date());
  }

  async check(
    txScope: OrgScope,
    user: User,
    rows: readonly PendingDelivery[],
    channel: NotificationDeliveryChannel,
  ): Promise<DeliveryCheckResult> {
    // Access is read outside the outbox transaction (plain reads).
    const scope = orgScope(txScope.organizationId);
    const dropped = new Map<DeliveryCheckSkipCode, PendingDelivery[]>();
    const drop = (code: DeliveryCheckSkipCode, row: PendingDelivery) => {
      dropped.set(code, [...(dropped.get(code) ?? []), row]);
    };
    const [preferences, mutedBases] = await Promise.all([
      new NotificationPreferencesRepository(this.db).listForUsers(scope, [user.id]),
      new NotificationBaseMutesRepository(this.db).listBaseIds(scope, user.id),
    ]);
    const muted = new Set(mutedBases);

    // Current access per base (resolved like a request of the recipient).
    const access = new Map<Id<'bse'>, BaseView | undefined>();
    const accessOf = async (baseId: Id<'bse'>): Promise<BaseView | undefined> => {
      if (!access.has(baseId)) {
        const loaded = await loadMemberAccessBase(this.db, scope, baseId);
        const resolved =
          loaded === undefined
            ? undefined
            : await resolveMemberBaseAccess(
                this.db,
                scope,
                { userId: user.id, baseId },
                this.options.defaults,
                loaded,
              );
        access.set(
          baseId,
          loaded === undefined || resolved === undefined
            ? undefined
            : { access: resolved, name: loaded.base.name },
        );
      }
      return access.get(baseId);
    };

    const candidates: { row: PendingDelivery; base: BaseView | undefined }[] = [];
    for (const row of rows) {
      const type = row.type;
      const schema = (
        NOTIFICATION_DATA_SCHEMAS as Partial<
          Record<NotificationType, { safeParse(v: unknown): { success: boolean } }>
        >
      )[type];
      if (schema === undefined || !schema.safeParse(row.payload).success) {
        drop('unsupported_type', row);
        continue;
      }
      const on = preferenceOf(preferences, type, channel) ?? NOTIFICATION_DEFAULTS[type][channel];
      if (!on) {
        drop('preference_off', row);
        continue;
      }
      if (row.base_id !== null && muted.has(row.base_id) && !isMandatoryNotificationType(type)) {
        drop('muted', row);
        continue;
      }
      if (row.base_id === null) {
        candidates.push({ row, base: undefined });
        continue;
      }
      const base = await accessOf(row.base_id);
      if (base === undefined) {
        drop('cannot_read_base', row);
        continue;
      }
      if (
        row.table_id !== null &&
        base.access.record.resolved.access.tables[row.table_id] === undefined
      ) {
        drop('cannot_read_record', row);
        continue;
      }
      candidates.push({ row, base });
    }

    // Records: one read per table, with the recipient's current access.
    const titles = new Map<string, Map<string, string | null>>();
    const byTable = new Map<Id<'tbl'>, { base: MemberBaseAccess; ids: Set<string> }>();
    for (const { row, base } of candidates) {
      if (row.entity_type !== 'record' || row.table_id === null || base === undefined) continue;
      const group = byTable.get(row.table_id) ?? { base: base.access, ids: new Set<string>() };
      group.ids.add(row.entity_id);
      byTable.set(row.table_id, group);
    }
    for (const [tableId, group] of byTable) {
      titles.set(
        tableId,
        await readableRecordTitles(this.db, this.query, scope, group.base.record, tableId, [
          ...group.ids,
        ]),
      );
    }

    // Automations: their name when the recipient may see them (CONTRACTS §21).
    const automations = new AutomationsRepository(this.db);
    const automationNames = new Map<string, string | null>();
    const automationName = async (id: string, view: BaseView | undefined) => {
      if (view === undefined) return null;
      const base = view.access;
      const key = `${base.record.baseId}|${id}`;
      if (!automationNames.has(key)) {
        const automation = await automations.get(scope, id as Id<'aut'>);
        automationNames.set(
          key,
          automation !== undefined &&
            automation.base_id === base.record.baseId &&
            canSeeAutomation(base.record.resolved.access, automation.trigger_table_id)
            ? automation.name
            : null,
        );
      }
      return automationNames.get(key) ?? null;
    };

    // S5b (T542): names of tables and fields the recipient reads, runs of
    // `batch_overflow`, the records of a grouped `record.assigned`.
    const tables = new TablesRepository(this.db);
    const tableNames = new Map<Id<'tbl'>, string | null>();
    const tableName = async (tableId: Id<'tbl'> | null, view: BaseView | undefined) => {
      if (tableId === null || view === undefined) return null;
      if (view.access.record.resolved.access.tables[tableId] === undefined) return null;
      if (!tableNames.has(tableId)) {
        const table = await tables.getById(scope, tableId);
        tableNames.set(tableId, table?.base_id === view.access.record.baseId ? table.name : null);
      }
      return tableNames.get(tableId) ?? null;
    };
    const fields = new FieldsRepository(this.db);
    const fieldName = async (
      tableId: Id<'tbl'> | null,
      fieldId: Id<'fld'>,
      view: BaseView | undefined,
    ): Promise<string | null> => {
      if (tableId === null || view === undefined) return null;
      if (view.access.record.resolved.access.tables[tableId]?.fields[fieldId] === undefined) {
        return null;
      }
      const field = await fields.getById(scope, fieldId);
      return field?.table_id === tableId ? field.name : null;
    };
    // `date.reminder` to `field_user` (QA T559 H3): the recipient field too, as
    // the date field's reminder names it now (`data` carries the date field only).
    const recipientFields = new Map<Id<'fld'>, Id<'fld'> | null>();
    const reminderRecipientField = async (fieldId: Id<'fld'>): Promise<Id<'fld'> | null> => {
      if (!recipientFields.has(fieldId)) {
        const field = await fields.getById(scope, fieldId);
        const reminder = field === undefined ? null : reminderOf(field);
        recipientFields.set(
          fieldId,
          reminder?.recipients === 'field_user' ? reminder.user_field_id : null,
        );
      }
      return recipientFields.get(fieldId) ?? null;
    };
    const runs = new AutomationRunsRepository(this.db);
    // `import.finished` (T548): the report of the failed rows, with today's
    // download rule (CONTRACTS §19: only who ran the import, until it expires).
    const jobs = new JobsRepository(this.db);
    const root = this.options.publicUrl.replace(/\/+$/, '');
    const importReportUrl = async (jobId: string): Promise<string | null> => {
      const job = await jobs.getById(scope, jobId as Id<'job'>);
      if (job?.type !== IMPORT_JOB_TYPE || job.status !== 'succeeded') return null;
      if (job.created_by !== user.id) return null;
      const result = job.result as Record<string, unknown> | null;
      const path = result?.download_url;
      const expiresAt = result?.expires_at;
      if (typeof path !== 'string' || !path.startsWith('/') || typeof expiresAt !== 'string') {
        return null;
      }
      return Date.parse(expiresAt) > this.#now().getTime() ? `${root}${path}` : null;
    };

    const kept: CheckedDelivery[] = [];
    for (const { row, base } of candidates) {
      let recordTitle: string | null = null;
      if (row.entity_type === 'record' && row.table_id !== null) {
        const found = titles.get(row.table_id);
        if (found === undefined || !found.has(row.entity_id)) {
          drop('cannot_read_record', row);
          continue;
        }
        recordTitle = found.get(row.entity_id) ?? null;
      }
      const data = row.payload as Record<string, unknown>;
      const automationId = typeof data.automation_id === 'string' ? data.automation_id : null;
      const name = automationId === null ? null : await automationName(automationId, base);
      const common = {
        createdAt: row.created_at,
        baseName: base?.name ?? null,
        automationName: name,
        recordTitle,
        url: this.urlOf(row, name !== null),
      };
      switch (row.type) {
        case 'automation.disabled':
          kept.push({
            row,
            item: {
              ...common,
              type: 'automation.disabled',
              reason:
                data.reason === 'run_as_lost_access' ? 'run_as_lost_access' : 'circuit_breaker',
            },
          });
          break;
        case 'automation.batch_overflow':
          kept.push({
            row,
            item: {
              ...common,
              type: 'automation.batch_overflow',
              limit: Number(data.limit),
              // QA S5 L6: read now, only for a recipient who sees the automation.
              skipped:
                name === null || automationId === null
                  ? null
                  : await batchOverflowSkipped(runs, scope, row.payload, automationId),
            },
          });
          break;
        case 'automation.message':
          kept.push({
            row,
            item: {
              ...common,
              type: 'automation.message',
              title: String(data.title),
              body: typeof data.body === 'string' ? data.body : '',
            },
          });
          break;
        case 'record.assigned': {
          const recordIds = (data.record_ids as string[] | undefined) ?? [];
          const count = Number(data.count);
          // Still reads one of the `user` fields they were added to (QA T559:
          // like `record.followed_changed`; lost since the fan-out → dropped).
          const assigning = (data.field_ids as Id<'fld'>[] | undefined) ?? [];
          const assignTable =
            row.table_id === null
              ? undefined
              : base?.access.record.resolved.access.tables[row.table_id];
          if (!assigning.some((fieldId) => assignTable?.fields[fieldId] !== undefined)) {
            drop('cannot_read_field', row);
            continue;
          }
          let records: AssignedRecordLine[] = [];
          if (row.entity_type !== 'record') {
            // Grouped: the records the recipient still reads, primary field + link.
            const tableId = row.table_id;
            if (tableId === null || base === undefined) {
              drop('cannot_read_record', row);
              continue;
            }
            const readable = await readableRecordTitles(
              this.db,
              this.query,
              scope,
              base.access.record,
              tableId,
              recordIds,
            );
            if (readable.size === 0) {
              drop('cannot_read_record', row);
              continue;
            }
            records = recordIds
              .filter((id) => readable.has(id))
              .map((id) => ({
                title: readable.get(id) ?? null,
                url: this.recordUrl(row.base_id, tableId, id),
              }));
          }
          kept.push({
            row,
            item: {
              ...common,
              type: 'record.assigned',
              count,
              tableName: await tableName(row.table_id, base),
              records,
              ...(isWebhookSourced(data) ? { viaWebhook: true } : {}),
            },
          });
          break;
        }
        case 'record.followed_changed': {
          const changed = (data.field_ids as Id<'fld'>[] | undefined) ?? [];
          const table =
            row.table_id === null
              ? undefined
              : base?.access.record.resolved.access.tables[row.table_id];
          if (!changed.some((fieldId) => table?.fields[fieldId] !== undefined)) {
            drop('cannot_read_field', row);
            continue;
          }
          if (row.entity_type !== 'record') {
            // From a webhook (T608): the records the recipient still reads.
            const tableId = row.table_id;
            if (tableId === null || base === undefined) {
              drop('cannot_read_record', row);
              continue;
            }
            const recordIds = (data.record_ids as string[] | undefined) ?? [];
            const readable = await readableRecordTitles(
              this.db,
              this.query,
              scope,
              base.access.record,
              tableId,
              recordIds,
            );
            if (readable.size === 0) {
              drop('cannot_read_record', row);
              continue;
            }
            kept.push({
              row,
              item: {
                ...common,
                type: 'record.followed_changed',
                changeCount: Number(data.change_count),
                viaWebhook: true,
                recordCount: Number(data.record_count ?? recordIds.length),
                records: recordIds
                  .filter((id) => readable.has(id))
                  .map((id) => ({
                    title: readable.get(id) ?? null,
                    url: this.recordUrl(row.base_id, tableId, id),
                  })),
              },
            });
            break;
          }
          kept.push({
            row,
            item: {
              ...common,
              type: 'record.followed_changed',
              changeCount: Number(data.change_count),
            },
          });
          break;
        }
        case 'date.reminder': {
          const dateFieldId = data.field_id as Id<'fld'>;
          const field = await fieldName(row.table_id, dateFieldId, base);
          const recipientField = field === null ? null : await reminderRecipientField(dateFieldId);
          const reminderTable =
            row.table_id === null
              ? undefined
              : base?.access.record.resolved.access.tables[row.table_id];
          if (
            field === null ||
            (recipientField !== null && reminderTable?.fields[recipientField] === undefined)
          ) {
            drop('cannot_read_field', row);
            continue;
          }
          kept.push({
            row,
            item: { ...common, type: 'date.reminder', fieldName: field, value: String(data.value) },
          });
          break;
        }
        case 'import.finished':
          kept.push({
            row,
            item: {
              ...common,
              type: 'import.finished',
              status: data.status as 'succeeded' | 'failed' | 'cancelled',
              tableName: await tableName(row.table_id, base),
              created: Number(data.created),
              updated: Number(data.updated),
              failedRows: Number(data.failed_rows),
              reportUrl: await importReportUrl(String(data.job_id)),
            },
          });
          break;
        default:
          drop('unsupported_type', row);
      }
    }
    return { kept, dropped };
  }

  /**
   * Where an item opens: the record, the table (`table`/`job` items with a
   * table — T542), the automation (when visible) or the base.
   */
  private urlOf(row: PendingDelivery, automationVisible: boolean): string | null {
    const root = this.options.publicUrl.replace(/\/+$/, '');
    if (row.base_id === null) return null;
    const base = `${root}/b/${encodeURIComponent(row.base_id)}`;
    if (row.entity_type === 'record' && row.table_id !== null) {
      return this.recordUrl(row.base_id, row.table_id, row.entity_id);
    }
    if ((row.entity_type === 'table' || row.entity_type === 'job') && row.table_id !== null) {
      return `${base}/t/${encodeURIComponent(row.table_id)}`;
    }
    if (row.entity_type === 'automation' && automationVisible) {
      return `${base}/automations/${encodeURIComponent(row.entity_id)}`;
    }
    return base;
  }

  /** `PUBLIC_URL/b/<base>/t/<table>?record=<rec>`. */
  private recordUrl(baseId: Id<'bse'> | null, tableId: Id<'tbl'>, recordId: string): string | null {
    if (baseId === null) return null;
    const root = this.options.publicUrl.replace(/\/+$/, '');
    return `${root}/b/${encodeURIComponent(baseId)}/t/${encodeURIComponent(tableId)}?record=${encodeURIComponent(recordId)}`;
  }
}

/** `data.source` of a notification gathered from an incoming webhook's writes (T608). */
function isWebhookSourced(data: Record<string, unknown>): boolean {
  const source = data.source;
  return typeof source === 'object' && source !== null && 'incoming_webhook_id' in source;
}
