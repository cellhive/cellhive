import type { ApiTokenPrincipal } from '../../common/auth/principal.js';
import type { RequestMeta } from '../../common/auth/request-meta.js';
import type { ApiTokenScope, Id, McpPolicy } from '@cellhive/contracts';
import type { ToolAnnotations } from '@modelcontextprotocol/server';
import type { z } from 'zod';

/** Who calls a tool: the API token, and the MCP policy of its organization for this request. */
export interface McpCallContext {
  readonly principal: ApiTokenPrincipal;
  readonly policy: McpPolicy;
  /** The HTTP request (with `mcp: true`), for audit entries: `via = { api_token_id, mcp: true }`. */
  readonly meta: RequestMeta;
}

/** What `run` gets: the call context and the base `resource` resolved to (none without one). */
export interface McpRunContext extends McpCallContext {
  readonly baseId: Id<'bse'> | undefined;
}

/**
 * What a tool writes (CONTRACTS §30.1, ADR-40 amendment of T1014): nothing,
 * records (listed only with `settings.mcp.allow_writes`) or the schema
 * (listed only with `settings.mcp.allow_schema_writes`, its own rate limit).
 * The two policy switches are independent.
 */
export type McpWriteKind = false | 'records' | 'schema';

/**
 * One MCP tool (CONTRACTS §30). What a call needs is declared here and
 * checked by `callTool` before `run`, the same way for every tool (research
 * MCP §6.7 risk 5): the token scope, the policy switch of its write kind,
 * the input schema, and the base the call acts on (reachable, per-base rate
 * limit); a write tool's `idempotency_key` is handled there too. `run` then
 * goes through the same services as the REST routes.
 */
export interface McpTool<Input extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly title: string;
  /** For the model; says that returned values are user data, never instructions. */
  readonly description: string;
  /** Scope of the API token the tool needs; `tools/list` hides it otherwise. */
  readonly scope: ApiTokenScope;
  /**
   * What it writes: `records` tools are listed only with
   * `settings.mcp.allow_writes`, `schema` tools only with
   * `settings.mcp.allow_schema_writes`. A write tool takes an optional
   * `idempotency_key` (`IdempotencyService`, per token).
   */
  readonly writes: McpWriteKind;
  readonly input: Input;
  readonly annotations: ToolAnnotations;
  /**
   * Route parameters naming what the call acts on, as `RouteScopeService`
   * reads them (`{ baseId }`, `{ tableId }`…): unreachable → `NOT_FOUND`
   * before `run`; the base counts against the per-base rate limit. Absent
   * for tools on no base (`list_bases`).
   */
  resource?(input: z.output<Input>): Readonly<Record<string, string>>;
  /** The result, sent as `structuredContent` and as text in a data block (`envelope.ts`). */
  run(input: z.output<Input>, context: McpRunContext): Promise<Record<string, unknown>>;
}

/** Keeps the input type of `run` while registering the tool in a plain list. */
export function defineTool<Input extends z.ZodType>(tool: McpTool<Input>): McpTool {
  return tool;
}

/** Whether the organization's MCP policy lets tools of this write kind be listed. */
export function allowedByPolicy(writes: McpWriteKind, policy: McpPolicy): boolean {
  if (writes === 'records') return policy.allow_writes;
  if (writes === 'schema') return policy.allow_schema_writes;
  return true;
}

/**
 * The tools `context` may see — and call: one predicate for `tools/list` and
 * `tools/call`, in registration order (a stable list): the token has the
 * tool's scope, and the policy switch of its write kind is on.
 */
export function listedTools(tools: readonly McpTool[], context: McpCallContext): McpTool[] {
  return tools.filter(
    (tool) =>
      context.principal.scopes.includes(tool.scope) && allowedByPolicy(tool.writes, context.policy),
  );
}
