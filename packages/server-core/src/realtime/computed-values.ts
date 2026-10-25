import { isId, type Id } from '@cellhive/contracts';
import { isValidTimeZone, type LocaleContext, type UserRef } from '@cellhive/field-types';
import { sql } from 'kysely';

import { analysisOfField } from '../computed/definition/compute-model.js';
import { isComputedRow, publicResultType } from '../computed/definition/definition.js';
import {
  formulaTypeOf,
  loadBaseSchemaRows,
  type BaseSchemaRows,
} from '../computed/definition/schema-rows.js';
import { afterCommit, type Db, type Tx } from '../db/create-db.js';
import { BasesRepository } from '../db/repositories/bases.repository.js';
import { OrganizationsRepository } from '../db/repositories/organizations.repository.js';
import { orgScope, type OrgScope } from '../db/repository.js';
import {
  computedCellValue,
  type ComputedCellData,
  type ComputedCellField,
} from '../records/computed/read/cells.js';
import { computedFilterResultOf } from '../records/computed/read/computed-fields.js';
import {
  computedReferences,
  strictComputedPermissionsOf,
} from '../records/computed/read/references.js';
import { LinkImageReader, type LinkImageCells } from '../records/links/link-images.js';
import { toLinkFieldModel, type LinkFieldModel } from '../records/links/link-model.js';
import { titleOf, titleUserIds } from '../records/links/link-reader.js';
import { dataTableRef } from '../records/links/link-targets.js';
import { MemberDirectoryRepository } from '../records/member-directory.repository.js';
import { RecordRuleFields } from '../records/rule-fields.js';
import { storedValueToJson } from '../records/storage-values.js';
import { toFieldModel, type FieldModel } from '../records/table-model.js';
import { FieldsRepository } from '../schema/fields.repository.js';
import { assertFieldColumnName } from '../schema/names.js';
import { TablesRepository } from '../schema/tables.repository.js';

import { realtimePublisherOf } from './bus.js';
import { RealtimeRecordChangePublisher } from './publishers.js';

import type { ComputedFieldMeta } from './envelope.js';
import type { ComputedRecomputeHooks, RecomputedValues } from '../computed/recompute/changes.js';
import type { FieldRow, JsonValue, TableRow } from '../db/schema.js';
import type {
  RecordChange,
  RecordChangeField,
  RecordChangeLink,
  StoredImage,
} from '../records/record-change-publisher.js';
import type { FormulaAnalysis } from '@cellhive/formula-engine';

/**
 * Realtime of computed values (BACKLOG T459, CONTRACTS §7, SPEC §15).
 *
 * - {@link RealtimeComputedHooks}: the `afterRecompute` hook of
 *   `ComputedRecomputeService` (T458). Each call is one write: the records
 *   whose stored formula/lookup values changed get a `record.updated` with
 *   `event_id: null` and their `version` unchanged, published after commit
 *   (nothing on rollback) and after the write that caused them
 *   (`afterCommit(…, { last: true })`). Images carry the record rule and
 *   view filter fields (the recomputed values before/after included), so
 *   records enter and leave views; values are `cell_format=json`, record
 *   titles under the link title rule (`links`). Envelope field meta carries
 *   what each computed field reads, for the per-subscriber `locked` / scoped
 *   decisions of the api (`RecordDeliveryStrategy`).
 * - {@link ComputedImages}: formula/lookup fields named by record rules or
 *   saved view filters in the images of every other record change (ADR-31),
 *   with the value before this transaction's recompute.
 */

/** Old values of cells recomputed in a transaction: table → field → record → `to_jsonb`. */
type Journal = Map<string, Map<string, Map<string, unknown>>>;
const journals = new WeakMap<Tx, Journal>();

function journalOf(tx: Tx): Journal {
  let journal = journals.get(tx);
  if (journal === undefined) {
    journal = new Map();
    journals.set(tx, journal);
  }
  return journal;
}

/** Keeps the first old value of each recomputed cell of the transaction. */
function remember(tx: Tx, recomputed: readonly RecomputedValues[]): void {
  const journal = journalOf(tx);
  for (const item of recomputed) {
    if (item.before === undefined) continue;
    let byField = journal.get(item.tableId);
    if (byField === undefined) {
      byField = new Map();
      journal.set(item.tableId, byField);
    }
    let byRecord = byField.get(item.fieldId);
    if (byRecord === undefined) {
      byRecord = new Map();
      byField.set(item.fieldId, byRecord);
    }
    for (const [recordId, value] of item.before) {
      if (!byRecord.has(recordId)) byRecord.set(recordId, value);
    }
  }
}

const SYSTEM_ACTOR = { type: 'system', id: null } as const;
/** Alias of the data table in image reads. Code constant, never input. */
const R = 'r';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function jsonOf(raw: unknown): JsonValue {
  if (raw === undefined || raw === null) return null;
  if (Array.isArray(raw) && raw.length === 0) return null;
  return raw as JsonValue;
}

/** Stored formula/lookup field with a column. */
function storedComputed(row: FieldRow): boolean {
  return isComputedRow(row) && row.compute_mode === 'stored' && row.db_column_name !== null;
}

/** Formula/lookup field computed on read (or without its column yet): no image value (T462). */
function unimagedComputed(row: FieldRow): boolean {
  return isComputedRow(row) && !storedComputed(row);
}

/**
 * Meta of the computed fields of one base for envelopes: result type and
 * references (T457 `computedReferences`), with the base's
 * `strict_computed_permissions`. Loaded once per use (three queries).
 */
class ComputedMetaReader {
  private readonly analyses = new Map<string, FormulaAnalysis | null>();

  private constructor(
    readonly rows: BaseSchemaRows,
    private readonly strict: boolean,
    readonly locale: LocaleContext,
  ) {}

  static async load(db: Db, scope: OrgScope, baseId: Id<'bse'>): Promise<ComputedMetaReader> {
    const rows = await loadBaseSchemaRows(db, scope, baseId);
    const base = await new BasesRepository(db).getById(scope, baseId, { includeDeleted: true });
    const organization = await new OrganizationsRepository(db).findById(
      scope.organizationId,
      scope.tx,
    );
    const orgSettings = isRecord(organization?.settings) ? organization.settings : {};
    const baseSettings = isRecord(base?.settings) ? base.settings : {};
    const locale = [baseSettings['locale'], orgSettings['locale']].find(
      (value): value is string => typeof value === 'string' && value !== '',
    );
    const zone = orgSettings['timezone'];
    return new ComputedMetaReader(rows, strictComputedPermissionsOf(base?.settings), {
      locale: locale ?? 'en',
      timeZone: typeof zone === 'string' && isValidTimeZone(zone) ? zone : 'UTC',
    });
  }

  meta(field: FieldRow): ComputedFieldMeta {
    const tableOf = new Map(this.rows.fields.map((row) => [row.id as string, row.table_id]));
    const references = computedReferences(field, this.rows, (row) => {
      if (!this.analyses.has(row.id)) this.analyses.set(row.id, analysisOfField(row, this.rows));
      return this.analyses.get(row.id) ?? null;
    });
    const pairs = (ids: ReadonlySet<string>) =>
      [...ids].sort().flatMap((fieldId) => {
        const tableId = tableOf.get(fieldId);
        return tableId === undefined ? [] : [{ table_id: tableId, field_id: fieldId as Id<'fld'> }];
      });
    const result = computedFilterResultOf(field.result_type);
    return {
      ...(result.resultType === undefined ? {} : { result_type: result.resultType }),
      ...(result.resultOptions === undefined ? {} : { result_options: result.resultOptions }),
      ...(result.resultIsList === undefined ? {} : { result_is_list: result.resultIsList }),
      tables: [...references.tables].sort() as Id<'tbl'>[],
      cross_fields: pairs(references.crossFields),
      same_row_fields: pairs(references.sameRowFields),
      strict: this.strict,
    };
  }

  /** How a raw (`to_jsonb`) value of `field` becomes its cell. */
  cellField(field: FieldRow): ComputedCellField {
    const type = formulaTypeOf(field.result_type);
    const resultType = type === null || type.kind === 'any' ? null : type;
    const element = resultType?.kind === 'list' ? resultType.element : resultType;
    return {
      locked: false,
      publicType:
        resultType === null ? { kind: 'null', list: false } : publicResultType(resultType),
      recordTableId: element?.kind === 'row' ? element.tableId : null,
      style: null,
    };
  }
}

/** Field meta of an image field of a table model (links and computed fields included). */
function plainMeta(row: FieldRow): RecordChangeField {
  return { id: row.id, type: row.type, options: row.options };
}

interface ImageRow extends Record<string, unknown> {
  readonly __id: Id<'rec'>;
  readonly __version: number;
  readonly __deleted: boolean;
  readonly __created_at: Date;
  readonly __updated_at: Date;
  readonly __created_by: string | null;
  readonly __updated_by: string | null;
}

/** The `afterRecompute` hook publishing recomputed values on the realtime bus (T459). */
export class RealtimeComputedHooks implements ComputedRecomputeHooks {
  private readonly fields: FieldsRepository;
  private readonly tables: TablesRepository;
  private readonly ruleFields: RecordRuleFields;
  private readonly linkImages: LinkImageReader;
  private readonly members: MemberDirectoryRepository;
  private readonly publisher: RealtimeRecordChangePublisher;

  constructor(private readonly db: Db) {
    this.fields = new FieldsRepository(db);
    this.tables = new TablesRepository(db);
    this.ruleFields = new RecordRuleFields(db);
    this.linkImages = new LinkImageReader(db);
    this.members = new MemberDirectoryRepository(db);
    this.publisher = new RealtimeRecordChangePublisher(db);
  }

  async afterRecompute(
    tx: Tx,
    input: {
      readonly organizationId: Id<'org'>;
      readonly recomputed: readonly RecomputedValues[];
    },
  ): Promise<void> {
    // Without a bus nothing listens (CLI, seed, tests): no image reads.
    if (realtimePublisherOf(this.db) === undefined || input.recomputed.length === 0) return;
    remember(tx, input.recomputed);
    const scope = orgScope(input.organizationId, tx);
    const byTable = new Map<string, RecomputedValues[]>();
    for (const item of input.recomputed) {
      const list = byTable.get(item.tableId) ?? [];
      list.push(item);
      byTable.set(item.tableId, list);
    }
    const metas = new Map<string, ComputedMetaReader>();
    const published: {
      changes: RecordChange[];
      fields: RecordChangeField[];
      links: RecordChangeLink[];
    }[] = [];
    for (const [tableId, items] of byTable) {
      const table = await this.tables.getById(scope, tableId as Id<'tbl'>);
      if (table === undefined) continue;
      let meta = metas.get(table.base_id);
      if (meta === undefined) {
        meta = await ComputedMetaReader.load(this.db, scope, table.base_id);
        metas.set(table.base_id, meta);
      }
      const write = await this.tableWrite(scope, table, items, meta);
      if (write !== null) published.push(write);
    }
    if (published.length === 0) return;
    // After the write that caused the recompute (its envelope carries the old values).
    afterCommit(
      tx,
      async () => {
        for (const write of published) {
          await this.publisher.publish(write.changes, write.fields, write.links);
        }
      },
      { last: true },
    );
  }

  /** The changes of one table: one `record.updated` per live record whose values changed. */
  private async tableWrite(
    scope: OrgScope,
    table: TableRow,
    items: readonly RecomputedValues[],
    meta: ComputedMetaReader,
  ): Promise<{
    changes: RecordChange[];
    fields: RecordChangeField[];
    links: RecordChangeLink[];
  } | null> {
    const rows = await this.fields.listByTable(scope, table.id);
    const byId = new Map(rows.map((row) => [row.id as string, row]));
    const ruleIds = await this.ruleFields.of(scope, table.base_id, table.id);
    const imageFields: FieldModel[] = [];
    const imageLinks: LinkFieldModel[] = [];
    const imageComputed: FieldRow[] = [];
    const unimaged: FieldRow[] = [];
    for (const row of rows) {
      if (!ruleIds.has(row.id)) continue;
      if (storedComputed(row)) {
        imageComputed.push(row);
        continue;
      }
      if (unimagedComputed(row)) {
        unimaged.push(row);
        continue;
      }
      const link = toLinkFieldModel(row);
      if (link !== null) {
        imageLinks.push(link);
        continue;
      }
      const model = toFieldModel(row);
      if (model !== null) imageFields.push(model);
    }
    // Recomputed fields of each record, and their old values.
    const changedOf = new Map<string, Set<Id<'fld'>>>();
    const oldOf = new Map<string, Map<string, unknown>>();
    for (const item of items) {
      if (byId.get(item.fieldId)?.db_column_name == null) continue;
      for (const recordId of item.recordIds) {
        const set = changedOf.get(recordId) ?? new Set<Id<'fld'>>();
        set.add(item.fieldId);
        changedOf.set(recordId, set);
      }
      if (item.before !== undefined) {
        const map = oldOf.get(item.fieldId) ?? new Map<string, unknown>();
        for (const [recordId, value] of item.before) map.set(recordId, value);
        oldOf.set(item.fieldId, map);
      }
    }
    if (changedOf.size === 0) return null;
    const recomputedIds = new Set<string>(items.map((item) => item.fieldId));
    const computedRows = rows.filter(
      (row) =>
        storedComputed(row) &&
        (recomputedIds.has(row.id) || imageComputed.some((image) => image.id === row.id)),
    );
    const owned = imageFields.filter((field) => field.ownsColumn);
    const ids = [...changedOf.keys()].sort();
    const { rows: found } = await sql<ImageRow>`
      SELECT ${sql.id(R, '__id')} AS __id, ${sql.id(R, '__version')} AS __version,
             (${sql.id(R, '__deleted_at')} IS NOT NULL) AS __deleted,
             ${sql.id(R, '__created_at')} AS __created_at,
             ${sql.id(R, '__updated_at')} AS __updated_at,
             ${sql.id(R, '__created_by')} AS __created_by,
             ${sql.id(R, '__updated_by')} AS __updated_by
             ${sql.join(
               owned.map(
                 (field, index) =>
                   sql`, ${sql.id(R, field.column)} AS ${sql.id(`c${String(index)}`)}`,
               ),
               sql``,
             )}
             ${sql.join(
               computedRows.map(
                 (row, index) =>
                   sql`, to_jsonb(${sql.id(
                     R,
                     assertFieldColumnName(row.db_column_name ?? ''),
                   )}) AS ${sql.id(`k${String(index)}`)}`,
               ),
               sql``,
             )}
        FROM ${dataTableRef(table)} AS ${sql.id(R)}
       WHERE ${sql.id(R, '__id')} = ANY(${sql.val(ids)}::text[])
       ORDER BY ${sql.id(R, '__id')}
    `.execute(scope.tx as Tx);
    // Records in the trash are not published (CONTRACTS §7).
    const live = found.filter((row) => !row.__deleted);
    if (live.length === 0) return null;
    const linkCells =
      imageLinks.length === 0
        ? (new Map() as LinkImageCells)
        : await this.linkImages.read(
            scope,
            imageLinks,
            live.map((row) => row.__id),
          );
    const current = (row: ImageRow, field: FieldRow): unknown =>
      row[`k${String(computedRows.indexOf(field))}`];

    // Display data of the values: members, and titles of records (every title: the gateway
    // keeps them only for subscribers allowed to see them, like link cells).
    const cellFields = new Map(
      computedRows
        .filter((row) => recomputedIds.has(row.id))
        .map((row) => [row.id as string, meta.cellField(row)]),
    );
    const data = await this.cellData(scope, live, computedRows, cellFields, current, meta);

    const changes: RecordChange[] = live.map((row) => {
      const changed = [...(changedOf.get(row.__id) ?? [])].sort();
      const system: Record<string, JsonValue> = {};
      for (const field of imageFields) system[field.id] = systemValue(field, owned, row);
      for (const link of imageLinks) {
        system[link.id] = linkCells.get(row.__id)?.get(link.id) ?? null;
      }
      const after: Record<string, JsonValue> = { ...system };
      const before: Record<string, JsonValue> = { ...system };
      for (const field of imageComputed) {
        const now = jsonOf(current(row, field));
        after[field.id] = now;
        const old = oldOf.get(field.id);
        before[field.id] =
          changed.includes(field.id) && old?.has(row.__id) === true
            ? jsonOf(old.get(row.__id))
            : now;
      }
      const values: Record<string, unknown> = {};
      for (const fieldId of changed) {
        const fieldRow = byId.get(fieldId);
        const cellField = cellFields.get(fieldId);
        if (fieldRow === undefined || cellField === undefined) continue;
        values[fieldId] = computedCellValue(
          cellField,
          current(row, fieldRow),
          data,
          'json',
          meta.locale,
          'member',
        );
      }
      return {
        type: 'record.updated',
        organizationId: table.organization_id,
        baseId: table.base_id,
        tableId: table.id,
        recordId: row.__id,
        version: row.__version,
        changedFieldIds: changed,
        eventId: null,
        actor: SYSTEM_ACTOR,
        actorUserId: null,
        before,
        after,
        values,
      };
    });
    const fields: RecordChangeField[] = [
      ...imageFields.map((field) => plainMeta(field.row)),
      ...imageLinks.map((link) => plainMeta(link.row)),
      ...computedRows.map((row) => ({ ...plainMeta(row), computed: meta.meta(row) })),
      // Virtual fields a view filter names (T462): meta only, receivers fall back to a batch.
      ...unimaged.map((row) => ({
        ...plainMeta(row),
        computed: { ...meta.meta(row), virtual: true },
      })),
    ];
    const links: RecordChangeLink[] = [];
    for (const [fieldId, cellField] of cellFields) {
      const target = cellField.recordTableId;
      if (target === null || cellField.publicType.kind !== 'record') continue;
      const targetTable = meta.rows.tables.find((item) => item.id === target);
      links.push({
        id: fieldId as Id<'fld'>,
        tableId: target as Id<'tbl'>,
        titleFieldId: targetTable?.primary_field_id ?? null,
      });
    }
    return { changes, fields, links };
  }

  /** Members of user values and titles of record values (system access, every live record). */
  private async cellData(
    scope: OrgScope,
    rows: readonly ImageRow[],
    computedRows: readonly FieldRow[],
    cellFields: ReadonlyMap<string, ComputedCellField>,
    current: (row: ImageRow, field: FieldRow) => unknown,
    meta: ComputedMetaReader,
  ): Promise<ComputedCellData> {
    const userIds = new Set<string>();
    const recordIds = new Map<string, Set<string>>();
    for (const field of computedRows) {
      const cell = cellFields.get(field.id);
      if (cell === undefined) continue;
      const kind = cell.publicType.kind;
      if (kind !== 'user' && kind !== 'record') continue;
      for (const row of rows) {
        const raw = current(row, field);
        for (const item of Array.isArray(raw) ? (raw as unknown[]) : [raw]) {
          if (typeof item !== 'string') continue;
          if (kind === 'user') userIds.add(item);
          else if (cell.recordTableId !== null && isId('rec', item)) {
            const set = recordIds.get(cell.recordTableId) ?? new Set<string>();
            set.add(item);
            recordIds.set(cell.recordTableId, set);
          }
        }
      }
    }
    const users = new Map<string, UserRef>(
      (await this.members.findMembers(scope, [...userIds])).map((member) => [member.id, member]),
    );
    const titles = new Map<string, Map<string, string | null>>();
    for (const [tableId, ids] of recordIds) {
      titles.set(tableId, await this.titles(scope, tableId as Id<'tbl'>, [...ids], meta));
    }
    return { users, titles };
  }

  private async titles(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    ids: readonly string[],
    meta: ComputedMetaReader,
  ): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    const table = meta.rows.tables.find((item) => item.id === tableId);
    const primaryRow =
      table?.primary_field_id == null
        ? undefined
        : meta.rows.fields.find((row) => row.id === table.primary_field_id);
    const primary = primaryRow === undefined ? null : toFieldModel(primaryRow);
    if (table === undefined || primary === null) return out;
    const { rows } = await sql<{ id: string; title: unknown }>`
      SELECT ${sql.id(R, '__id')} AS id, ${sql.id(R, primary.column)} AS title
        FROM ${dataTableRef(table)} AS ${sql.id(R)}
       WHERE ${sql.id(R, '__id')} = ANY(${sql.val(ids)}::text[])
         AND ${sql.id(R, '__deleted_at')} IS NULL
    `.execute(scope.tx as Tx);
    const users = new Map<string, UserRef>(
      (
        await this.members.findMembers(
          scope,
          titleUserIds(
            primary,
            rows.map((row) => row.title),
          ),
        )
      ).map((member) => [member.id, member]),
    );
    for (const row of rows) out.set(row.id, titleOf(primary, row.title, meta.locale, users));
    return out;
  }
}

/** Storage-form value of an image field of a row read by {@link RealtimeComputedHooks}. */
function systemValue(field: FieldModel, owned: readonly FieldModel[], row: ImageRow): JsonValue {
  switch (field.type) {
    case 'created_at':
      return row.__created_at.toISOString();
    case 'updated_at':
      return row.__updated_at.toISOString();
    case 'created_by':
      return row.__created_by;
    case 'updated_by':
      return row.__updated_by;
    default: {
      const index = owned.indexOf(field);
      return index < 0 ? null : storedValueToJson(field.type, row[`c${String(index)}`]);
    }
  }
}

/**
 * Fields named by record rules or saved view filters that a record change's
 * images lack, added before commit (T459, ADR-31; called by
 * `RecordMutationService` only while a realtime bus listens):
 *
 * - stored formula/lookup fields — every change of the table carries their
 *   value as it was **before** the recompute of this transaction (the
 *   recompute is published after the write, as its own `record.updated`),
 *   on both sides of the change;
 * - virtual formula/lookup fields (T462) — field meta only (`virtual`), no
 *   image value: receivers cannot evaluate a view condition on them;
 * - link cells in the images of system writes (auto numbers, removed select
 *   options, conversions: `record.updated` only; S4-review §4 #11) — those
 *   writes never change links, so the current cell stands on both sides.
 *   Ordinary writes image their link fields themselves (T402).
 */
export class ComputedImages {
  private readonly fields: FieldsRepository;
  private readonly ruleFields: RecordRuleFields;
  private readonly linkImages: LinkImageReader;

  constructor(private readonly db: Db) {
    this.fields = new FieldsRepository(db);
    this.ruleFields = new RecordRuleFields(db);
    this.linkImages = new LinkImageReader(db);
  }

  async augment(
    scope: OrgScope,
    table: TableRow,
    changes: readonly RecordChange[],
    fields: readonly RecordChangeField[],
  ): Promise<{ changes: RecordChange[]; fields: RecordChangeField[] }> {
    const tx = scope.tx;
    const unchanged = { changes: [...changes], fields: [...fields] };
    if (tx === undefined || changes.length === 0) return unchanged;
    const ruleIds = await this.ruleFields.of(scope, table.base_id, table.id);
    const imaged = new Set<string>(fields.map((field) => field.id));
    const missing = new Set<string>([...ruleIds].filter((fieldId) => !imaged.has(fieldId)));
    if (missing.size === 0) return unchanged;
    const rows = (await this.fields.listByTable(scope, table.id)).filter((row) =>
      missing.has(row.id),
    );
    const computed = rows.filter(storedComputed);
    const unimaged = rows.filter(unimagedComputed);
    const updates = changes.filter((change) => change.type === 'record.updated');
    const links =
      updates.length === 0
        ? []
        : rows.map(toLinkFieldModel).filter((link): link is LinkFieldModel => link !== null);
    if (computed.length === 0 && links.length === 0 && unimaged.length === 0) return unchanged;

    const ids = [...new Set(changes.map((change) => change.recordId))].sort();
    let byRecord = new Map<string, Record<string, unknown>>();
    if (computed.length > 0) {
      const { rows: found } = await sql<Record<string, unknown> & { __id: string }>`
        SELECT ${sql.id(R, '__id')} AS __id
               ${sql.join(
                 computed.map(
                   (row, index) =>
                     sql`, to_jsonb(${sql.id(
                       R,
                       assertFieldColumnName(row.db_column_name ?? ''),
                     )}) AS ${sql.id(`k${String(index)}`)}`,
                 ),
                 sql``,
               )}
          FROM ${dataTableRef(table)} AS ${sql.id(R)}
         WHERE ${sql.id(R, '__id')} = ANY(${sql.val(ids)}::text[])
      `.execute(tx);
      byRecord = new Map(found.map((row) => [row.__id, row]));
    }
    const linkCells =
      links.length === 0
        ? (new Map() as LinkImageCells)
        : await this.linkImages.read(
            scope,
            links,
            [...new Set(updates.map((change) => change.recordId))].sort(),
          );
    const journal = journals.get(tx)?.get(table.id);
    const valueOf = (recordId: string, row: FieldRow, index: number): JsonValue => {
      const old = journal?.get(row.id);
      if (old?.has(recordId) === true) return jsonOf(old.get(recordId));
      return jsonOf(byRecord.get(recordId)?.[`k${String(index)}`]);
    };
    const out = changes.map((change): RecordChange => {
      if (change.before === null && change.after === null) return change;
      const extra: Record<string, JsonValue> = {};
      computed.forEach((row, index) => {
        extra[row.id] = valueOf(change.recordId, row, index);
      });
      if (change.type === 'record.updated') {
        for (const link of links) {
          extra[link.id] = linkCells.get(change.recordId)?.get(link.id) ?? null;
        }
      }
      const withExtra = (image: StoredImage | null): StoredImage | null =>
        image === null ? null : { ...image, ...extra };
      return { ...change, before: withExtra(change.before), after: withExtra(change.after) };
    });
    const meta =
      computed.length === 0 && unimaged.length === 0
        ? null
        : await ComputedMetaReader.load(this.db, scope, table.base_id);
    return {
      changes: out,
      fields: [
        ...fields,
        ...links.map((link) => plainMeta(link.row)),
        ...computed.map((row) => ({
          ...plainMeta(row),
          ...(meta === null ? {} : { computed: meta.meta(row) }),
        })),
        // Virtual fields a view filter names (T462): meta only, never an image value.
        ...unimaged.map((row) => ({
          ...plainMeta(row),
          ...(meta === null ? {} : { computed: { ...meta.meta(row), virtual: true } }),
        })),
      ],
    };
  }
}
