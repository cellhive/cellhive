import { z } from 'zod';

/**
 * The organization's MCP policy (CONTRACTS §30.1, ADR-40), apart from the
 * tool schemas in `mcp.ts`: `orgs.ts` is in the app shell, and the tool
 * schemas pull in the table, view and record contracts.
 */

// --- Organization policy (CONTRACTS §30.1) -------------------------------------

/**
 * `organizations.settings.mcp`: whether members may reach the MCP endpoint
 * with their API tokens, and whether tools that write are listed.
 */
export const mcpPolicySchema = z
  .object({
    enabled: z.boolean().meta({
      description:
        'Off (default): `POST /api/v1/mcp` answers `403 MCP_DISABLED` before any JSON-RPC. On: ' +
        'members bring the data they can read to the LLM of the MCP client they choose',
    }),
    allow_writes: z.boolean().meta({
      description:
        'Off (default): tools that write are never listed nor callable, whatever the token ' +
        'scopes. On: listed for tokens with `records:write`',
    }),
  })
  .meta({ id: 'McpPolicy' });
export type McpPolicy = z.infer<typeof mcpPolicySchema>;
export const DEFAULT_MCP_POLICY: McpPolicy = { enabled: false, allow_writes: false };

/** `PATCH /orgs/:id { settings: { mcp } }`: keys left out keep their value. */
export const updateMcpPolicySchema = z
  .strictObject({
    enabled: mcpPolicySchema.shape.enabled.optional(),
    allow_writes: mcpPolicySchema.shape.allow_writes.optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: 'At least one property is required',
  });
