import { describe, expect, it } from 'vitest';

import {
  AUDIT_VIA_KINDS,
  createRecordsInputSchema,
  DEFAULT_MCP_POLICY,
  eventViaSchema,
  listBasesInputSchema,
  MCP_WRITE_RECORDS_MAX,
  orgAuditLogQuerySchema,
  organizationSettingsSchema,
  updateOrganizationRequestSchema,
  updateRecordsInputSchema,
} from '../src/index.js';
import { generateOpenApiDocument } from '../src/openapi/index.js';

const SETTINGS = { locale: 'vi', timezone: 'Asia/Ho_Chi_Minh', currency: 'VND' };

describe('MCP contracts (CONTRACTS §30, T920)', () => {
  it('defaults settings.mcp to off, writes off', () => {
    expect(DEFAULT_MCP_POLICY).toEqual({ enabled: false, allow_writes: false });
    const parsed = organizationSettingsSchema.parse({
      ...SETTINGS,
      public_sharing: 'allowed',
    });
    expect(parsed.mcp).toEqual({ enabled: false, allow_writes: false });
  });

  it.each([
    [{ settings: { mcp: { enabled: true } } }, true],
    [{ settings: { mcp: { allow_writes: false } } }, true],
    [{ settings: { mcp: {} } }, false],
    [{ settings: { mcp: { enabled: 'yes' } } }, false],
    [{ settings: { mcp: { enabled: true, read_only: true } } }, false],
  ])('PATCH /orgs/:id %j → valid %s', (body, valid) => {
    expect(updateOrganizationRequestSchema.safeParse(body).success).toBe(valid);
  });

  it('takes no input for list_bases', () => {
    expect(listBasesInputSchema.safeParse({}).success).toBe(true);
    expect(listBasesInputSchema.safeParse({ base_id: 'bse_x' }).success).toBe(false);
  });

  it('takes 1–50 records by field name to write (T923)', () => {
    const table_id = 'tbl_A1b2C3d4E5f6G7h8';
    const id = 'rec_A1b2C3d4E5f6G7h8';
    const many = (n: number) => Array.from({ length: n }, () => ({ fields: { Name: 'x' } }));
    expect(createRecordsInputSchema.safeParse({ table_id, records: many(1) }).success).toBe(true);
    expect(
      createRecordsInputSchema.safeParse({ table_id, records: many(MCP_WRITE_RECORDS_MAX) })
        .success,
    ).toBe(true);
    for (const records of [[], many(MCP_WRITE_RECORDS_MAX + 1), [{ fields: {}, typecast: true }]]) {
      expect(createRecordsInputSchema.safeParse({ table_id, records }).success).toBe(false);
    }
    expect(
      updateRecordsInputSchema.safeParse({ table_id, records: [{ id, fields: { Name: 'y' } }] })
        .success,
    ).toBe(true);
    // No upsert, no version, no record without its id.
    for (const record of [{ fields: {} }, { id, version: 2, fields: {} }]) {
      expect(updateRecordsInputSchema.safeParse({ table_id, records: [record] }).success).toBe(
        false,
      );
    }
  });

  it('marks writes through MCP in event via and filters the audit log by it (T923)', () => {
    const via = { api_token_id: 'tok_A1b2C3d4E5f6G7h8', mcp: true };
    expect(eventViaSchema.parse(via)).toEqual(via);
    expect(eventViaSchema.safeParse({ ...via, mcp: false }).success).toBe(false);
    expect(AUDIT_VIA_KINDS).toContain('mcp');
    expect(orgAuditLogQuerySchema.parse({ via: 'mcp' }).via).toEqual(['mcp']);
  });

  it('documents one token-only operation with the schema:read route scope', () => {
    const operation = generateOpenApiDocument().paths?.['/api/v1/mcp'];
    expect(Object.keys(operation ?? {})).toEqual(['post']);
    expect(operation?.post?.operationId).toBe('mcp');
    expect(operation?.post?.security).toEqual([{ apiToken: ['schema:read'] }]);
  });
});
