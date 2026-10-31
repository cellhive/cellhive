import {
  DEFAULT_CURSOR_LIMIT,
  isId,
  MAX_CURSOR_LIMIT,
  RECORD_HISTORY_ACTIONS,
  type Id,
  type RecordHistoryAction,
} from '@cellhive/contracts';
import { isViewVisible, type TableAccess } from '@cellhive/permissions';
import { sql } from 'kysely';
import { z } from 'zod';

import { loadAiLockRule } from '../ai/generation/sources.js';
import { apiTokenViaPresenter, type AuditViewer } from '../audit/api-token-via.js';
import { AuditLogsRepository, type AuditLogRow } from '../audit/audit-logs.repository.js';
import { decodeCursor } from '../db/cursor.js';
import { isOrgScope, withTxScope, type OrgScope } from '../db/repository.js';
import { AppError } from '../errors/app-error.js';
import { zodIssuesToProblemErrors } from '../errors/zod-issues.js';
import { FieldConversionsRepository } from '../schema/field-conversions.repository.js';
import { FieldsRepository } from '../schema/fields.repository.js';

import { HistoryDefinitions } from './conversions/history.js';
import { LinkHistoryRefs, type HistoryRecordRef } from './links/link-history.js';
import { toLinkFieldModel, type LinkFieldModel } from './links/link-model.js';
import { MemberDirectoryRepository, type MemberDisplay } from './member-directory.repository.js';
import { readable, toFieldModel, type FieldModel } from './table-model.js';
import { toParentFieldModel, type ParentFieldModel } from './tree/parent-model.js';

import type { RecordMutationService } from './record-mutation.service.js';
import type { RecordQueryService } from './record-query.service.js';
import type { FieldKeyType, RecordAccessContext, RecordOutput } from './types.js';
import type { AuditContext, AuditVia } from '../audit/audit-entry.js';
import type { Db } from '../db/create-db.js';
import type { ActorType, FieldRow, JsonObject, JsonValue } from '../db/schema.js';
import type { SelectOptions } from '@cellhive/field-types';

/** An option, user or record that no longer exists (CONTRACTS §11.1). */
export interface DeletedRef {
  readonly id: string;
  readonly name: null;
  readonly deleted: true;
}

export interface RecordHistoryItem {
  readonly id: Id<'aud'>;
  readonly action: RecordHistoryAction;
  readonly created_at: string;
  readonly actor: {
    readonly type: ActorType;
    readonly id: string | null;
    readonly name: string | null;
  };
  /**
   * The stored `via`; through an API token also `api_token_name`, and the
   * token is named only to organization owners/admins and its owner
   * (`api_token_id: null` for others — S6 decision #19).
   */
  readonly via: HistoryVia | null;
  readonly batch: { readonly id: string; readonly size: number } | null;
  readonly changes: Record<string, { readonly from: unknown; readonly to: unknown }>;
}

/** `via` of a history entry (CONTRACTS §11.1). */
export type HistoryVia = Omit<AuditVia, 'api_token_id'> & {
  readonly api_token_id?: Id<'tok'> | null;
  readonly api_token_name?: string | null;
};

export interface RecordHistoryOutput {
  readonly items: RecordHistoryItem[];
  readonly next_cursor: string | null;
}

export interface RecordHistoryRequest {
  /** Default `name`: how `changes` and `field` name fields. */
  readonly field_key_type?: FieldKeyType;
  /** Only entries that changed this field (name or id per `field_key_type`). */
  readonly field?: string;
  readonly cursor?: string;
  /** Default 50, at most 200. */
  readonly limit?: number;
}

export interface RecordRevertRequest {
  readonly audit_id: string;
  readonly version?: number;
  /** Default `name`: keys of the returned record. */
  readonly field_key_type?: FieldKeyType;
}

const historySchema = z.object({
  field_key_type: z.enum(['name', 'id']).default('name'),
  field: z.string().min(1).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.int().min(1).max(MAX_CURSOR_LIMIT).default(DEFAULT_CURSOR_LIMIT),
});

const revertSchema = z.object({
  audit_id: z.string(),
  version: z.int().min(1).optional(),
  field_key_type: z.enum(['name', 'id']).default('name'),
});

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'The request is invalid.',
      errors: zodIssuesToProblemErrors(parsed.error.issues),
    });
  }
  return parsed.data;
}

const recordNotFound = () => new AppError('NOT_FOUND', { detail: 'The record does not exist.' });
const entryNotFound = () =>
  new AppError('NOT_FOUND', { detail: 'The history entry does not exist.' });

function objectOf(value: JsonValue | null): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

function isHistoryAction(action: string): action is RecordHistoryAction {
  return (RECORD_HISTORY_ACTIONS as readonly string[]).includes(action);
}

/** Field ids an entry changed (`before` ∪ `after` keys), in first-seen order. */
function changedKeys(row: AuditLogRow): string[] {
  const keys = new Set<string>();
  for (const side of [objectOf(row.before), objectOf(row.after)]) {
    if (side !== null) for (const key of Object.keys(side)) keys.add(key);
  }
  return [...keys];
}

function storedIds(value: JsonValue | undefined): string[] {
  if (typeof value === 'string') return [value];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

const deletedRef = (id: string): DeletedRef => ({ id, name: null, deleted: true });

/**
 * `actor.name` of an entry (CONTRACTS §11.1). A share link is named after
 * its target view/form, but only for readers who can see that view
 * (`visible_views`): a hidden view does not exist for them.
 */
function actorName(row: AuditLogRow, tableAccess: TableAccess | undefined): string | null {
  if (row.actor_type !== 'share_link') return row.actor_name;
  if (row.actor_view_id === null || tableAccess === undefined) return null;
  return isViewVisible(tableAccess, row.actor_view_id) ? row.actor_name : null;
}

/**
 * A storage-form value of `field` back in the json write shape (CONTRACTS
 * §2), for a revert through the normal write path: option ids, `{ id }`
 * users, the rest unchanged.
 */
export function storedToWriteValue(field: FieldModel, stored: JsonValue | undefined): unknown {
  switch (field.type) {
    case 'select': {
      const ids = storedIds(stored);
      if ((field.options as SelectOptions).multiple) return ids.length === 0 ? null : ids;
      return ids[0] ?? null;
    }
    case 'user': {
      const ids = storedIds(stored);
      return ids.length === 0 ? null : ids.map((id) => ({ id }));
    }
    case 'checkbox':
      return stored === true;
    default:
      return stored ?? null;
  }
}

/** A field as history shows it: a column field, a link (T465) or the `parent` field (T465). */
type HistoryField =
  | { readonly kind: 'column'; readonly field: FieldModel }
  | { readonly kind: 'link'; readonly field: LinkFieldModel }
  | { readonly kind: 'parent'; readonly field: ParentFieldModel };

/** Record refs of link and `parent` values, by linked table id then record id. */
type RecordRefs = ReadonlyMap<string, ReadonlyMap<string, HistoryRecordRef>>;

/** Result of a revert: the record (`undefined` when no longer readable) and dropped links. */
export interface RecordRevertOutput {
  readonly record: RecordOutput | undefined;
  /**
   * Linked records (link cells, `parent`) of the entry left out because
   * they were deleted since (in the trash or purged) — BACKLOG T465.
   */
  readonly skipped: number;
}

/**
 * Record history and value revert (ADR-23 §4, §6; CONTRACTS §11.1–11.2).
 *
 * History reads `meta.audit_logs` only; whether the caller may read the
 * record **now** is asked of `RecordQueryService`, and a revert is an
 * ordinary update through `RecordMutationService` (permissions, record
 * rules, `version`), audited with `via.reverted_from` (AGENTS.md rule 1).
 *
 * Values are rendered against the **current** meta: fields the caller
 * cannot read now, deleted fields and types the record services do not
 * support are left out; an entry whose every field is left out disappears.
 * Link and `parent` values (T465) are stored as record ids and rendered as
 * `{ id, title }` with the caller's current access (P20: `title: null`);
 * records deleted since read `{ id, title: null, deleted: true }`
 * (`links/link-history.ts`). Computed fields have no history (ADR-23 §2).
 */
export class RecordHistoryService {
  private readonly audit: AuditLogsRepository;
  private readonly fields: FieldsRepository;
  private readonly members: MemberDirectoryRepository;
  private readonly conversions: FieldConversionsRepository;
  private readonly recordRefs: LinkHistoryRefs;

  constructor(
    private readonly db: Db,
    private readonly query: RecordQueryService,
    private readonly mutation: RecordMutationService,
  ) {
    this.audit = new AuditLogsRepository(db);
    this.fields = new FieldsRepository(db);
    this.members = new MemberDirectoryRepository(db);
    this.conversions = new FieldConversionsRepository(db);
    this.recordRefs = new LinkHistoryRefs(db);
  }

  /**
   * `GET …/records/:recordId/history`: newest first, cursor pagination.
   * `viewer` decides whether API tokens are named (S6 decision #19);
   * required so that no caller under-shows tokens to admins by accident.
   */
  async history(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    recordId: string,
    access: RecordAccessContext,
    request: RecordHistoryRequest = {},
    viewer: AuditViewer,
  ): Promise<RecordHistoryOutput> {
    this.assertScope(scope);
    const input = parse(historySchema, request);
    const cursor = decodeCursor(input.cursor);
    await this.requireReadable(scope, tableId, recordId, access);
    const visible = await this.visibleFields(scope, tableId, access);
    const tableAccess = access.resolved.access.tables[tableId];
    const keyOf = (entry: HistoryField) =>
      input.field_key_type === 'id' ? entry.field.id : entry.field.name;

    let only: HistoryField | undefined;
    if (input.field !== undefined) {
      only = visible.find((entry) => keyOf(entry) === input.field);
      if (only === undefined) {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'The field does not exist.',
          errors: [{ path: 'field', code: 'UNKNOWN_FIELD', message: 'Field does not exist' }],
        });
      }
    }

    const page = await this.audit.listRecordHistory(
      scope,
      {
        tableId,
        recordId: recordId as Id<'rec'>,
        visibleFieldIds: visible.map((entry) => entry.field.id),
        ...(only === undefined ? {} : { fieldId: only.field.id }),
      },
      { cursor, limit: input.limit },
    );

    const byId = new Map(visible.map((entry) => [entry.field.id as string, entry]));
    const shown = only === undefined ? byId : new Map([[only.field.id, only]]);
    const columns = new Map<string, FieldModel>();
    for (const [id, entry] of shown) if (entry.kind === 'column') columns.set(id, entry.field);
    const batchIds = page.items.flatMap((row) => (row.batch_id === null ? [] : [row.batch_id]));
    const sizes = await this.audit.countRecordBatches(scope, batchIds);
    // T403: entries older than a type conversion render with the definition of then.
    const definitions = await HistoryDefinitions.load(
      this.conversions,
      scope,
      [...columns.values()].map((field) => field.id),
    );
    const users = await this.usersIn(scope, page.items, columns, definitions);
    const refs = await this.refsOf(scope, tableId, access, page.items, shown, ['before', 'after']);
    const viaOf = await apiTokenViaPresenter(this.db, scope, page.items, viewer);

    const items: RecordHistoryItem[] = [];
    for (const row of page.items) {
      if (!isHistoryAction(row.action)) continue;
      const before = objectOf(row.before);
      const after = objectOf(row.after);
      const changes: RecordHistoryItem['changes'] = {};
      const keys = changedKeys(row);
      for (const key of keys) {
        const entry = shown.get(key);
        if (entry === undefined) continue;
        if (entry.kind === 'column') {
          const then = definitions.at(entry.field, row.created_at);
          changes[keyOf(entry)] = {
            from: this.render(then, before?.[key], users),
            to: this.render(then, after?.[key], users),
          };
        } else {
          const targets = refs.get(targetTableOf(entry, tableId));
          changes[keyOf(entry)] = {
            from: renderRecords(entry, before?.[key], targets),
            to: renderRecords(entry, after?.[key], targets),
          };
        }
      }
      // Belt and braces: the SQL filter already drops entries that only
      // changed fields the viewer cannot read now.
      if (keys.length > 0 && Object.keys(changes).length === 0) continue;
      const size = row.batch_id === null ? 0 : (sizes.get(row.batch_id) ?? 0);
      items.push({
        id: row.id,
        action: row.action,
        created_at: row.created_at.toISOString(),
        actor: { type: row.actor_type, id: row.actor_id, name: actorName(row, tableAccess) },
        via: viaOf(row),
        batch: row.batch_id !== null && size > 1 ? { id: row.batch_id, size } : null,
        changes,
      });
    }
    return { items, next_cursor: page.nextCursor };
  }

  /**
   * `POST …/records/:recordId/revert`: sets the fields of the entry the
   * caller can read now back to their `before` value, as a new update.
   * An entry of another record or table (or organization), a record the
   * caller cannot read and an entry without readable fields are all `404`.
   *
   * Link and `parent` cells (T465) are written back as record ids through
   * the normal write path: links kept from the current cell stay even when
   * the caller cannot read them, a record linked again must be linkable by
   * the caller (`422 LINK_TARGET_NOT_FOUND` otherwise, like any write);
   * records the caller sees as deleted are left out and counted in
   * `skipped` (a deleted parent leaves the parent as it is). When nothing
   * is left to write, the record is returned unchanged.
   */
  async revert(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    recordId: string,
    access: RecordAccessContext,
    request: RecordRevertRequest,
    context: AuditContext,
  ): Promise<RecordRevertOutput> {
    this.assertScope(scope);
    const input = parse(revertSchema, request);
    await this.requireReadable(scope, tableId, recordId, access);
    if (!isId('aud', input.audit_id)) throw entryNotFound();
    const entry = await this.audit.getById(scope, input.audit_id);
    if (
      entry?.entity_type !== 'record' ||
      entry.entity_id !== recordId ||
      entry.table_id !== tableId ||
      !isHistoryAction(entry.action)
    ) {
      throw entryNotFound();
    }
    const visible = new Map(
      (await this.visibleFields(scope, tableId, access)).map((field) => [
        field.field.id as string,
        field,
      ]),
    );
    const readableKeys = changedKeys(entry).filter((key) => visible.has(key));
    // Hidden fields are treated as absent (CONTRACTS §11.2): nothing left is `404`.
    if (readableKeys.length === 0) throw entryNotFound();

    const refs = await this.refsOf(scope, tableId, access, [entry], visible, ['before']);
    const before = objectOf(entry.before);
    const fields: Record<string, unknown> = {};
    let skipped = 0;
    for (const key of readableKeys) {
      const field = visible.get(key);
      if (field === undefined) continue;
      const name = input.field_key_type === 'id' ? field.field.id : field.field.name;
      if (field.kind === 'column') {
        fields[name] = storedToWriteValue(field.field, before?.[key]);
        continue;
      }
      const targets = refs.get(targetTableOf(field, tableId));
      const ids = storedIds(before?.[key]);
      const kept = ids.filter((id) => targets?.get(id)?.deleted !== true);
      skipped += ids.length - kept.length;
      if (field.kind === 'link') {
        fields[name] = kept.length === 0 ? null : kept;
      } else if (ids.length === 0 || kept.length > 0) {
        // A deleted parent is not written back: the record keeps its parent.
        fields[name] = kept[0] ?? null;
      }
    }

    if (Object.keys(fields).length === 0) {
      // Every value named deleted records: nothing to write.
      const [record] = await this.query.getRecords(scope, tableId, [recordId], access, {
        field_key_type: input.field_key_type,
      });
      return { record, skipped };
    }

    const result = await this.mutation.update(
      scope,
      tableId,
      access,
      {
        field_key_type: input.field_key_type,
        typecast: false,
        records: [
          {
            id: recordId,
            ...(input.version === undefined ? {} : { version: input.version }),
            fields,
          },
        ],
      },
      { ...context, via: { ...(context.via ?? {}), reverted_from: entry.id } },
    );
    return { record: result.records[0], skipped };
  }

  // -------------------------------------------------------------------------

  private assertScope(scope: OrgScope): void {
    if (!isOrgScope(scope) || scope.tx !== undefined) {
      throw new TypeError(
        'RecordHistoryService: an OrgScope from orgScope() without tx is required',
      );
    }
  }

  /** The record is live and in the caller's read scope now (ADR-23 §4), else `404`. */
  private async requireReadable(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    recordId: string,
    access: RecordAccessContext,
  ): Promise<void> {
    if (!isId('rec', recordId)) throw recordNotFound();
    const found = await this.query.getRecords(scope, tableId, [recordId], access, {
      field_key_type: 'id',
      fields: [],
    });
    if (found.length === 0) throw recordNotFound();
  }

  /**
   * Active fields the caller can read now, in display order: column fields
   * the record services support, link fields and the `parent` field.
   */
  private async visibleFields(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
  ): Promise<HistoryField[]> {
    const tableAccess: TableAccess | undefined = access.resolved.access.tables[tableId];
    if (tableAccess === undefined) throw recordNotFound();
    const rows: FieldRow[] = await this.fields.listByTable(scope, tableId);
    const locks = await loadAiLockRule(this.db, scope, access.baseId, rows);
    return (
      rows
        .flatMap((row): HistoryField[] => {
          const column = toFieldModel(row);
          if (column !== null) return [{ kind: 'column', field: column }];
          const link = toLinkFieldModel(row);
          if (link !== null) return [{ kind: 'link', field: link }];
          const parent = toParentFieldModel(row);
          return parent === null ? [] : [{ kind: 'parent', field: parent }];
        })
        .filter((entry) => readable(tableAccess, entry.field.id))
        // AI fields (T910) are always strict: not shown to a reader missing a field of the prompt.
        .filter(
          (entry) =>
            entry.kind !== 'column' || !locks(entry.field.row, (id) => readable(tableAccess, id)),
        )
    );
  }

  /**
   * Refs of the records named by the link and `parent` values of `rows`
   * (the given sides), one statement per linked table, in a read-only
   * transaction; empty when no such value is shown.
   */
  private async refsOf(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
    rows: readonly AuditLogRow[],
    shown: ReadonlyMap<string, HistoryField>,
    sides: readonly ('before' | 'after')[],
  ): Promise<RecordRefs> {
    const wanted = new Map<Id<'tbl'>, Set<string>>();
    for (const row of rows) {
      for (const side of sides) {
        const values = objectOf(row[side]);
        if (values === null) continue;
        for (const [key, value] of Object.entries(values)) {
          const entry = shown.get(key);
          if (entry === undefined || entry.kind === 'column') continue;
          const ids = storedIds(value);
          if (ids.length === 0) continue;
          const target = targetTableOf(entry, tableId);
          const set = wanted.get(target) ?? new Set<string>();
          for (const id of ids) set.add(id);
          wanted.set(target, set);
        }
      }
    }
    const refs = new Map<string, Map<string, HistoryRecordRef>>();
    if (wanted.size === 0) return refs;
    const locale = { locale: access.locale, timeZone: access.timeZone };
    const context = {
      userId: access.userId,
      groupMemberUserIds: access.groupMemberUserIds,
      timeZone: access.timeZone,
      now: new Date(),
    };
    await this.db.withTx(async (tx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(tx);
      const txScope = withTxScope(scope, tx);
      for (const [target, ids] of wanted) {
        refs.set(
          target,
          await this.recordRefs.resolve(txScope, target, access, [...ids], locale, context),
        );
      }
    });
    return refs;
  }

  /** Members referenced by the user cells of the shown fields (org members only). */
  private async usersIn(
    scope: OrgScope,
    rows: readonly AuditLogRow[],
    shown: ReadonlyMap<string, FieldModel>,
    definitions: HistoryDefinitions,
  ): Promise<Map<string, MemberDisplay>> {
    const ids = new Set<string>();
    for (const row of rows) {
      for (const side of [objectOf(row.before), objectOf(row.after)]) {
        if (side === null) continue;
        for (const [key, value] of Object.entries(side)) {
          const field = shown.get(key);
          if (field !== undefined && definitions.hadType(field, 'user')) {
            for (const id of storedIds(value)) ids.add(id);
          }
        }
      }
    }
    const members = await this.members.findMembers(scope, [...ids]);
    return new Map(members.map((member) => [member.id as string, member]));
  }

  /**
   * One storage-form value as `cell_format=json` against the current meta;
   * options and users that no longer exist read `{ id, name: null, deleted: true }`.
   */
  private render(
    field: FieldModel,
    stored: JsonValue | undefined,
    users: ReadonlyMap<string, MemberDisplay>,
  ): unknown {
    const value = stored ?? null;
    switch (field.type) {
      case 'select': {
        const options = field.options as SelectOptions;
        const items = storedIds(value).map((id) => {
          const option = options.options.find((candidate) => candidate.id === id);
          return option === undefined ? deletedRef(id) : option.name;
        });
        if (options.multiple) return items.length === 0 ? null : items;
        return items[0] ?? null;
      }
      case 'user': {
        const items = storedIds(value).map((id) => users.get(id) ?? deletedRef(id));
        return items.length === 0 ? null : items;
      }
      default:
        return field.definition.fromStorage(value, field.options, {});
    }
  }
}

/** The table whose records a link (its linked table) or `parent` (the table itself) names. */
function targetTableOf(
  entry: Exclude<HistoryField, { kind: 'column' }>,
  tableId: Id<'tbl'>,
): Id<'tbl'> {
  return entry.kind === 'link' ? entry.field.targetTableId : tableId;
}

/**
 * A stored link (`["rec_…"]`) or `parent` (`"rec_…"`) value as the json
 * read shape (CONTRACTS §2): `[{ id, title }]` / `{ id, title }`, `null`
 * when empty; `deleted: true` on records deleted since (T465).
 */
function renderRecords(
  entry: Exclude<HistoryField, { kind: 'column' }>,
  stored: JsonValue | undefined,
  refs: ReadonlyMap<string, HistoryRecordRef> | undefined,
): HistoryRecordRef[] | HistoryRecordRef | null {
  const items = storedIds(stored).map((id) => refs?.get(id) ?? { id, title: null });
  if (entry.kind === 'parent') return items[0] ?? null;
  return items.length === 0 ? null : items;
}
