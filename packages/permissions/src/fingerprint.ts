import { resolveVariables, type ResolveContext } from '@cellhive/filter-dsl';

import type { ResolvedBaseAccess } from './resolve.js';
import type { Id } from '@cellhive/contracts';

/**
 * Version of the fingerprint material below: bump it when the material
 * changes shape, so that older cache entries are never read again.
 */
export const PERMISSION_FINGERPRINT_VERSION = 1;

/**
 * Canonical JSON (object keys sorted, arrays in order) — the same value
 * always gives the same text, whatever the key order it was built with.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = canonical(item);
    }
    return out;
  }
  return value;
}

/**
 * What a reader's permissions on `tableIds` are, **with the variables of
 * their read rules already replaced** (`current_user`, `current_user_groups`,
 * date operands — SPEC §6.1): the material of the permission fingerprint of
 * the dashboard widget cache (SPEC §10.4, BACKLOG T807, "Quyết định S7" #8).
 * The caller hashes it (SHA-256); this package stays free of crypto so the
 * web app can import it.
 *
 * Per table (sorted, duplicates once): whether the reader sees it (table
 * perm other than `no_perm` — else `null`), the fields they can read (any
 * perm but `no_perm`) and their read rule (which already folds the read
 * scope in) as resolved for this reader. Two readers get the same material exactly when they read the
 * same records and fields of those tables: two members of one role whose
 * rule is `owner has_any_of current_user` resolve to two user ids, hence
 * two fingerprints, while two members of a role without variables share
 * one. Editing rights (table perm `read` vs `edit`/`manage`, operations,
 * edit rules, views) are left out: they never change what a read returns,
 * so an admin, an editor and a reader without rules share entries.
 *
 * `related` mirrors `RecordAccessContext.relatedAccess` (share links): a
 * table present in `resolved` is read with `resolved`, any other with
 * `related` when given.
 *
 * Fails closed: `null` when a rule cannot be resolved (the caller must not
 * cache then).
 */
export function permissionFingerprintMaterial(
  resolved: ResolvedBaseAccess,
  tableIds: readonly Id<'tbl'>[],
  context: ResolveContext,
  related?: ResolvedBaseAccess,
): string | null {
  const tables: [Id<'tbl'>, unknown][] = [];
  for (const tableId of [...new Set(tableIds)].sort()) {
    const source =
      related === undefined || Object.hasOwn(resolved.access.tables, tableId) ? resolved : related;
    const table = source.access.tables[tableId];
    if (table === undefined) {
      tables.push([tableId, null]);
      continue;
    }
    const fields = Object.entries(table.fields)
      .filter(([, perm]) => (perm as string) !== 'no_perm')
      .map(([fieldId]) => fieldId)
      .sort();
    const filters = source.internal.readFilters;
    // Visible without an entry in `readFilters` never happens; read it as "nothing".
    const rule = Object.hasOwn(filters, tableId) ? (filters[tableId] ?? null) : 'none';
    let resolvedRule: unknown = rule;
    if (rule !== null && rule !== 'none') {
      try {
        resolvedRule = resolveVariables(rule, context);
      } catch {
        return null;
      }
    }
    tables.push([tableId, { fields, rule: resolvedRule }]);
  }
  return canonicalJson({ v: PERMISSION_FINGERPRINT_VERSION, tables });
}
