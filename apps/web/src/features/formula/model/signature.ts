import {
  getFunction,
  PARAM_NAMES,
  type FunctionDefinition,
  type Locale,
  type Param,
  type Signature,
} from '@cellhive/formula-engine';

import { formulaContext } from './context';

import type { FormulaSchema } from './schema';

/**
 * Signature bar of the formula editor (board "S4b · Trình soạn công
 * thức"): the innermost function call around the caret, its signature with
 * the parameter at the caret marked.
 */

export interface SignaturePart {
  readonly text: string;
  /** The parameter the caret is in. */
  readonly active: boolean;
}

export interface ActiveSignature {
  readonly definition: FunctionDefinition;
  /** `receiver.NAME(` when the call is chained, else `NAME(`; then the parameters and `)`. */
  readonly parts: readonly SignaturePart[];
  /** The active parameter (`null`: past the last one). */
  readonly param: Param | null;
}

/** Parameter of `signature` that argument `index` fills (repeated groups wrap around). */
export function paramAt(signature: Signature, index: number): Param | null {
  const repeat = signature.repeat ?? 0;
  const fixed = signature.params.length - repeat;
  if (index < fixed) return signature.params[index] ?? null;
  if (repeat > 0) return signature.params[fixed + ((index - fixed) % repeat)] ?? null;
  return index === signature.params.length ? (signature.trailing ?? null) : null;
}

function accepts(signature: Signature, count: number): boolean {
  const repeat = signature.repeat ?? 0;
  return (
    repeat > 0 || count <= signature.params.length + (signature.trailing === undefined ? 0 : 1)
  );
}

function paramText(param: Param, locale: Locale): string {
  return (PARAM_NAMES[param.name]?.[locale] ?? param.name).replace(/ /gu, '_');
}

/** The call around `pos` and its signature; `null` outside any known function call. */
export function activeSignature(
  source: string,
  pos: number,
  schema: FormulaSchema,
  locale: Locale,
): ActiveSignature | null {
  const open = formulaContext(source.slice(0, pos), schema).open;
  for (let index = open.length - 1; index >= 0; index -= 1) {
    const call = open[index];
    if (call === undefined || call.name === null || call.name === 'LET') continue;
    const definition = getFunction(call.name);
    if (definition === undefined) return null;
    const signature =
      definition.signatures.find((candidate) => accepts(candidate, call.argument + 1)) ??
      definition.signatures[0];
    if (signature === undefined) return null;
    const param = paramAt(signature, call.argument);
    const repeat = signature.repeat ?? 0;
    const shown = signature.params.map((item, position) => {
      const optional = item.optional === true;
      const text = paramText(item, locale);
      return {
        text: optional ? `[${text}]` : text,
        active: item === param,
        repeated: position >= signature.params.length - repeat,
      };
    });
    const first = call.chained ? shown.shift() : undefined;
    const parts: SignaturePart[] = [];
    if (first !== undefined) {
      parts.push({ text: first.text.replace(/^\[|\]$/gu, ''), active: first.active });
      parts.push({ text: `.${definition.name}(`, active: false });
    } else {
      parts.push({ text: `${definition.name}(`, active: false });
    }
    shown.forEach((item, position) => {
      if (position > 0) parts.push({ text: ', ', active: false });
      parts.push({ text: item.text, active: item.active });
    });
    if (repeat > 0) parts.push({ text: ', …', active: false });
    if (signature.trailing !== undefined) {
      parts.push({ text: ', ', active: false });
      parts.push({
        text: `[${paramText(signature.trailing, locale)}]`,
        active: signature.trailing === param,
      });
    }
    parts.push({ text: ')', active: false });
    return { definition, parts, param };
  }
  return null;
}
