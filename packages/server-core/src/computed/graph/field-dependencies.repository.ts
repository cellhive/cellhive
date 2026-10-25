import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../../db/repository.js';

import type { Db } from '../../db/create-db.js';
import type { FieldDependencyKind } from '../../db/schema.js';
import type { Id } from '@cellhive/contracts';

/** One way a computed field reads another field (a dependency of `analyze`, T452). */
export interface DependencyPath {
  readonly kind: FieldDependencyKind;
  /** Link field ids from the formula's table (`via_link`) or from the records read (`cross_table`). */
  readonly link_path: readonly string[];
  /** Formula-table fields a cross-table condition matches on; `[]` = every record. */
  readonly condition_refs: readonly string[];
}

/** An edge of the dependency graph with every path it is read through. */
export interface FieldDependencyEdge {
  readonly fieldId: Id<'fld'>;
  readonly dependsOnFieldId: Id<'fld'>;
  /** The closest kind among `paths` (`same_row` < `via_link` < `cross_table`). */
  readonly kind: FieldDependencyKind;
  readonly paths: readonly DependencyPath[];
}

const KIND_ORDER: Readonly<Record<FieldDependencyKind, number>> = {
  same_row: 0,
  via_link: 1,
  cross_table: 2,
};

/** Groups `analyze` dependencies by field (the primary key of the table). */
export function edgesOf(
  fieldId: Id<'fld'>,
  dependencies: readonly {
    readonly field_id: string;
    readonly kind: FieldDependencyKind;
    readonly link_path: readonly string[];
    readonly condition_refs: readonly string[];
  }[],
): FieldDependencyEdge[] {
  const byField = new Map<string, DependencyPath[]>();
  for (const dependency of dependencies) {
    const paths = byField.get(dependency.field_id) ?? [];
    paths.push({
      kind: dependency.kind,
      link_path: [...dependency.link_path],
      condition_refs: [...dependency.condition_refs],
    });
    byField.set(dependency.field_id, paths);
  }
  return [...byField.entries()].map(([dependsOn, paths]) => ({
    fieldId,
    dependsOnFieldId: dependsOn as Id<'fld'>,
    kind: paths.reduce<FieldDependencyKind>(
      (closest, path) => (KIND_ORDER[path.kind] < KIND_ORDER[closest] ? path.kind : closest),
      'cross_table',
    ),
    paths,
  }));
}

function pathsOf(value: unknown): DependencyPath[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return [];
    const { kind, link_path: linkPath, condition_refs: refs } = item as Record<string, unknown>;
    if (kind !== 'same_row' && kind !== 'via_link' && kind !== 'cross_table') return [];
    const strings = (list: unknown) =>
      Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
    return [{ kind, link_path: strings(linkPath), condition_refs: strings(refs) }];
  });
}

/**
 * `meta.field_dependencies` (SPEC §5.9, §5.10; migration 0022, T456): the
 * dependency graph of computed fields. Written only by `SchemaService`, in
 * the transaction that saves the field definition. Every query is scoped by
 * `organization_id`.
 */
export class FieldDependenciesRepository
  extends TenantRepository<'field_dependencies'>
  implements TenantRepositoryContract<FieldDependenciesRepository>
{
  constructor(db: Db) {
    super(db, 'field_dependencies');
  }

  /** Replaces the dependencies of `fieldId` (a new or changed definition). */
  async replaceForField(
    scope: OrgScope,
    input: {
      readonly baseId: Id<'bse'>;
      readonly fieldId: Id<'fld'>;
      readonly edges: readonly FieldDependencyEdge[];
    },
  ): Promise<void> {
    const executor = this.executor(scope);
    await executor
      .deleteFrom('meta.field_dependencies')
      .where('organization_id', '=', scope.organizationId)
      .where('field_id', '=', input.fieldId)
      .execute();
    if (input.edges.length === 0) return;
    // A field of another organization gets no edges: the key is
    // `(field_id, depends_on_field_id)`, so a row written under this scope
    // would make that organization's own `replaceForField` fail (T471).
    const own = await executor
      .selectFrom('meta.fields')
      .select('id')
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', input.fieldId)
      .executeTakeFirst();
    if (own === undefined) return;
    await executor
      .insertInto('meta.field_dependencies')
      .values(
        input.edges.map((edge) => ({
          organization_id: scope.organizationId,
          base_id: input.baseId,
          field_id: input.fieldId,
          depends_on_field_id: edge.dependsOnFieldId,
          kind: edge.kind,
          // A JSON array (the column holds `[{ kind, link_path, condition_refs }]`).
          paths: sql`CAST(${JSON.stringify(edge.paths)} AS jsonb)`,
        })),
      )
      .execute();
  }

  /** Every edge of a base (deleted fields included: T460 reads them for `#REF`). */
  async listByBase(scope: OrgScope, baseId: Id<'bse'>): Promise<FieldDependencyEdge[]> {
    const rows = await this.executor(scope)
      .selectFrom('meta.field_dependencies')
      .select(['field_id', 'depends_on_field_id', 'kind', 'paths'])
      .where('organization_id', '=', scope.organizationId)
      .where('base_id', '=', baseId)
      .orderBy('field_id')
      .orderBy('depends_on_field_id')
      .execute();
    return rows.map((row) => ({
      fieldId: row.field_id,
      dependsOnFieldId: row.depends_on_field_id,
      kind: row.kind,
      paths: pathsOf(row.paths),
    }));
  }

  /** Edges of the fields that read `fieldIds` (their direct dependents). */
  async listDependents(
    scope: OrgScope,
    fieldIds: readonly Id<'fld'>[],
  ): Promise<{ readonly fieldId: Id<'fld'>; readonly dependsOnFieldId: Id<'fld'> }[]> {
    if (fieldIds.length === 0) return [];
    const rows = await this.executor(scope)
      .selectFrom('meta.field_dependencies')
      .select(['field_id', 'depends_on_field_id'])
      .where('organization_id', '=', scope.organizationId)
      .where('depends_on_field_id', 'in', [...fieldIds])
      .orderBy('field_id')
      .execute();
    return rows.map((row) => ({
      fieldId: row.field_id,
      dependsOnFieldId: row.depends_on_field_id,
    }));
  }

  /** Removes the dependencies of `fieldId` (it is no longer computed). */
  async deleteForField(scope: OrgScope, fieldId: Id<'fld'>): Promise<void> {
    await this.executor(scope)
      .deleteFrom('meta.field_dependencies')
      .where('organization_id', '=', scope.organizationId)
      .where('field_id', '=', fieldId)
      .execute();
  }
}
