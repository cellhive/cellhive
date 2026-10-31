import type { FieldDto } from '@cellhive/contracts';

/**
 * The three example sentences of "Create with AI" (T913, research S8 §5.3),
 * built from the schema of the chosen table so they name real fields: a
 * status change, a date reminder, a new record — each from the table when it
 * has the fields that sentence needs (a single select with options, a
 * `datetime`, a user field), else a generic sentence of the same kind.
 * Deterministic, pure: `key` of the `automation` namespace + its parameters.
 */
export interface DraftExample {
  readonly key: `ai.examples.${string}`;
  readonly params: Readonly<Record<string, string>>;
}

function optionNames(field: FieldDto): string[] {
  const options = (field.options as { options?: readonly { name?: unknown }[] } | null)?.options;
  return (options ?? []).flatMap((option) =>
    typeof option.name === 'string' && option.name !== '' ? [option.name] : [],
  );
}

export function draftExamples(table: string, fields: readonly FieldDto[]): DraftExample[] {
  const select = fields.find(
    (field) =>
      field.type === 'select' &&
      (field.options as { multiple?: boolean } | null)?.multiple !== true &&
      optionNames(field).length > 0,
  );
  const user = fields.find((field) => field.type === 'user')?.name;
  const date = fields.find((field) => field.type === 'datetime')?.name;
  return [
    select === undefined || user === undefined
      ? { key: 'ai.examples.genericStatus', params: {} }
      : {
          key: 'ai.examples.status',
          // The last option is usually the final state ("Done").
          params: { table, field: select.name, option: optionNames(select).at(-1) ?? '', user },
        },
    date === undefined || user === undefined
      ? { key: 'ai.examples.genericReminder', params: {} }
      : { key: 'ai.examples.reminder', params: { table, date, user } },
    user === undefined
      ? { key: 'ai.examples.genericCreated', params: {} }
      : { key: 'ai.examples.created', params: { table, user } },
  ];
}
