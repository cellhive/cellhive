import { collectFieldIds } from '@cellhive/filter-dsl';
import { roleConfigSchema } from '@cellhive/permissions';

import { BaseRolesRepository } from '../db/repositories/base-roles.repository.js';
import { BasesRepository } from '../db/repositories/bases.repository.js';
import { filterFieldIds } from '../views/view-config.js';
import { ViewsRepository } from '../views/views.repository.js';

import type { Db } from '../db/create-db.js';
import type { OrgScope } from '../db/repository.js';
import type { Id } from '@cellhive/contracts';

/** Bases whose rule fields are kept in memory (least recently loaded dropped first). */
const MAX_CACHED_BASES = 1_000;

const EMPTY: ReadonlySet<Id<'fld'>> = new Set();

interface Entry {
  readonly version: string;
  readonly byTable: ReadonlyMap<string, ReadonlySet<Id<'fld'>>>;
}

/**
 * Fields referenced by the record rules (`edit_filter`, `read_filter`) of
 * any role of a base, per table (T210), and by the saved filters of the
 * table's views (T313) and of their color rules (T816). A record change
 * carries their values before and after the write, so the realtime gateway
 * can tell, for every subscriber, whether the record entered or left their
 * read scope (P24) and the view they have open, and which color rules match.
 *
 * Cached per base and `permission_version`: saving a role bumps the version
 * (SPEC §14.1), so a lookup costs one primary-key read of `meta.bases` in
 * the caller's transaction, plus the roles when the version moved. A role
 * config that does not parse contributes nothing (it grants nothing either).
 * View filters change without a version bump: they are read on every call
 * (one indexed read of the table's views).
 */
export class RecordRuleFields {
  readonly #bases: BasesRepository;
  readonly #roles: BaseRolesRepository;
  readonly #views: ViewsRepository;
  readonly #cache = new Map<string, Entry>();

  constructor(db: Db) {
    this.#bases = new BasesRepository(db);
    this.#roles = new BaseRolesRepository(db);
    this.#views = new ViewsRepository(db);
  }

  async of(
    scope: OrgScope,
    baseId: Id<'bse'>,
    tableId: Id<'tbl'>,
  ): Promise<ReadonlySet<Id<'fld'>>> {
    const base = await this.#bases.getById(scope, baseId, { includeDeleted: true });
    if (base === undefined) return EMPTY;
    const key = `${scope.organizationId}:${baseId}`;
    const version = String(base.permission_version);
    let entry = this.#cache.get(key);
    if (entry?.version !== version) {
      entry = { version, byTable: await this.load(scope, baseId) };
      this.#cache.delete(key);
      this.#cache.set(key, entry);
      if (this.#cache.size > MAX_CACHED_BASES) {
        const oldest = this.#cache.keys().next().value;
        if (oldest !== undefined) this.#cache.delete(oldest);
      }
    }
    const rules = entry.byTable.get(tableId) ?? EMPTY;
    const filters = await this.#views.filtersByTable(scope, tableId);
    if (filters.length === 0) return rules;
    const all = new Set<string>(rules);
    for (const filter of filters) filterFieldIds(filter, all);
    // Ids that name no field of the table are ignored by the image capture.
    return all as ReadonlySet<Id<'fld'>>;
  }

  private async load(
    scope: OrgScope,
    baseId: Id<'bse'>,
  ): Promise<Map<string, ReadonlySet<Id<'fld'>>>> {
    const byTable = new Map<string, Set<Id<'fld'>>>();
    for (const role of await this.#roles.listByBase(scope, baseId)) {
      const config = roleConfigSchema.safeParse(role.config);
      if (!config.success) continue;
      for (const [tableId, rule] of Object.entries(config.data.tables)) {
        const ids = [
          ...collectFieldIds(rule.record_rule.edit_filter),
          ...collectFieldIds(rule.record_rule.read_filter),
        ];
        if (ids.length === 0) continue;
        const set = byTable.get(tableId) ?? new Set();
        for (const id of ids) set.add(id);
        byTable.set(tableId, set);
      }
    }
    return byTable;
  }
}
