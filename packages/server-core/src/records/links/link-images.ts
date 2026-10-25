import { sql } from 'kysely';

import { TablesRepository } from '../../schema/tables.repository.js';

import { cellOrder, junctionRef } from './link-reader.js';
import { dataTableRef, TARGET_ALIAS } from './link-targets.js';

import type { LinkFieldModel } from './link-model.js';
import type { Db } from '../../db/create-db.js';
import type { OrgScope } from '../../db/repository.js';
import type { JsonValue, TableRow } from '../../db/schema.js';
import type { Id } from '@cellhive/contracts';

/** Alias of the junction (the one `cellOrder` orders by). Code constant, never input. */
const J = 'j';

/** Storage-form link cells by record id, then field id (ids of live linked records; `null` = empty). */
export type LinkImageCells = Map<string, Map<Id<'fld'>, JsonValue>>;

/**
 * Storage-form values of link cells for realtime images (BACKLOG T402): a
 * saved view filter may name a link field, so the gateway evaluates it on
 * the record's link cells before and after a change — the ids of the live
 * linked records, like `LinkCellReader` shows them (a linked table in the
 * trash reads empty).
 */
export class LinkImageReader {
  private readonly tables: TablesRepository;

  constructor(db: Db) {
    this.tables = new TablesRepository(db);
  }

  /** Cells of `links` for `recordIds` (every record gets every field, `null` when empty). */
  async read(
    scope: OrgScope,
    links: readonly LinkFieldModel[],
    recordIds: readonly string[],
  ): Promise<LinkImageCells> {
    const tx = scope.tx;
    if (tx === undefined) throw new TypeError('LinkImageReader.read needs a transaction');
    const result: LinkImageCells = new Map();
    const ids = [...new Set(recordIds)];
    for (const id of ids) {
      result.set(id, new Map(links.map((link) => [link.id, null])));
    }
    if (ids.length === 0) return result;
    const targets = new Map<string, TableRow | undefined>();
    for (const link of links) {
      if (!targets.has(link.targetTableId)) {
        targets.set(link.targetTableId, await this.tables.getById(scope, link.targetTableId));
      }
      const target = targets.get(link.targetTableId);
      if (target === undefined) continue;
      const own = sql.id(J, link.ownColumn);
      const other = sql.id(J, link.otherColumn);
      const { rows } = await sql<{ src: string; dst: string }>`
        SELECT ${own} AS src, ${other} AS dst
          FROM ${junctionRef(link)} AS ${sql.id(J)}
          JOIN ${dataTableRef(target)} AS ${sql.id(TARGET_ALIAS)}
            ON ${sql.id(TARGET_ALIAS, '__id')} = ${other}
         WHERE ${own} = ANY(${sql.val(ids)}::text[])
           AND ${sql.id(TARGET_ALIAS, '__deleted_at')} IS NULL
         ORDER BY ${own}, ${cellOrder(link)}
      `.execute(tx);
      const byRecord = new Map<string, string[]>();
      for (const row of rows) byRecord.set(row.src, [...(byRecord.get(row.src) ?? []), row.dst]);
      for (const [src, list] of byRecord) result.get(src)?.set(link.id, list);
    }
    return result;
  }
}
