import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const srcDir = join(import.meta.dirname, '..', 'src');
// @cellhive/filter-dsl is browser-safe itself (enforced by its ESLint rule).
const allowed = new Set(['zod', '@cellhive/contracts', '@cellhive/filter-dsl']);

describe('browser portability', () => {
  const files = readdirSync(srcDir).filter((name) => name.endsWith('.ts'));

  it.each(files)(
    '%s imports only zod, @cellhive/contracts, @cellhive/filter-dsl or local modules',
    (name) => {
      const source = readFileSync(join(srcDir, name), 'utf8');
      const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] ?? '');
      expect(specifiers.length).toBeGreaterThan(0);
      for (const specifier of specifiers) {
        expect(specifier.startsWith('./') || allowed.has(specifier), specifier).toBe(true);
      }
    },
  );
});
