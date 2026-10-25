import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const srcDir = join(import.meta.dirname, '..', 'src');
// @cellhive/contracts, field-types and filter-dsl are browser-safe (the web client imports them).
const allowed = new Set(['@cellhive/contracts', '@cellhive/field-types', '@cellhive/filter-dsl']);
const files = readdirSync(srcDir, { recursive: true, encoding: 'utf8' }).filter((name) =>
  name.endsWith('.ts'),
);

describe('browser portability (SPEC §4)', () => {
  it.each(files)('%s imports only browser-safe packages or local modules', (name) => {
    const source = readFileSync(join(srcDir, name), 'utf8');
    const specifiers = [...source.matchAll(/(?:from|import)\s+'([^']+)'/g)].map(
      (match) => match[1] ?? '',
    );
    for (const specifier of specifiers) {
      const local = specifier.startsWith('./') || specifier.startsWith('../');
      expect(local || allowed.has(specifier), specifier).toBe(true);
    }
  });

  it.each(files)('%s runs no generated code', (name) => {
    const source = readFileSync(join(srcDir, name), 'utf8');
    expect(source).not.toMatch(/\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(|\bnode:vm\b/);
  });
});
