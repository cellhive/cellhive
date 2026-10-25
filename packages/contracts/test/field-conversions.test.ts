import { describe, expect, it } from 'vitest';

import {
  convertFieldPreviewRequestSchema,
  convertFieldRequestSchema,
  FIELD_CONVERSION_DETAIL_CODES,
  realtimeServerMessageSchema,
  revertConversionRequestSchema,
  SCHEMA_CHANGE_ACTIONS,
} from '../src/index.js';

describe('field conversion contracts (T403)', () => {
  it('parses preview and conversion bodies strictly', () => {
    expect(
      convertFieldPreviewRequestSchema.safeParse({
        type: 'select',
        options: { multiple: false },
        conversion: { match_existing_only: true },
      }).success,
    ).toBe(true);
    expect(
      convertFieldPreviewRequestSchema.safeParse({ type: 'number', confirm: true }).success,
    ).toBe(false);
    expect(
      convertFieldRequestSchema.safeParse({
        type: 'number',
        confirm: true,
        accept_data_loss: false,
      }).success,
    ).toBe(true);
    expect(
      convertFieldRequestSchema.safeParse({ type: 'checkbox', conversion: { truthy_values: [] } })
        .success,
    ).toBe(false);
  });

  it('defaults a revert to keeping later edits', () => {
    expect(revertConversionRequestSchema.parse({})).toEqual({ mode: 'keep_later_edits' });
    expect(revertConversionRequestSchema.safeParse({ mode: 'drop' }).success).toBe(false);
  });

  it('names the conversion detail codes, the converted action and field.converting', () => {
    expect(FIELD_CONVERSION_DETAIL_CODES).toContain('FIELD_CONVERTING');
    expect(SCHEMA_CHANGE_ACTIONS).toContain('converted');
    expect(
      realtimeServerMessageSchema.safeParse({
        type: 'field.converting',
        channel: 'table:tbl_A1b2C3d4E5f6G7h8',
        field_id: 'fld_A1b2C3d4E5f6G7h8',
        job_id: 'job_A1b2C3d4E5f6G7h8',
        status: 'running',
        progress: 0.5,
        from_type: 'text',
        to_type: 'number',
        actor_id: null,
      }).success,
    ).toBe(true);
  });
});
