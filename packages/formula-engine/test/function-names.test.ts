import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FORMULA_LIMIT_ISSUE_CODES,
  FORMULA_SYNTAX_ISSUE_CODES,
  formulaErrorCode,
  isPhase2Function,
  isSupportedFunction,
  MVP_FUNCTION_NAMES,
  PHASE2_FUNCTION_NAMES,
  S4B_FUNCTION_NAMES,
} from '../src/index.js';

const spec = readFileSync(join(import.meta.dirname, '..', '..', '..', 'docs', 'SPEC.md'), 'utf8');

/** Function names of one bullet of SPEC §9.3 (`- Logic: \`IF, IFS, …\``). */
function specList(label: string): string[] {
  const section = spec.slice(spec.indexOf('### 9.3'), spec.indexOf('### 9.4'));
  const line = section.split('\n').find((item) => item.startsWith(`- ${label}`));
  // The list is the last code span of the bullet (the S4b one cites a file first).
  const code = [...(line ?? '').matchAll(/`([^`]+)`/g)].at(-1)?.[1] ?? '';
  return code.split(',').map((name) => name.trim());
}

describe('function names match SPEC §9.3', () => {
  it('MVP lists', () => {
    const expected = ['Logic', 'Số', 'Text', 'Ngày', 'List'].flatMap(specList);
    expect(expected.length).toBeGreaterThan(80);
    expect([...MVP_FUNCTION_NAMES]).toEqual(expected);
  });

  it('S4b additions', () => {
    expect([...S4B_FUNCTION_NAMES]).toEqual(specList('Bổ sung ở S4b'));
  });

  it('Phase 2 names are listed and never supported', () => {
    for (const name of specList('Phase 2').filter((item) => /^[A-Z0-9]+$/.test(item))) {
      expect(PHASE2_FUNCTION_NAMES).toContain(name);
    }
    for (const name of PHASE2_FUNCTION_NAMES) {
      expect([isPhase2Function(name), isSupportedFunction(name)]).toEqual([true, false]);
    }
  });

  it('has no duplicates', () => {
    const all = [...MVP_FUNCTION_NAMES, ...S4B_FUNCTION_NAMES, ...PHASE2_FUNCTION_NAMES];
    expect(new Set(all).size).toBe(all.length);
  });

  it('only accepts upper-case names', () => {
    expect([isSupportedFunction('SUM'), isSupportedFunction('sum')]).toEqual([true, false]);
  });
});

describe('error codes', () => {
  it.each(FORMULA_SYNTAX_ISSUE_CODES)('%s is a syntax error', (code) => {
    expect(formulaErrorCode(code)).toBe('FORMULA_SYNTAX_ERROR');
  });

  it.each(FORMULA_LIMIT_ISSUE_CODES)('%s is a limit error', (code) => {
    expect(formulaErrorCode(code)).toBe('FORMULA_LIMIT_EXCEEDED');
  });
});
