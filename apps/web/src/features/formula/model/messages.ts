import type { Diagnostic } from './analysis';

const NAMED_CODES: ReadonlySet<string> = new Set([
  'UNKNOWN_FIELD',
  'UNKNOWN_FUNCTION',
  'UNSUPPORTED_FUNCTION',
]);

/**
 * The editor's own, more precise message for a diagnostic (`formula:errors.*`),
 * or `null` for the generic one of `errors:detail.<code>` (CONTRACTS §6).
 */
export function editorMessageKey(item: Pick<Diagnostic, 'code' | 'params'>): string | null {
  const { code, params } = item;
  if (code === 'UNEXPECTED_END' && typeof params['function'] === 'string') {
    return 'formula:errors.UNCLOSED_CALL';
  }
  if (NAMED_CODES.has(code) && typeof params['name'] === 'string') {
    return `formula:errors.${code}_named`;
  }
  if (code === 'WRONG_ARGUMENT_COUNT' && typeof params['function'] === 'string') {
    if (params['max'] === null) return 'formula:errors.WRONG_ARGUMENT_COUNT_open';
    return params['max'] === params['min']
      ? 'formula:errors.WRONG_ARGUMENT_COUNT_exact'
      : 'formula:errors.WRONG_ARGUMENT_COUNT';
  }
  // M5: branches of different types suggest wrapping the odd one in TEXT().
  if (
    code === 'TYPE_MISMATCH' &&
    Array.isArray(params['suggestions']) &&
    params['suggestions'].includes('TEXT')
  ) {
    return 'formula:errors.TYPE_MISMATCH_text';
  }
  return null;
}
