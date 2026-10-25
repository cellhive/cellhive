import { FILTER_DETAIL_CODES } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import { FILTER_ISSUE_CODES } from '../src/index.js';

describe('filter issue codes', () => {
  it('match the filter detail codes documented in the contracts (CONTRACTS §6)', () => {
    expect([...FILTER_ISSUE_CODES].sort()).toEqual([...FILTER_DETAIL_CODES].sort());
  });
});
