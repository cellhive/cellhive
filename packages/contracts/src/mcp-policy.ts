import { z } from 'zod';

/**
 * The organization's MCP policy (CONTRACTS §30.1, ADR-40), apart from the
 * tool schemas in `mcp.ts`: `orgs.ts` is in the app shell, and the tool
 * schemas pull in the table, view and record contracts.
 */

// --- Organization policy (CONTRACTS §30.1) -------------------------------------

const ALLOW_SCHEMA_WRITES_DESCRIPTION =
  'Off (default): the schema tools (`create_table`, `create_field`, `update_field`) are never ' +
  'listed nor callable, whatever the token scopes. On: listed for tokens with `schema:write`. ' +
  'Independent of `allow_writes`';

/**
 * `organizations.settings.mcp`: whether members may reach the MCP endpoint
 * with their API tokens, and which kinds of writing tools are listed —
 * record writes (`allow_writes`) and schema writes (`allow_schema_writes`,
 * T1014), each on its own. `allow_schema_writes` has a default: policies
 * stored before it existed (`{ enabled, allow_writes }`) still parse.
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
        'Off (default): the tools that write records (`create_records`, `update_records`) are ' +
        'never listed nor callable, whatever the token scopes. On: listed for tokens with ' +
        '`records:write`',
    }),
    allow_schema_writes: z
      .boolean()
      .default(false)
      .meta({ description: ALLOW_SCHEMA_WRITES_DESCRIPTION }),
  })
  .meta({ id: 'McpPolicy' });
export type McpPolicy = z.infer<typeof mcpPolicySchema>;
export const DEFAULT_MCP_POLICY: McpPolicy = {
  enabled: false,
  allow_writes: false,
  allow_schema_writes: false,
};

/** `PATCH /orgs/:id { settings: { mcp } }`: keys left out keep their value. */
export const updateMcpPolicySchema = z
  .strictObject({
    enabled: mcpPolicySchema.shape.enabled.optional(),
    allow_writes: mcpPolicySchema.shape.allow_writes.optional(),
    allow_schema_writes: z
      .boolean()
      .optional()
      .meta({ description: ALLOW_SCHEMA_WRITES_DESCRIPTION }),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: 'At least one property is required',
  });
