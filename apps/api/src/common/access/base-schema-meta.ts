import { isAiField } from '@cellhive/server-core';

import type { Id } from '@cellhive/contracts';
import type { FieldMeta, SchemaMeta, TableMeta } from '@cellhive/permissions';
import type {
  DashboardsRepository,
  FieldsRepository,
  OrgScope,
  TablesRepository,
} from '@cellhive/server-core';

/**
 * Loads the part of a base's schema the permission model needs (tables with
 * their fields, dashboards). Injected with `@Inject(BASE_SCHEMA_META)`.
 * Callers that resolve access go through `AccessService`, which caches the
 * resolved access (schema included) per request.
 */
export interface BaseSchemaMetaLoader {
  load(scope: OrgScope, baseId: Id<'bse'>): Promise<SchemaMeta>;
}

export const BASE_SCHEMA_META = Symbol('BASE_SCHEMA_META');

/**
 * Reads `meta.tables` / `meta.fields` / `meta.dashboards` (outside the
 * trash): each table with its fields' types, `computed` for formula/lookup
 * fields stored or evaluated by the system (`compute_mode`), and the ids of
 * the dashboards (T805: system editors/readers and admins see them all,
 * custom roles the ones they list — deny by default). Three queries per
 * base; honours a transaction in `scope`.
 */
export class MetaBaseSchemaLoader implements BaseSchemaMetaLoader {
  constructor(
    private readonly tables: TablesRepository,
    private readonly fields: FieldsRepository,
    private readonly dashboards: DashboardsRepository,
  ) {}

  async load(scope: OrgScope, baseId: Id<'bse'>): Promise<SchemaMeta> {
    // Sequential: `scope` may carry a transaction (one connection).
    const tables = await this.tables.listByBase(scope, baseId);
    const fields = tables.length === 0 ? [] : await this.fields.listActiveByBase(scope, baseId);
    const byTable = new Map<Id<'tbl'>, FieldMeta[]>(tables.map((table) => [table.id, []]));
    for (const field of fields) {
      byTable.get(field.table_id)?.push({
        id: field.id,
        type: field.type,
        // AI fields (T910) are written by the AI worker only: read at most, like formulas.
        ...(field.compute_mode === null && !isAiField(field) ? {} : { computed: true }),
      });
    }
    return {
      tables: tables.map((table): TableMeta => ({
        id: table.id,
        fields: byTable.get(table.id) ?? [],
      })),
      dashboards: await this.dashboards.activeIdsByBase(scope, baseId),
    };
  }
}
