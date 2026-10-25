import { isSupportedFunction } from '@cellhive/formula-engine';

import { formulaContext } from './context';
import { fieldIcon, type ChipIcon } from './icons';

import type { FormulaSchema } from './schema';

/**
 * How each token of a formula is drawn (board "S4b · Trình soạn công
 * thức"): fields, tables and `CurrentValue` as chips showing the name,
 * functions in the accent colour, text and numbers in their colours. Shared
 * by the CodeMirror editor and the read-only formula of the field dialog.
 */
export type SegmentKind =
  | 'field'
  | 'table'
  | 'current'
  | 'broken'
  | 'function'
  | 'keyword'
  | 'variable'
  | 'number'
  | 'string'
  | 'operator'
  | 'punctuation'
  | 'invalid'
  | 'typing';

export interface Segment {
  readonly from: number;
  readonly to: number;
  readonly kind: SegmentKind;
  /** Chips: the text shown (the name without brackets). */
  readonly label?: string;
  readonly icon?: ChipIcon;
}

const CHIP_KINDS: ReadonlySet<SegmentKind> = new Set(['field', 'table', 'current', 'broken']);

export function isChip(kind: SegmentKind): boolean {
  return CHIP_KINDS.has(kind);
}

const PUNCTUATION: ReadonlySet<string> = new Set(['(', ')', ',', '.']);

const NO_SCHEMA: FormulaSchema = { tableId: '', tables: [] };

/**
 * Segments of `source`. Without a schema (catalogue examples, written with
 * sample names) every `[Name]` is a plain field chip.
 */
export function formulaSegments(source: string, schema: FormulaSchema | null): Segment[] {
  const context = formulaContext(source, schema ?? NO_SCHEMA);
  const names = new Map(context.names.map((name) => [name.start, name]));
  const tokens = context.tokens;
  return tokens.map((token, index): Segment => {
    const from = token.start;
    const to = token.start + token.length;
    switch (token.type) {
      case 'name': {
        const ref = names.get(from);
        if (ref?.kind === 'field' && ref.field !== null) {
          return { from, to, kind: 'field', label: token.value, icon: fieldIcon(ref.field.type) };
        }
        if (ref?.kind === 'table')
          return { from, to, kind: 'table', label: token.value, icon: 'table' };
        if (schema === null) return { from, to, kind: 'field', label: token.value };
        return { from, to, kind: 'broken', label: token.value, icon: 'broken' };
      }
      case 'broken_ref':
        return { from, to, kind: 'broken', label: '#REF', icon: 'broken' };
      case 'open_name':
        return { from, to, kind: 'typing' };
      case 'identifier': {
        const upper = token.value.toUpperCase();
        const next = tokens[index + 1];
        if (upper === 'CURRENTVALUE') {
          return { from, to, kind: 'current', label: 'CurrentValue', icon: 'currentValue' };
        }
        if (upper === 'TRUE' || upper === 'FALSE') return { from, to, kind: 'keyword' };
        const called = next?.type === 'operator' && next.value === '(';
        if (called || isSupportedFunction(upper)) return { from, to, kind: 'function' };
        return { from, to, kind: 'variable' };
      }
      case 'number':
        return { from, to, kind: 'number' };
      case 'string':
        return { from, to, kind: 'string' };
      case 'operator':
        return { from, to, kind: PUNCTUATION.has(token.value) ? 'punctuation' : 'operator' };
      case 'invalid':
        return { from, to, kind: 'invalid' };
    }
  });
}

/** Tailwind classes of each segment (tokens of `styles/tokens.css`, light and dark). */
export const SEGMENT_CLASSES: Readonly<Record<SegmentKind, string>> = {
  field: 'bg-accent-soft text-on-option-5 border-accent-soft',
  table: 'bg-surface-sunken text-fg border-line-strong',
  current: 'bg-option-7 text-on-option-7 border-option-7',
  broken: 'bg-surface text-danger border-danger border-dashed line-through',
  function: 'text-accent font-medium',
  keyword: 'text-on-option-7 font-medium',
  variable: 'text-on-option-7',
  number: 'text-on-option-7',
  string: 'text-on-option-6',
  operator: 'text-fg',
  punctuation: 'text-fg-muted',
  invalid: 'text-danger',
  typing: 'text-fg',
};

/** Classes shared by every chip (a 20 px pill with an icon). */
export const CHIP_CLASS =
  'mx-px inline-flex h-5 max-w-full items-center gap-1 rounded-full border px-1.5 align-middle ' +
  'font-sans text-label font-medium whitespace-nowrap';
