import type { FieldDto } from '@cellhive/contracts';

/**
 * The three suggested questions of an empty "Ask AI" panel (T914, research
 * S8 §5.5), built from the fields the user reads so they name real fields
 * and can be answered: a total by month, a count per group, the group with
 * the highest total — each when the table has the fields it needs, else the
 * next kind (a count per month, a total, the record count). Deterministic,
 * pure: `key` of the `aiAsk` namespace + its parameters.
 */
export interface Suggestion {
  readonly key: `suggestions.${string}`;
  readonly params: Readonly<Record<string, string>>;
}

export const MAX_SUGGESTIONS = 3;

const DATE_TYPES: ReadonlySet<string> = new Set(['datetime', 'created_at', 'updated_at']);

function isNumber(field: FieldDto): boolean {
  if (field.type === 'number') return true;
  // A formula or lookup with a number result the user may see (T457).
  return (
    (field.type === 'formula' || field.type === 'lookup') &&
    field.result_type?.kind === 'number' &&
    !field.result_type.list &&
    field.locked !== true
  );
}

/** A field to group by: a single select with options, else a user field. */
function groupField(fields: readonly FieldDto[]): FieldDto | undefined {
  const select = fields.find((field) => {
    if (field.type !== 'select') return false;
    const options = field.options as { multiple?: boolean; options?: readonly unknown[] } | null;
    return options?.multiple !== true && (options?.options?.length ?? 0) > 0;
  });
  return select ?? fields.find((field) => field.type === 'user');
}

export function askSuggestions(table: string, fields: readonly FieldDto[]): Suggestion[] {
  const number = fields.find(isNumber)?.name;
  const date = fields.find((field) => DATE_TYPES.has(field.type))?.name;
  const group = groupField(fields)?.name;
  const candidates: (Suggestion | null)[] = [
    number !== undefined && date !== undefined
      ? { key: 'suggestions.sumByMonth', params: { number } }
      : null,
    group === undefined ? null : { key: 'suggestions.countBy', params: { table, field: group } },
    number !== undefined && group !== undefined
      ? { key: 'suggestions.topBy', params: { number, field: group } }
      : null,
    number === undefined && date !== undefined
      ? { key: 'suggestions.countByMonth', params: { table } }
      : null,
    number === undefined ? null : { key: 'suggestions.total', params: { number } },
    { key: 'suggestions.count', params: { table } },
  ];
  return candidates
    .filter((candidate): candidate is Suggestion => candidate !== null)
    .slice(0, MAX_SUGGESTIONS);
}
