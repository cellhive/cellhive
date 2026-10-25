import { CELL_VALUE_DETAIL_CODES } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import { VALUE_ISSUE_CODES } from '../src/index.js';

describe('value issue codes', () => {
  it('match the cell detail codes documented in the contracts (CONTRACTS §6)', () => {
    expect([...VALUE_ISSUE_CODES].sort()).toEqual([...CELL_VALUE_DETAIL_CODES].sort());
  });
});
