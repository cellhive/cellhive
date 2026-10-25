import { MVP_FUNCTION_NAMES, S4B_FUNCTION_NAMES, type FunctionName } from '../function-names.js';
import * as definitions from '../functions/index.js';

import { PARAM_NAMES } from './params.js';
import { PHASE2_FUNCTIONS } from './phase2.js';

import type {
  CatalogueEntry,
  FunctionDefinition,
  Localized,
  Param,
  Phase2FunctionDefinition,
  Signature,
} from './types.js';

export * from './types.js';
export { PARAM_NAMES } from './params.js';
export { PHASE2_FUNCTIONS } from './phase2.js';

/** Every supported function (SPEC §9.3 MVP + S4b), keyed by upper-case name. */
export const FUNCTIONS: Readonly<Record<FunctionName, FunctionDefinition>> = definitions;

const BY_NAME: ReadonlyMap<string, FunctionDefinition> = new Map(
  [...MVP_FUNCTION_NAMES, ...S4B_FUNCTION_NAMES].map((name) => [name, definitions[name]]),
);
const PHASE2_BY_NAME: ReadonlyMap<string, Phase2FunctionDefinition> = new Map(
  PHASE2_FUNCTIONS.map((definition) => [definition.name, definition]),
);

/** The definition of a supported function; `name` in any case. */
export function getFunction(name: string): FunctionDefinition | undefined {
  return BY_NAME.get(name.toUpperCase());
}

/**
 * The whole catalogue for the formula editor (T466): supported functions
 * then Phase 2 ones, each group in SPEC order.
 */
export function listCatalogue(): CatalogueEntry[] {
  return [...BY_NAME.values(), ...PHASE2_BY_NAME.values()];
}

export type Locale = keyof Localized;

function paramText(param: Param, locale: Locale): string {
  return PARAM_NAMES[param.name]?.[locale] ?? param.name;
}

/** `NAME(a, b, [c])`, `SUM(number, [number, …])`: one signature as the catalogue shows it. */
export function signatureText(name: string, signature: Signature, locale: Locale = 'en'): string {
  const repeat = signature.repeat ?? 0;
  const fixed = signature.params.slice(0, signature.params.length - repeat);
  const group = signature.params.slice(signature.params.length - repeat);
  const parts = fixed.map((param) => {
    const text = paramText(param, locale);
    return param.optional === true ? `[${text}]` : text;
  });
  if (group.length > 0) {
    const names = group.map((param) => paramText(param, locale)).join(', ');
    if (!group.every((param) => param.optional === true)) parts.push(names);
    parts.push(`[${names}, …]`);
  }
  if (signature.trailing !== undefined) parts.push(`[${paramText(signature.trailing, locale)}]`);
  return `${name}(${parts.join(', ')})`;
}

/** Every syntax line of a catalogue entry (one per overload). */
export function syntaxOf(entry: CatalogueEntry, locale: Locale = 'en'): string[] {
  if (entry.phase2 || entry.syntax !== undefined) return [entry.syntax ?? ''];
  return entry.signatures.map((signature) => signatureText(entry.name, signature, locale));
}
