import { afterEach, describe, expect, it } from 'vitest';

import {
  dismissFieldConversion,
  etaSeconds,
  fieldConversionOf,
  recordFieldConverting,
  resetFieldConversions,
  type FieldConvertingMessage,
} from '../field-conversions';

const FIELD = 'fld_Code000000000001';

function message(overrides: Partial<FieldConvertingMessage> = {}): FieldConvertingMessage {
  return {
    type: 'field.converting',
    channel: 'table:tbl_Orders0000000001',
    field_id: FIELD,
    job_id: 'job_0000000000000001',
    status: 'running',
    progress: 0,
    from_type: 'text',
    to_type: 'number',
    actor_id: 'usr_0000000000000001',
    ...overrides,
  };
}

afterEach(() => {
  resetFieldConversions();
});

describe('field conversions seen by the tab (T414)', () => {
  it('follows the progress and never goes back (two channels cross)', () => {
    recordFieldConverting(message({ progress: 0 }), 1_000);
    recordFieldConverting(message({ progress: 0.4 }), 3_000);
    recordFieldConverting(message({ channel: 'base:bse_Sales00000000001', progress: 0.2 }), 3_100);
    expect(fieldConversionOf(FIELD)).toMatchObject({
      status: 'running',
      progress: 0.4,
      endedAt: null,
    });
  });

  it('ends once; a late running echo of the other channel is ignored', () => {
    recordFieldConverting(message({ progress: 0.5 }), 1_000);
    recordFieldConverting(message({ status: 'succeeded', progress: 1 }), 2_000);
    recordFieldConverting(message({ progress: 0.9 }), 2_100);
    expect(fieldConversionOf(FIELD)).toMatchObject({ status: 'succeeded', endedAt: 2_000 });
    dismissFieldConversion(FIELD);
    expect(fieldConversionOf(FIELD)?.dismissed).toBe(true);
    // A new conversion of the field starts over.
    recordFieldConverting(message({ job_id: 'job_0000000000000002', progress: 0 }), 5_000);
    expect(fieldConversionOf(FIELD)).toMatchObject({ status: 'running', dismissed: false });
  });

  it('estimates the time left from the speed seen', () => {
    recordFieldConverting(message({ progress: 0.1 }), 0);
    expect(etaSeconds(fieldConversionOf(FIELD))).toBeNull();
    recordFieldConverting(message({ progress: 0.5 }), 4_000);
    // 0.4 in 4 s → 0.5 left in 5 s.
    expect(etaSeconds(fieldConversionOf(FIELD))).toBe(5);
    recordFieldConverting(message({ status: 'failed', progress: 1 }), 5_000);
    expect(etaSeconds(fieldConversionOf(FIELD))).toBeNull();
  });
});
