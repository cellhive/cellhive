import { z } from 'zod';

import { errorCodeSchema, problemErrorItemSchema } from './errors.js';
import { idOf } from './ids.js';

/**
 * Built-in MCP server (CONTRACTS §30, ADR-40, BACKLOG T920): `POST /api/v1/mcp`,
 * Streamable HTTP without sessions, API tokens only.
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

// --- Endpoint (CONTRACTS §30.1) -----------------------------------------------------

/** The only route of the MCP server; `GET`/`DELETE` answer `405`. */
export const MCP_PATH = '/api/v1/mcp';

/**
 * A JSON-RPC 2.0 message posted to the endpoint, for the OpenAPI document
 * only: the MCP SDK validates messages and answers JSON-RPC errors itself.
 */
export const mcpRequestSchema = z
  .looseObject({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.int()]).optional().meta({ description: 'Absent for notifications' }),
    method: z.string().meta({
      description:
        '`server/discover`, `tools/list`, `tools/call` (2026-07-28, `_meta` envelope on every ' +
        'request); `initialize` and `notifications/initialized` for 2025-era clients',
    }),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ id: 'McpRequest', description: 'JSON-RPC 2.0 request or notification (MCP)' });

/** A JSON-RPC 2.0 response (always `application/json`, never a session id). */
export const mcpResponseSchema = z
  .looseObject({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.int(), z.null()]),
    result: z.record(z.string(), z.unknown()).optional(),
    error: z
      .object({ code: z.int(), message: z.string(), data: z.unknown().optional() })
      .optional()
      .meta({
        description:
          '`-32602`: unknown or unlisted tool, bad params; `-32022`: unsupported protocol ' +
          'version; `-32020`: `Mcp-*` headers do not match the body',
      }),
  })
  .meta({ id: 'McpResponse', description: 'JSON-RPC 2.0 response (MCP)' });

// --- Tools (CONTRACTS §30.2+) ---------------------------------------------------------

/**
 * `isError` result of a tool call: an `AppError` as data, so that the model
 * can correct its call. `NOT_FOUND` has one message for every reason
 * (missing, another organization, outside `base_ids`, not readable).
 */
export const mcpToolErrorSchema = z
  .object({
    code: errorCodeSchema,
    message: z.string(),
    errors: z.array(problemErrorItemSchema),
    retry_after: z.int().min(1).optional().meta({ description: 'Seconds, when retrying helps' }),
  })
  .meta({ id: 'McpToolError' });
export type McpToolError = z.infer<typeof mcpToolErrorSchema>;

/** Most bases `list_bases` returns (`truncated` past it). */
export const MCP_LIST_BASES_LIMIT = 200;

/** `list_bases`: no input. */
export const listBasesInputSchema = z.strictObject({});

export const mcpBaseSchema = z.object({
  id: idOf('bse'),
  name: z.string(),
  description: z.string().nullable(),
  workspace: z.object({ id: idOf('wsp'), name: z.string() }),
});

/** `list_bases` result: bases the caller can open, by workspace then name. */
export const listBasesResultSchema = z.object({
  bases: z.array(mcpBaseSchema),
  truncated: z.boolean(),
});
export type ListBasesResult = z.infer<typeof listBasesResultSchema>;
