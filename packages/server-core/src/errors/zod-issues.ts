import type { ProblemErrorItem } from '@cellhive/contracts';
import type { z } from 'zod';

type Issue = z.core.$ZodIssue;
type PathSegment = PropertyKey;

/** Keys that can be written after a dot without ambiguity. */
const PLAIN_KEY = /^[^.[\]"]+$/;

/**
 * Formats a zod issue path the way CONTRACTS §6 shows it:
 * `records[0].fields.Amount`. Array indexes use brackets; keys containing
 * `.`, `[`, `]` or `"` (or empty keys) are written as `["a.b"]`.
 */
export function formatIssuePath(path: readonly PathSegment[]): string {
  let result = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      result += `[${String(segment)}]`;
      continue;
    }
    const key = typeof segment === 'symbol' ? (segment.description ?? '') : segment;
    if (PLAIN_KEY.test(key)) {
      result += result === '' ? key : `.${key}`;
    } else {
      result += `[${JSON.stringify(key)}]`;
    }
  }
  return result;
}

/** Detail codes are upper snake case, like the catalogue codes. */
const DETAIL_CODE = /^[A-Z][A-Z0-9_]*$/;

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value === undefined) return null;
  return value;
}

function sizeParams(issue: z.core.$ZodIssueTooBig | z.core.$ZodIssueTooSmall) {
  const bound = issue.code === 'too_big' ? issue.maximum : issue.minimum;
  return {
    [issue.code === 'too_big' ? 'maximum' : 'minimum']: jsonSafe(bound),
    inclusive: issue.inclusive ?? true,
    origin: issue.origin,
  };
}

function detailOf(issue: Issue): { code: string; params?: Record<string, unknown> } {
  switch (issue.code) {
    case 'invalid_type':
      // `input` is present only when parsing with `reportInput: true`; it is
      // inspected here and never copied into the response.
      if ('input' in issue && issue.input === undefined) {
        return { code: 'REQUIRED' };
      }
      return {
        code: `EXPECTED_${issue.expected.toUpperCase()}`,
        params: { expected: issue.expected },
      };
    case 'too_small':
    case 'too_big':
      return { code: issue.code.toUpperCase(), params: sizeParams(issue) };
    case 'invalid_format':
      return { code: 'INVALID_FORMAT', params: { format: issue.format } };
    case 'not_multiple_of':
      return { code: 'NOT_MULTIPLE_OF', params: { divisor: jsonSafe(issue.divisor) } };
    case 'unrecognized_keys':
      return { code: 'UNRECOGNIZED_KEY' };
    case 'invalid_union':
      return { code: 'INVALID_UNION' };
    case 'invalid_key':
      return { code: 'INVALID_KEY' };
    case 'invalid_element':
      return { code: 'INVALID_ELEMENT' };
    case 'invalid_value':
      return { code: 'INVALID_VALUE', params: { values: issue.values.map(jsonSafe) } };
    case 'custom': {
      const { code, ...rest } = issue.params ?? {};
      const params = Object.keys(rest).length > 0 ? rest : undefined;
      return {
        code: typeof code === 'string' && DETAIL_CODE.test(code) ? code : 'INVALID',
        ...(params === undefined ? {} : { params }),
      };
    }
  }
}

/**
 * Maps zod issues to `errors[]` items of a `VALIDATION_FAILED` problem
 * (CONTRACTS §6). The received value is never included: it may contain
 * record data or secrets.
 */
export function zodIssuesToProblemErrors(issues: readonly Issue[]): ProblemErrorItem[] {
  const items: ProblemErrorItem[] = [];
  for (const issue of issues) {
    const detail = detailOf(issue);
    const base = { code: detail.code, message: issue.message };
    const params = detail.params === undefined ? {} : { params: detail.params };
    if (issue.code === 'unrecognized_keys') {
      // One entry per key so that every entry points at a concrete location.
      for (const key of issue.keys) {
        items.push({
          path: formatIssuePath([...issue.path, key]),
          ...base,
          message: `Unrecognized key "${key}"`,
        });
      }
      continue;
    }
    items.push({ path: formatIssuePath(issue.path), ...base, ...params });
  }
  return items;
}
