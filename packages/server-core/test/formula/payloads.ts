/** Injection payloads of the S4b convention (BACKLOG "Quy ước S4b"). */
export const PAYLOADS = [
  "'; DROP TABLE data.t_victim; --",
  '$1',
  '" OR 1=1 --',
  '\\',
  '-- comment',
  '/* comment */',
  'a\'b"c]d\\e',
] as const;

/** A formula string literal of `value` (escaping `"` and `\`, SPEC §9.2). */
export const literal = (value: string): string =>
  `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

/** A formula name reference `[value]` (escaping `]` and `\`, SPEC §9.2). */
export const ref = (value: string): string =>
  `[${value.replaceAll('\\', '\\\\').replaceAll(']', '\\]')}]`;

/** Formulas mixing a payload field name and payload literals. */
export function injectionFormulas(field: string, value: string): string[] {
  return [
    `${ref(field)} & ${literal(value)}`,
    `IF(${ref(field)} = ${literal(value)}, ${literal(value)}, "no")`,
    `CONCATENATE(${literal(value)}, LEN(${literal(value)}))`,
    `SUBSTITUTE(${ref(field)}, ${literal(value)}, ${literal(value)})`,
    `FORMAT(${literal(`${value}{1}`)}, ${ref(field)})`,
    `CONTAIN(LIST(${literal(value)}), ${ref(field)})`,
    `ISBLANK(TODATE(${literal(value)}))`,
  ];
}
