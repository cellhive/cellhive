import {
  prepareRoleConfig,
  roleConfigSchema,
  type RoleConfig,
  type RoleFieldMeta,
  type RoleSchemaMeta,
} from '@cellhive/permissions';

import { isAiField } from '../../ai/generation/options.js';
import { AppError } from '../../errors/app-error.js';
import { SCHEMA_ENTRIES } from '../entries.js';
import { packageProblem } from '../errors.js';
import { packageRoleSchema } from '../manifest.js';
import { PackageLocation } from '../references.js';

import { mentionsAny } from './phantoms.js';
import { asDefinition, checkDefinition } from './pipeline.js';

import type { BaseImportContext } from './pipeline.js';
import type { BaseSchemaRows } from '../../computed/definition/schema-rows.js';
import type { JsonObject } from '../../db/schema.js';
import type { Id } from '@cellhive/contracts';

/** Longest role name (`CreateRoleRequest`). */
const MAX_ROLE_NAME_LENGTH = 100;

/**
 * Custom roles of a `.chbase` import (T1019, ADR-24 §2.7): created with
 * their config and assigned to nobody (assignments are never exported; the
 * importer, owner of the new base, assigns them). Each config is checked as
 * when a role is saved (`prepareRoleConfig` against the tables, fields and
 * shared views of the new base, its `dashboards.<id>` against the
 * dashboards created) — names unique per base, system role names
 * included. A config naming what the package does not hold (an id of
 * `missing_ids`: a field the source had in its trash…) is kept as at the
 * source after a check of its shape: a rule never loses a condition.
 */

/** The schema a role config of the new base is checked against. */
export function roleSchemaOf(
  rows: BaseSchemaRows,
  views: ReadonlyMap<string, readonly Id<'viw'>[]>,
  dashboards: readonly Id<'dsh'>[],
): RoleSchemaMeta {
  return {
    tables: rows.tables.map((table) => ({
      id: table.id,
      fields: rows.fields
        .filter((field) => field.table_id === table.id && field.deleted_at === null)
        .map((field): RoleFieldMeta => ({
          id: field.id,
          name: field.name,
          type: field.type as RoleFieldMeta['type'],
          options: field.options,
          // AI fields are written by the AI worker only: read at most, like formulas.
          ...(field.compute_mode === null && !isAiField(field) ? {} : { computed: true }),
        })),
      views: [...(views.get(table.id) ?? [])],
    })),
    dashboards: [...dashboards],
    existingViews: new Set([...views.values()].flat()),
  };
}

/** The config to store of one role of the package. */
export function importedRoleConfig(
  config: unknown,
  schema: RoleSchemaMeta,
  phantoms: ReadonlySet<string>,
): RoleConfig {
  const dashboards = new Set<string>(schema.dashboards ?? []);
  const keepDashboards = (value: RoleConfig): RoleConfig => ({
    ...value,
    // A dashboard the package does not hold is gone, like a purged one.
    dashboards: Object.fromEntries(
      Object.entries(value.dashboards).filter(([id]) => dashboards.has(id)),
    ),
  });
  const prepared = prepareRoleConfig(config, schema, { kind: 'custom' });
  if (prepared.ok) return keepDashboards(prepared.config);
  if (prepared.error !== 'schema' && mentionsAny(config, phantoms)) {
    // Broken at the source (a field in its trash…): kept, its shape checked.
    const shape = roleConfigSchema.safeParse(config);
    if (shape.success) return keepDashboards(shape.data);
  }
  throw new AppError(prepared.error === 'filter' ? 'INVALID_FILTER' : 'VALIDATION_FAILED', {
    detail: 'The role config is not valid for this base.',
  });
}

/** Creates the custom roles of the package (see the top of this file). */
export async function importRoles(
  context: BaseImportContext,
  rows: BaseSchemaRows,
  views: ReadonlyMap<string, readonly Id<'viw'>[]>,
  dashboards: readonly Id<'dsh'>[],
  phantoms: ReadonlySet<string>,
  tick: () => Promise<void>,
): Promise<void> {
  const { plan, baseId, target, report } = context;
  const root = PackageLocation.of(SCHEMA_ENTRIES.roles).at('roles');
  const schema = roleSchemaOf(rows, views, dashboards);
  const roles = plan.deferred.roles.map((value, index) => {
    const parsed = packageRoleSchema.safeParse(value);
    if (!parsed.success) {
      throw packageProblem('INVALID_DEFINITION', root.at(index).toString(), 'A role is malformed.');
    }
    return { role: parsed.data, index };
  });
  roles.sort((a, b) => a.role.position - b.role.position || a.index - b.index);
  for (const { role, index } of roles) {
    const at = root.at(index);
    const name = role.name.trim();
    if (name.length === 0 || name.length > MAX_ROLE_NAME_LENGTH) {
      throw packageProblem(
        'INVALID_DEFINITION',
        at.at('name').toString(),
        'A role name is not valid.',
      );
    }
    const config = checkDefinition(at.at('config').toString(), () =>
      importedRoleConfig(role.config, schema, phantoms),
    );
    await target.checkpoint();
    await asDefinition(at.toString(), () =>
      target.createRole(baseId, {
        id: role.id,
        name,
        config: config as unknown as JsonObject,
      }),
    );
    report.roles += 1;
    await tick();
  }
}
