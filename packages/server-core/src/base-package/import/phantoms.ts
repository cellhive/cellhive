import { isId } from '@cellhive/contracts';

import { SCHEMA_ENTRIES } from '../entries.js';
import { packageBaseSchema } from '../manifest.js';

import type { ImportPlan } from './plan.js';
import type { BasePackageReader } from '../reader.js';

/**
 * Ids of the new base that name nothing (ADR-24 amendment §1): each id of
 * `schema/base.json` `missing_ids` — a field or table the source had in
 * its trash, a view or dashboard deleted… — got a new id from pass 1 that
 * no object of the import takes. A definition naming one stays broken as
 * at the source (a `#REF` formula, a `broken` widget), so the steps of
 * T1019 check it for its shape only instead of refusing the package.
 */
export async function phantomIdsOf(
  plan: Pick<ImportPlan, 'ids'>,
  reader: Pick<BasePackageReader, 'readJson'>,
): Promise<ReadonlySet<string>> {
  const base = await reader.readJson(SCHEMA_ENTRIES.base, packageBaseSchema);
  const phantoms = new Set<string>();
  for (const id of base.missing_ids) {
    // Options are mapped per field: a missing one never stands where an id is looked up.
    if (isId('opt', id)) continue;
    const mapped = plan.ids.resolve(id);
    if (mapped !== null) phantoms.add(mapped);
  }
  return phantoms;
}

/**
 * Whether a JSON value names one of `ids` — as a string, inside one (a
 * formula or a prompt: `[fld_…]`) or as a key. Ids of `phantomIdsOf` are
 * random ids of this import, so a match is never a coincidence.
 */
export function mentionsAny(value: unknown, ids: ReadonlySet<string>): boolean {
  if (ids.size === 0) return false;
  const visit = (node: unknown, depth: number): boolean => {
    if (depth > 64) return false;
    if (typeof node === 'string') {
      for (const id of ids) if (node.includes(id)) return true;
      return false;
    }
    if (Array.isArray(node)) return node.some((item) => visit(item, depth + 1));
    if (typeof node === 'object' && node !== null) {
      return Object.entries(node).some(([key, item]) => ids.has(key) || visit(item, depth + 1));
    }
    return false;
  };
  return visit(value, 0);
}

/** The ids of `ids` that `value` names (see {@link mentionsAny}), sorted. */
export function mentionedIds(value: unknown, ids: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  for (const id of ids) if (mentionsAny(value, new Set([id]))) found.add(id);
  return [...found].sort();
}
