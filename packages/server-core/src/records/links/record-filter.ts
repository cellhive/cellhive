import { resolveVariables, validateFilter, type ResolveContext } from '@cellhive/filter-dsl';

import { compileToSql } from '../../query/index.js';

import { TARGET_ALIAS, type LinkTarget } from './link-targets.js';

import type { LinkFieldModel } from './link-model.js';
import type { RawBuilder, SqlBool } from 'kysely';

/**
 * `record_filter` of the field over the linked table (aliased
 * {@link TARGET_ALIAS}), resolved for the principal; `null` when there is
 * none or it no longer validates (e.g. it names a deleted field: ignored,
 * like a saved view condition for members). Shared by link writes (T401)
 * and the picker candidates (T402).
 */
export function recordFilterSql(
  field: LinkFieldModel,
  target: LinkTarget,
  context: ResolveContext,
): RawBuilder<SqlBool> | null {
  const filter = field.options.record_filter;
  if (filter === null) return null;
  const validated = validateFilter(
    filter,
    target.model.filterMeta,
    target.model.fields.map((model) => model.id),
  );
  if (!validated.ok) return null;
  return compileToSql(resolveVariables(validated.ast, context), target.model.filterMeta, {
    tableAlias: TARGET_ALIAS,
  });
}
