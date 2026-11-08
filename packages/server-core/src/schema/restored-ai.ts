import { renderTemplateNames } from '@cellhive/formula-engine';

import { aiOptionsOf } from '../ai/generation/options.js';
import { snapshotOfBase, type BaseSchemaRows } from '../computed/definition/schema-rows.js';

import { definitionTypeOf } from './conversion-ddl.js';

import type { JsonValue } from '../db/schema.js';
import type { Id } from '@cellhive/contracts';

/**
 * AI settings a conversion revert or a "restore as a new field" would bring
 * back (CONTRACTS §4.4, §29.5): the `options.ai` of the definition the field
 * had before its latest conversion, prompt in names (display form, every
 * field of the base named; a deleted one as `#REF[fld_…]`), ready for the
 * save check of `prepareAiOptions` — `null` when that definition is no AI
 * field.
 */
export function restoredAiOptionsOf(
  definition: JsonValue,
  rows: BaseSchemaRows,
  tableId: Id<'tbl'>,
): Record<string, unknown> | null {
  if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) {
    return null;
  }
  const ai = aiOptionsOf({ type: definitionTypeOf(definition), options: definition['options'] });
  if (ai === null) return null;
  return { ...ai, prompt: renderTemplateNames(ai.prompt, snapshotOfBase(rows, tableId)) };
}

/** Whether the definition a revert or a restore would bring back is an AI field. */
export function restoresAiField(definition: JsonValue): boolean {
  if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) {
    return false;
  }
  return (
    aiOptionsOf({ type: definitionTypeOf(definition), options: definition['options'] }) !== null
  );
}
