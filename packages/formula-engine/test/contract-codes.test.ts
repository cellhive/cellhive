import {
  FORMULA_LIMIT_DETAIL_CODES,
  FORMULA_SYNTAX_DETAIL_CODES,
  FORMULA_TYPE_DETAIL_CODES,
} from '@cellhive/contracts';
import { LOOKUP_FIELD_AGGREGATES } from '@cellhive/field-types';
import { describe, expect, it } from 'vitest';

import {
  FORMULA_LIMIT_ISSUE_CODES,
  FORMULA_SYNTAX_ISSUE_CODES,
  FORMULA_TYPE_ISSUE_CODES,
  LOOKUP_AGGREGATES,
} from '../src/index.js';

/**
 * The issue codes of this package are the detail codes of CONTRACTS §6
 * (T456 moved them there): the field API returns them in `errors[].code`
 * and the web app translates every one of them.
 */
describe('issue codes in the contracts (CONTRACTS §6)', () => {
  it('syntax and type codes are the contract lists', () => {
    expect([...FORMULA_SYNTAX_ISSUE_CODES]).toEqual([...FORMULA_SYNTAX_DETAIL_CODES]);
    expect([...FORMULA_TYPE_ISSUE_CODES]).toEqual([...FORMULA_TYPE_DETAIL_CODES]);
  });

  it('limit codes are the contract list without the server-only limits', () => {
    expect([...FORMULA_LIMIT_ISSUE_CODES, 'MAX_COMPUTED_FIELDS', 'MAX_COMPILED_SIZE']).toEqual([
      ...FORMULA_LIMIT_DETAIL_CODES,
    ]);
  });

  it('lookup aggregates are the options of lookup fields (field-types)', () => {
    expect([...LOOKUP_AGGREGATES]).toEqual([...LOOKUP_FIELD_AGGREGATES]);
  });
});
