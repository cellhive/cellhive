import { REALTIME_RECORD_BATCH_THRESHOLD, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';

import { FieldsRepository } from '../../schema/fields.repository.js';
import { TablesRepository } from '../../schema/tables.repository.js';
import { RecordRuleFields } from '../rule-fields.js';
import { storedValueToJson } from '../storage-values.js';
import { buildTableModel, type FieldModel, type TableModel } from '../table-model.js';

import { LinkImageReader } from './link-images.js';
import { toLinkFieldModel, type LinkFieldModel } from './link-model.js';
import { junctionRef } from './link-reader.js';
import { dataTableRef } from './link-targets.js';
import { LinkWriter } from './link-writer.js';

import type { Db } from '../../db/create-db.js';
import type { OrgScope } from '../../db/repository.js';
import type { JsonValue, TableRow } from '../../db/schema.js';
import type {
  RecordChangeFanout,
  RecordChangeLink,
  StoredImage,
} from '../record-change-publisher.js';
import type { RecordAccessContext } from '../types.js';
import type { LocaleContext } from '@cellhive/field-types';

/** What happened to the linked records: renamed (primary field), trashed, restored. */
export type LinkFanoutKind = 'title' | 'removed' | 'restored';

/** A `record.updated` of a linking record whose cell shows changed records (no event, same version). */
export interface LinkFanoutChange {
  readonly type: 'record.updated';
  readonly recordId: Id<'rec'>;
  readonly version: number;
  readonly changedFieldIds: readonly Id<'fld'>[];
  readonly eventId: null;
  readonly before: StoredImage;
  readonly after: StoredImage;
  readonly shown: StoredImage;
  readonly linkValues: Readonly<Record<string, unknown>>;
}

/** The changes of one link field's cells, published as one write on its table. */
export interface LinkFanoutPlan {
  readonly table: TableRow;
  readonly model: TableModel;
  readonly link: RecordChangeLink;
  readonly changes: readonly LinkFanoutChange[];
  readonly fanout: RecordChangeFanout;
}

/** Aliases of the junction / the linking table. Code constants, never input. */
const J = 'j';
const S = 's';

interface SourceRow extends Record<string, unknown> {
  readonly __id: Id<'rec'>;
  readonly __version: number;
  readonly __created_at: Date;
  readonly __updated_at: Date;
  readonly __created_by: string | null;
  readonly __updated_by: string | null;
  readonly dst: string[];
}

/**
 * Cross-table realtime of link cells (BACKLOG T402, CONTRACTS §7, SPEC
 * §15): when records of a table are renamed (their primary field changed)
 * or move to / come back from the trash, the link cells that show them —
 * in every link field whose linked table is that table, both sides of
 * two-way links and self-links included — read differently. Nothing is
 * written to the linking records (no event, no audit, same `__version`),
 * but their subscribers must refresh the cells.
 *
 * For each such link field, the linking records are found through the
 * junction (`b_id` index, or the primary key on the reverse side) among
 * live records, with the images the gateway needs (their record rule and
 * view filter fields, the link cell before and after), so each subscriber
 * gets only what it reads — its read rule and open view, the field perm,
 * and titles only where `links` allows them (P20). Up to
 * `REALTIME_RECORD_BATCH_THRESHOLD` linking records, the changes carry the
 * new cell (`[{ id, title }]`, one batched title read); beyond, no values
 * and every subscriber group gets one `record.batch`. Runs inside the
 * write's transaction; the mutation service publishes after commit.
 */
export class LinkFanout {
  private readonly fields: FieldsRepository;
  private readonly tables: TablesRepository;
  private readonly ruleFields: RecordRuleFields;
  private readonly images: LinkImageReader;
  private readonly writer: LinkWriter;

  constructor(db: Db) {
    this.fields = new FieldsRepository(db);
    this.tables = new TablesRepository(db);
    this.ruleFields = new RecordRuleFields(db);
    this.images = new LinkImageReader(db);
    this.writer = new LinkWriter(db);
  }

  /**
   * `ids = 'all'` (T459, S4-review §4 #11): every record of `target` shows
   * differently (its primary field's options or type changed, its auto
   * numbers were recomputed) — every linking record, titles only, without
   * values (each group gets one `record.batch`); `access` is then unused.
   */
  async plan(
    scope: OrgScope,
    target: TableRow,
    access: RecordAccessContext | null,
    kind: LinkFanoutKind,
    ids: readonly Id<'rec'>[] | 'all',
    locale: LocaleContext,
  ): Promise<LinkFanoutPlan[]> {
    const tx = scope.tx;
    if (tx === undefined) throw new TypeError('LinkFanout.plan needs a transaction');
    if (ids === 'all' ? kind !== 'title' : access === null) {
      throw new TypeError('LinkFanout.plan: every record is for titles, ids need an access');
    }
    const links = (await this.fields.listLinksTo(scope, target.id))
      .map(toLinkFieldModel)
      .filter((link) => link !== null);
    if (links.length === 0 || (ids !== 'all' && ids.length === 0)) return [];
    const titleFieldId =
      (await this.fields.listByTable(scope, target.id)).find((row) => row.is_primary)?.id ?? null;
    const plans: LinkFanoutPlan[] = [];
    const models = new Map<string, TableModel | null>();
    for (const link of links) {
      const tableId = link.row.table_id;
      let model = models.get(tableId);
      if (model === undefined) {
        const table = tableId === target.id ? target : await this.tables.getById(scope, tableId);
        model =
          table?.base_id === target.base_id
            ? buildTableModel(table, await this.fields.listByTable(scope, tableId), null)
            : null;
        models.set(tableId, model);
      }
      if (model === null) continue;
      const plan = await this.planField(
        scope,
        model,
        link,
        kind,
        ids,
        access,
        locale,
        titleFieldId,
      );
      if (plan !== null) plans.push(plan);
    }
    return plans;
  }

  private async planField(
    scope: OrgScope,
    model: TableModel,
    link: LinkFieldModel,
    kind: LinkFanoutKind,
    ids: readonly Id<'rec'>[] | 'all',
    access: RecordAccessContext | null,
    locale: LocaleContext,
    titleFieldId: Id<'fld'> | null,
  ): Promise<LinkFanoutPlan | null> {
    const tx = scope.tx;
    if (tx === undefined) throw new TypeError('LinkFanout needs a transaction');
    const ruleIds = await this.ruleFields.of(scope, model.table.base_id, model.table.id);
    const imageFields = model.fields.filter((field) => ruleIds.has(field.id));
    const imageLinks = model.links.filter((item) => ruleIds.has(item.id));
    const owned = imageFields.filter((field) => field.ownsColumn);
    const own = sql.id(J, link.ownColumn);
    const other = sql.id(J, link.otherColumn);
    // Live linking records whose cell holds one of `ids` (junction index on `other`).
    const { rows } = await sql<SourceRow>`
      SELECT ${sql.id(S, '__id')} AS __id, ${sql.id(S, '__version')} AS __version,
             ${sql.id(S, '__created_at')} AS __created_at,
             ${sql.id(S, '__updated_at')} AS __updated_at,
             ${sql.id(S, '__created_by')} AS __created_by,
             ${sql.id(S, '__updated_by')} AS __updated_by,
             array_agg(${other} ORDER BY ${other}) AS dst
             ${sql.join(
               owned.map(
                 (field, index) =>
                   sql`, ${sql.id(S, field.column)} AS ${sql.id(`c${String(index)}`)}`,
               ),
               sql``,
             )}
        FROM ${junctionRef(link)} AS ${sql.id(J)}
        JOIN ${dataTableRef(model.table)} AS ${sql.id(S)} ON ${sql.id(S, '__id')} = ${own}
       WHERE ${ids === 'all' ? sql`true` : sql`${other} = ANY(${sql.val([...ids])}::text[])`}
         AND ${sql.id(S, '__deleted_at')} IS NULL
       GROUP BY ${sql.id(S, '__id')}
       ORDER BY ${sql.id(S, '__id')}
    `.execute(tx);
    if (rows.length === 0) return null;
    const sourceIds = rows.map((row) => row.__id);
    const withValues =
      ids !== 'all' && access !== null && rows.length <= REALTIME_RECORD_BATCH_THRESHOLD;

    // Link cells after the change (the write is already applied in this transaction).
    // By id: `link` (from `listLinksTo`) and `model.links` are distinct objects.
    const imaged = imageLinks.some((item) => item.id === link.id);
    const cellLinks = withValues && !imaged ? [...imageLinks, link] : imageLinks;
    const cells = await this.images.read(scope, cellLinks, sourceIds);
    let refs: Map<string, { id: string; title: string | null }> | null = null;
    if (withValues) {
      const linked = sourceIds.flatMap((id) => {
        const value = cells.get(id)?.get(link.id);
        return Array.isArray(value) ? (value as string[]) : [];
      });
      refs = (await this.writer.refsOf(scope, link.targetTableId, access, linked, locale)).refs;
    }

    const changes = rows.map((row): LinkFanoutChange => {
      const own = cells.get(row.__id);
      const system = systemImage(imageFields, row);
      const afterLinks: Record<string, JsonValue> = {};
      const beforeLinks: Record<string, JsonValue> = {};
      for (const item of imageLinks) {
        const after = own?.get(item.id) ?? null;
        afterLinks[item.id] = after;
        beforeLinks[item.id] = item.id === link.id ? cellBefore(kind, after, row.dst) : after;
      }
      const cell = own?.get(link.id) ?? null;
      return {
        type: 'record.updated',
        recordId: row.__id,
        version: row.__version,
        changedFieldIds: [link.id],
        eventId: null,
        before: { ...system, ...beforeLinks },
        after: { ...system, ...afterLinks },
        shown: {},
        linkValues:
          refs === null
            ? {}
            : {
                [link.id]: Array.isArray(cell)
                  ? (cell as string[]).map((id) => refs.get(id) ?? { id, title: null })
                  : null,
              },
      };
    });
    return {
      table: model.table,
      model,
      link: { id: link.id, tableId: link.targetTableId, titleFieldId },
      changes,
      fanout: { fieldId: link.id, titlesOnly: kind === 'title', values: withValues },
    };

    /** Storage-form values of the image fields of a source row. */
    function systemImage(fields: readonly FieldModel[], row: SourceRow): Record<string, JsonValue> {
      const image: Record<string, JsonValue> = {};
      for (const field of fields) {
        switch (field.type) {
          case 'created_at':
            image[field.id] = row.__created_at.toISOString();
            break;
          case 'updated_at':
            image[field.id] = row.__updated_at.toISOString();
            break;
          case 'created_by':
            image[field.id] = row.__created_by;
            break;
          case 'updated_by':
            image[field.id] = row.__updated_by;
            break;
          default: {
            const index = owned.indexOf(field);
            image[field.id] =
              index < 0 ? null : storedValueToJson(field.type, row[`c${String(index)}`]);
          }
        }
      }
      return image;
    }
  }
}

/**
 * The cell before the change, from the cell after it: trashed records were
 * still in it, restored ones were not (renames keep the ids).
 */
function cellBefore(kind: LinkFanoutKind, after: JsonValue, changed: readonly string[]): JsonValue {
  const list = Array.isArray(after) ? (after as string[]) : [];
  if (kind === 'title') return after;
  const next =
    kind === 'removed'
      ? [...list, ...changed.filter((id) => !list.includes(id))]
      : list.filter((id) => !changed.includes(id));
  return next.length === 0 ? null : next;
}
