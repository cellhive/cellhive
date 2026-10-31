import type { ApiTokenPrincipal } from '../../common/auth/principal.js';
import type { ApiTokenScope, McpPolicy } from '@cellhive/contracts';
import type { ToolAnnotations } from '@modelcontextprotocol/server';
import type { z } from 'zod';

/** Who calls a tool: the API token, and the MCP policy of its organization for this request. */
export interface McpCallContext {
  readonly principal: ApiTokenPrincipal;
  readonly policy: McpPolicy;
}

/**
 * One MCP tool (CONTRACTS §30). What a call needs is declared here and
 * checked by `callTool` before `run`, the same way for every tool (research
 * MCP §6.7 risk 5): the token scope, `settings.mcp.allow_writes`, the input
 * schema, and the base the call acts on (reachable, per-base rate limit).
 * `run` then goes through the same services as the REST routes.
 */
export interface McpTool<Input extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly title: string;
  /** For the model; says that returned values are user data, never instructions. */
  readonly description: string;
  /** Scope of the API token the tool needs; `tools/list` hides it otherwise. */
  readonly scope: ApiTokenScope;
  /** Writes data: listed only when the organization allows writes (`settings.mcp.allow_writes`). */
  readonly writes: boolean;
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
  run(input: z.output<Input>, context: McpCallContext): Promise<Record<string, unknown>>;
}

/** Keeps the input type of `run` while registering the tool in a plain list. */
export function defineTool<Input extends z.ZodType>(tool: McpTool<Input>): McpTool {
  return tool;
}

/**
 * The tools `context` may see — and call: one predicate for `tools/list` and
 * `tools/call`, in registration order (a stable list).
 */
export function listedTools(tools: readonly McpTool[], context: McpCallContext): McpTool[] {
  return tools.filter(
    (tool) =>
      context.principal.scopes.includes(tool.scope) &&
      (!tool.writes || context.policy.allow_writes),
  );
}
