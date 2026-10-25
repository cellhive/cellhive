import { cellClipboardText } from '../../../grid/clipboard';
import { toGridField } from '../../../grid/types';

import type { FieldDto } from '@cellhive/contracts';
import type { LocaleContext } from '@cellhive/field-types';

/** A display field of `link-candidates` (CONTRACTS §2): at most 3 per answer. */
export interface LinkDisplayField {
  readonly id: string;
  readonly name: string;
  readonly type: string;
}

/** Types whose stored value reads as is (an option id or a user id does not). */
const PLAIN_TYPES = new Set([
  'text',
  'long_text',
  'number',
  'auto_number',
  'email',
  'phone',
  'url',
]);

/**
 * The display values of a link candidate as text, formatted like the cell
 * shows them (T421a): what tells records with the same title apart in a
 * link question, as in the link picker. Empty values are left out; a field
 * of the linked table not known (yet) shows its plain values only (text, numbers).
 */
export function linkDetails(
  candidate: { readonly fields: Readonly<Record<string, unknown>> },
  display: readonly LinkDisplayField[],
  linkedFields: readonly FieldDto[] | undefined,
  locale: LocaleContext,
): string[] {
  return display.flatMap((item) => {
    const value = candidate.fields[item.id];
    if (value === null || value === undefined) return [];
    const field = linkedFields?.find((entry) => entry.id === item.id);
    const text =
      field === undefined
        ? PLAIN_TYPES.has(item.type) && (typeof value === 'string' || typeof value === 'number')
          ? String(value)
          : ''
        : cellClipboardText(toGridField(field), value, locale);
    return text.trim() === '' ? [] : [text];
  });
}
