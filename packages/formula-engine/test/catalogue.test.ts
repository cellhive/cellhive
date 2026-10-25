import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  analyze,
  FUNCTION_GROUPS,
  FUNCTIONS,
  getFunction,
  listCatalogue,
  MVP_FUNCTION_NAMES,
  PARAM_NAMES,
  PHASE2_FUNCTION_NAMES,
  PHASE2_FUNCTIONS,
  S4B_FUNCTION_NAMES,
  signatureText,
  syntaxOf,
  tryParse,
  type FunctionDefinition,
} from '../src/index.js';

import { orders } from './typed-fixture.js';

const spec = readFileSync(join(import.meta.dirname, '..', '..', '..', 'docs', 'SPEC.md'), 'utf8');
const section = spec.slice(spec.indexOf('### 9.3'), spec.indexOf('### 9.4'));

/** Function names of one bullet of SPEC §9.3. */
function specList(label: string): string[] {
  const line = section.split('\n').find((item) => item.startsWith(`- ${label}`));
  const code = [...(line ?? '').matchAll(/`([^`]+)`/g)].at(-1)?.[1] ?? '';
  return code.split(',').map((name) => name.trim());
}

const SPEC_GROUPS: [string, FunctionDefinition['group']][] = [
  ['Logic', 'logic'],
  ['Số', 'number'],
  ['Text', 'text'],
  ['Ngày', 'date'],
  ['List', 'list'],
];

const definitions = Object.values(FUNCTIONS);

describe('catalogue ↔ SPEC §9.3', () => {
  it('has every MVP and S4b function, and nothing else', () => {
    const names = [...MVP_FUNCTION_NAMES, ...S4B_FUNCTION_NAMES];
    expect(Object.keys(FUNCTIONS).sort()).toEqual([...names].sort());
    for (const name of names) expect(FUNCTIONS[name].name).toBe(name);
  });

  it.each(SPEC_GROUPS)('%s functions are in group %s', (label, group) => {
    for (const name of specList(label)) expect(getFunction(name)?.group, name).toBe(group);
  });

  it('puts the S4b additions in a group', () => {
    for (const name of specList('Bổ sung ở S4b')) {
      expect(FUNCTION_GROUPS).toContain(getFunction(name)?.group);
    }
  });

  it('lists every Phase 2 function as not supported', () => {
    expect(PHASE2_FUNCTIONS.map((entry) => entry.name)).toEqual([...PHASE2_FUNCTION_NAMES]);
    for (const entry of PHASE2_FUNCTIONS) expect(entry.phase2).toBe(true);
    expect(listCatalogue()).toHaveLength(
      MVP_FUNCTION_NAMES.length + S4B_FUNCTION_NAMES.length + PHASE2_FUNCTION_NAMES.length,
    );
  });

  it('looks names up in any case', () => {
    expect(getFunction('sum')?.name).toBe('SUM');
    expect(getFunction('RANDOMBETWEEN')).toBeUndefined();
  });
});

describe.each(definitions.map((definition) => [definition.name, definition] as const))(
  '%s',
  (_name, definition) => {
    it('has en and vi descriptions, signatures and examples', () => {
      expect(definition.description.en.length).toBeGreaterThan(5);
      expect(definition.description.vi.length).toBeGreaterThan(5);
      expect(definition.description.vi).not.toBe(definition.description.en);
      expect(definition.signatures.length).toBeGreaterThan(0);
      expect(definition.examples.length).toBeGreaterThan(0);
      if (definition.notes !== undefined) {
        expect(definition.notes.en).not.toBe('');
        expect(definition.notes.vi).not.toBe(definition.notes.en);
      }
      for (const example of definition.examples) {
        expect(example.formula.en).not.toBe('');
        expect(example.formula.vi).not.toBe('');
        expect(example.result.vi).toBeDefined();
      }
    });

    it('names every param in both languages', () => {
      for (const signature of definition.signatures) {
        for (const param of [
          ...signature.params,
          ...(signature.trailing ? [signature.trailing] : []),
        ]) {
          expect(PARAM_NAMES[param.name], param.name).toBeDefined();
        }
      }
      expect(syntaxOf(definition, 'en')[0]).toMatch(new RegExp(`^${definition.name}\\(`));
      expect(syntaxOf(definition, 'vi')[0]).toMatch(new RegExp(`^${definition.name}\\(`));
    });

    it('has examples that parse and call it', () => {
      for (const example of definition.examples) {
        for (const formula of [example.formula.en, example.formula.vi]) {
          const parsed = tryParse(formula);
          expect(parsed.ok, formula).toBe(true);
          expect(formula.toUpperCase()).toContain(`${definition.name}(`);
        }
      }
    });

    it('typechecks examples that use no fields', () => {
      for (const example of definition.examples) {
        if (example.formula.en.includes('[')) continue;
        expect(
          analyze(example.formula.en, orders, { form: 'display' }).errors,
          example.formula.en,
        ).toEqual([]);
      }
    });
  },
);

describe('flags', () => {
  it('marks NOW and TODAY volatile, nothing else', () => {
    expect(
      definitions
        .filter((item) => item.volatile)
        .map((item) => item.name)
        .sort(),
    ).toEqual(['NOW', 'TODAY']);
  });

  it('marks the iterating functions', () => {
    expect(
      definitions
        .filter((item) => item.iterates)
        .map((item) => item.name)
        .sort(),
    ).toEqual(['COUNTIF', 'FILTER', 'MAP', 'SORTBY', 'SUMIF']);
  });

  it('marks no supported function as Phase 2', () => {
    expect(definitions.filter((item) => item.phase2 as boolean)).toEqual([]);
  });
});

describe('signature text', () => {
  const cases: [string, string, string][] = [
    ['IF', 'en', 'IF(condition, value if true, [value if false])'],
    ['IF', 'vi', 'IF(điều kiện, giá trị khi đúng, [giá trị khi sai])'],
    ['SUM', 'en', 'SUM(number, [number, …])'],
    ['IFS', 'en', 'IFS(condition, value, [condition, value, …])'],
    ['FORMAT', 'en', 'FORMAT(template, [value, …])'],
    ['NOW', 'en', 'NOW()'],
    ['SWITCH', 'en', 'SWITCH(expression, pattern1, result1, [pattern2, result2, …], [default])'],
  ];
  it.each(cases)('%s (%s) → %s', (name, locale, expected) => {
    const definition = getFunction(name);
    expect(definition).toBeDefined();
    if (definition === undefined) return;
    expect(syntaxOf(definition, locale as 'en' | 'vi')[0]).toBe(expected);
  });

  it('shows every overload', () => {
    const sumif = getFunction('SUMIF');
    expect(sumif?.signatures.map((item) => signatureText('SUMIF', item))).toEqual([
      'SUMIF(range, condition)',
      'SUMIF(range, condition, value to add)',
    ]);
    const phase2 = PHASE2_FUNCTIONS[0];
    expect(phase2 === undefined ? [] : syntaxOf(phase2)).toEqual([
      'RANDOMBETWEEN(bottom, top, [update_continuously])',
    ]);
  });

  it('shows the trailing param of SWITCH generically', () => {
    const definition = getFunction('SWITCH');
    const signature = definition?.signatures[0];
    expect(signature === undefined ? '' : signatureText('SWITCH', signature)).toBe(
      'SWITCH(expression, pattern, result, [pattern, result, …], [default])',
    );
  });
});
