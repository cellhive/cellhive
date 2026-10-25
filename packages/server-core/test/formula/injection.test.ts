/**
 * Injection (BACKLOG "Quy ước S4b", golden rule #2): field names, table
 * names and literals containing SQL never reach the SQL text — the text of
 * a compiled formula is the same as for harmless names and literals, and the
 * payloads are only bound parameters.
 */
import { describe, expect, it } from 'vitest';

import { compileUnit, render, unitTable } from './model.js';
import { injectionFormulas, PAYLOADS } from './payloads.js';

describe('compiled formula SQL holds only placeholders', () => {
  for (const payload of PAYLOADS) {
    it(`payload ${JSON.stringify(payload)}`, () => {
      const hostile = unitTable([{ name: payload, type: 'text' }], payload);
      const harmless = unitTable([{ name: 'Plain', type: 'text' }], 'Plain table');
      const formulas = injectionFormulas(payload, payload);
      const plain = injectionFormulas('Plain', 'x');
      formulas.forEach((formula, index) => {
        const bad = render(compileUnit(hostile, formula));
        const good = render(compileUnit(harmless, plain[index] as string));
        expect(bad.sql).toBe(good.sql);
        expect(bad.sql).not.toContain('DROP');
        expect(bad.sql).not.toContain('OR 1=1');
        expect(bad.sql).not.toContain('comment');
        const bound = bad.parameters.flat();
        expect(bound.some((value) => typeof value === 'string' && value.includes(payload))).toBe(
          true,
        );
      });
    });
  }
});
