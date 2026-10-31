import { MCP_PATH, mcpRequestSchema, mcpResponseSchema } from '../../mcp.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

/**
 * The built-in MCP server (CONTRACTS §30.1, ADR-40, BACKLOG T920): one
 * operation; the tools are described by `tools/list`, not here. API tokens
 * only — `security` gets `apiToken` with the route scope from
 * `API_TOKEN_ROUTE_SCOPES`.
 */
export const registerMcpRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  registry.registerPath({
    method: 'post',
    path: MCP_PATH,
    operationId: 'mcp',
    tags: ['mcp'],
    summary: 'MCP server (Streamable HTTP, stateless)',
    description:
      'Model Context Protocol endpoint for MCP clients (Claude Code, Cursor, VS Code…). Serves ' +
      'the 2026-07-28 revision (`server/discover`, `_meta` envelope on every request) and ' +
      '2025-era clients (`initialize` without a session) on the same URL; answers are always ' +
      '`application/json`, never `Mcp-Session-Id`. `Authorization: Bearer cht_…` only: the ' +
      'session cookie is ignored. Tools are listed by the scopes of the token and ' +
      '`settings.mcp.allow_writes`; calling an unlisted tool is JSON-RPC `-32602`; a failed ' +
      'tool call is a result with `isError` and `{ code, message, errors }`. `GET` and `DELETE` ' +
      'answer `405`. Not idempotent (`Idempotency-Key` is ignored).',
    security: [],
    request: { body: { content: { 'application/json': { schema: mcpRequestSchema } } } },
    responses: {
      200: {
        description: 'JSON-RPC response',
        content: { 'application/json': { schema: mcpResponseSchema } },
      },
      202: { description: 'Notification accepted' },
      400: {
        description:
          'JSON-RPC error without a usable request (malformed message, `Mcp-*` headers that ' +
          'do not match the body)',
      },
      401: problem(
        '`UNAUTHENTICATED`, `TOKEN_REVOKED`, `TOKEN_EXPIRED` with ' +
          '`WWW-Authenticate: Bearer error="invalid_token"`: no Bearer token (a session cookie ' +
          'is not enough), or an invalid one',
      ),
      403: problem(
        '`MCP_DISABLED`: the organization of the token has not turned MCP on ' +
          '(`settings.mcp.enabled`); `INSUFFICIENT_SCOPE`: the token lacks `schema:read`; ' +
          '`PERMISSION_DENIED`: an `Origin` header other than the origin of the server',
      ),
      406: {
        description:
          'A 2025-era request whose `Accept` lacks `application/json` or `text/event-stream`',
      },
      413: problem('`PAYLOAD_TOO_LARGE`: body over 10 MiB'),
      415: problem('`UNSUPPORTED_MEDIA_TYPE`: send `application/json`'),
      429: problem(
        '`RATE_LIMITED` with `Retry-After`: more than 60 requests/s by the token (a tool call ' +
          'on a base over 20/s on that base is an `isError` result instead)',
      ),
    },
  });
};
