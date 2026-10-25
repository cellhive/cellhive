import { isId, type Id, type StoredViewConfig, type StoredViewSort } from '@cellhive/contracts';
import {
  resolveVariables,
  validateFilter,
  type ResolveContext,
  type ResolvedFilterNode,
} from '@cellhive/filter-dsl';
import { isViewVisible, type TableAccess } from '@cellhive/permissions';

import { AppError } from '../errors/app-error.js';
import { filterFieldIds, storedViewConfigOf } from '../views/view-config.js';

import type { ComputedField } from './computed/read/computed-fields.js';
import type { FieldModel, TableModel } from './table-model.js';
import type { RecordViewScope } from './types.js';
import type { OrgScope } from '../db/repository.js';
import type { ViewRow } from '../db/schema.js';
import type { ViewsRepository } from '../views/views.repository.js';

/**
 * Saved views as the record query engine reads them (SPEC §7.1–7.2, §8;
 * CONTRACTS §1.4, §15; BACKLOG T302).
 */

/** A view the caller may read records through, with its stored config. */
export interface QueryView {
  readonly row: ViewRow;
  readonly config: StoredViewConfig;
}

const viewNotFound = () => new AppError('NOT_FOUND', { detail: 'The view does not exist.' });

/**
 * The view `viewId` of `tableId` when the caller can see it: a shared view
 * listed by `view_rule.visible_views` (`null` = all), or the caller's own
 * personal view. Anything else (malformed id, another table or
 * organization, a hidden view, someone else's personal view) is
 * `NOT_FOUND`, all with the same answer (CONTRACTS §5 P16).
 */
export async function loadQueryView(
  views: ViewsRepository,
  scope: OrgScope,
  tableId: Id<'tbl'>,
  tableAccess: TableAccess,
  userId: Id<'usr'> | null,
  viewId: string,
): Promise<QueryView> {
  if (!isId('viw', viewId)) throw viewNotFound();
  const row = await views.getById(scope, viewId);
  if (row?.table_id !== tableId) throw viewNotFound();
  const visible = row.is_personal
    ? userId !== null && row.owner_id === userId
    : isViewVisible(tableAccess, row.id);
  if (!visible) throw viewNotFound();
  return { row, config: storedViewConfigOf(row.type, row.config) };
}

type FilterJson = Record<string, unknown>;

function isObject(value: unknown): value is FilterJson {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `node` without the leaves `keep` rejects; `and`/`or` groups left empty and
 * `not` nodes left without their item disappear (`null` when nothing is left).
 */
function pruneLeaves(node: unknown, keep: (leaf: FilterJson) => boolean): FilterJson | null {
  if (!isObject(node)) return null;
  if (node['op'] === 'and' || node['op'] === 'or') {
    const items = Array.isArray(node['items']) ? (node['items'] as unknown[]) : [];
    const kept = items
      .map((item) => pruneLeaves(item, keep))
      .filter((item): item is FilterJson => item !== null);
    return kept.length === 0 ? null : { ...node, items: kept };
  }
  if (node['op'] === 'not') {
    const item = pruneLeaves(node['item'], keep);
    return item === null ? null : { ...node, item };
  }
  return keep(node) ? node : null;
}

/** Filter result of a view: no condition, a condition, or nothing matches. */
export type ViewFilter = 'all' | 'none' | ResolvedFilterNode;

/**
 * The saved filter of a view over `model`, validated against the table as
 * it is now and resolved for the caller (`current_user`,
 * `current_user_groups` and `$date` follow the caller, SPEC §7.2).
 *
 * Conditions on fields the caller cannot read still apply (BACKLOG S3
 * decision 3): every active field of the table is allowed here. Conditions
 * that no longer validate — the field was deleted (or is of a type the
 * query engine does not support), an option or operand became invalid —
 * are ignored for members; under a share link the whole view matches no
 * record (fail closed).
 */
export function viewFilterOf(
  config: StoredViewConfig,
  model: TableModel,
  context: ResolveContext,
  viewScope: RecordViewScope,
): ViewFilter {
  if (config.filter === null) return 'all';
  // Link fields count once `LinkFilterMeta` added them (T402).
  const allFields = model.queryFilterMeta.fields.map((field) => field.id);
  const validates = (node: unknown) => validateFilter(node, model.queryFilterMeta, allFields).ok;

  let filter: FilterJson | null = config.filter;
  if (viewScope === 'share_link') {
    const active = new Set<string>(allFields);
    for (const id of filterFieldIds(filter)) if (!active.has(id)) return 'none';
  } else {
    filter = pruneLeaves(filter, (leaf) => validates({ op: 'and', items: [leaf] }));
    if (filter === null) return 'all';
  }
  const validated = validateFilter(filter, model.queryFilterMeta, allFields);
  if (!validated.ok) return 'none';
  return resolveVariables(validated.ast, context);
}

/**
 * A field records are ordered or grouped by: a column field, or a
 * formula/lookup read through its value expression (BACKLOG T457).
 */
export type OrderField = FieldModel | ComputedField;

/** A resolved sort or group item of a view. */
export interface ViewOrderItem {
  readonly field: OrderField;
  readonly direction: StoredViewSort['direction'];
}

/**
 * Whether records can be sorted or grouped by `field`: not by `attachment`
 * (T406; links are handled by `sortKeyIssue`). Request sort/group on one →
 * `422 INVALID_SORT` / `FIELD_NOT_SORTABLE`; saved ones are skipped.
 */
export function isOrderable(field: Pick<FieldModel, 'type'>): boolean {
  return field.type !== 'attachment';
}

/**
 * Sort or group items of a view over the active fields of `model` and its
 * formula/lookup fields `computed` (T457; records and attachments never
 * order). Items on deleted fields are skipped; fields the caller cannot read
 * still count (BACKLOG S3 decision 3) — a computed field through the
 * caller's own value expression.
 */
export function viewOrderOf(
  items: readonly StoredViewSort[],
  model: TableModel,
  computed: readonly ComputedField[] = [],
): ViewOrderItem[] {
  const byId = new Map<string, OrderField>(
    model.fields.filter(isOrderable).map((field) => [field.id as string, field]),
  );
  for (const field of computed) if (field.sortKind !== null) byId.set(field.id, field);
  return items.flatMap((item) => {
    const field = byId.get(item.field);
    return field === undefined ? [] : [{ field, direction: item.direction }];
  });
}
