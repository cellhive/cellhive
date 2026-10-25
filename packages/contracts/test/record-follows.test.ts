import { describe, expect, it } from 'vitest';

import { ERROR_DETAIL_CODES, RECORD_FOLLOW_DETAIL_CODES } from '../src/error-details.js';
import {
  MAX_RECORD_FOLLOWS_PER_USER,
  RECORD_FOLLOW_SOURCES,
  recordFollowParamsSchema,
  recordFollowSchema,
  TOO_MANY_FOLLOWS,
} from '../src/record-follows.js';

const TBL = 'tbl_A1b2C3d4E5f6G7h8';
const REC = 'rec_A1b2C3d4E5f6G7h8';

/** CONTRACTS §22.5 (BACKLOG T543). */
describe('record follows contract', () => {
  it.each([
    [{ following: true, source: 'manual' }, true],
    [{ following: true, source: 'created' }, true],
    [{ following: true, source: 'assigned' }, true],
    [{ following: false, source: null }, true],
    [{ following: true, source: 'commented' }, false],
    [{ following: true }, false],
    [{ following: 'yes', source: null }, false],
    [{ following: false, source: null, muted: true }, false],
  ])('response %j → %s', (body, ok) => {
    expect(recordFollowSchema.safeParse(body).success).toBe(ok);
  });

  it.each([
    [{ tableId: TBL, recordId: REC }, true],
    [{ tableId: REC, recordId: REC }, false],
    [{ tableId: TBL, recordId: TBL }, false],
    [{ tableId: TBL, recordId: 'rec_short' }, false],
    [{ tableId: TBL, recordId: REC, extra: 1 }, false],
  ])('params %j → %s', (params, ok) => {
    expect(recordFollowParamsSchema.safeParse(params).success).toBe(ok);
  });

  it('documents the sources, the cap and the detail code', () => {
    expect(RECORD_FOLLOW_SOURCES).toEqual(['manual', 'created', 'assigned']);
    expect(MAX_RECORD_FOLLOWS_PER_USER).toBe(10_000);
    expect(RECORD_FOLLOW_DETAIL_CODES).toEqual([TOO_MANY_FOLLOWS]);
    expect(ERROR_DETAIL_CODES).toContain(TOO_MANY_FOLLOWS);
  });
});
