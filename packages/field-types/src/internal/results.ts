import {
  FieldValueError,
  type TypecastResult,
  type ValidationResult,
  type ValueIssue,
  type ValueIssueCode,
} from '../core.js';

export const OK: ValidationResult = { ok: true };

export function issue(
  code: ValueIssueCode,
  message: string,
  params?: Readonly<Record<string, unknown>>,
): ValueIssue {
  return params === undefined ? { code, message } : { code, message, params };
}

export function invalid(...issues: ValueIssue[]): { ok: false; issues: ValueIssue[] } {
  return { ok: false, issues };
}

export function cast<W>(value: W, unknownOptions: readonly string[] = []): TypecastResult<W> {
  return { ok: true, value, unknownOptions };
}

/** Runs `validate` and throws when it fails; used at the top of every `toStorage`. */
export function assertValid(result: ValidationResult): void {
  if (!result.ok) throw new FieldValueError(result.issues);
}

export function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export const READ_ONLY_ISSUE = issue('FIELD_READ_ONLY', 'Field is read-only');

/** Write-path members shared by every read-only type. */
export const readOnlyWrites = {
  readOnly: true,
  supportsDefaultValue: false,
  validate(): ValidationResult {
    return invalid(READ_ONLY_ISSUE);
  },
  typecast(): TypecastResult<never> {
    return invalid(READ_ONLY_ISSUE);
  },
  toStorage(): never {
    throw new FieldValueError([READ_ONLY_ISSUE]);
  },
} as const;

/** Splits a free-text list on commas (and semicolons when asked), trimming and dropping blanks. */
export function splitList(input: string, separators: RegExp): string[] {
  return input
    .split(separators)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** Order-preserving de-duplication. */
export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Intl output uses NBSP / narrow NBSP; `cell_format=text` uses plain spaces. */
export function plainSpaces(text: string): string {
  return text.replace(/[\u00a0\u202f]/g, ' ');
}
