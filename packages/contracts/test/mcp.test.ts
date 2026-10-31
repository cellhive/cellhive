import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MCP_POLICY,
  listBasesInputSchema,
  organizationSettingsSchema,
  updateOrganizationRequestSchema,
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

  it('documents one token-only operation with the schema:read route scope', () => {
    const operation = generateOpenApiDocument().paths?.['/api/v1/mcp'];
    expect(Object.keys(operation ?? {})).toEqual(['post']);
    expect(operation?.post?.operationId).toBe('mcp');
    expect(operation?.post?.security).toEqual([{ apiToken: ['schema:read'] }]);
  });
});
