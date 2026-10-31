import { DEFAULT_MCP_POLICY, mcpPolicySchema, type McpPolicy } from '@cellhive/contracts';

import type { JsonValue } from '@cellhive/server-core';

/**
 * `organizations.settings.mcp` (CONTRACTS §30.1); a missing or unreadable
 * value is the default: MCP off, writes off.
 */
export function mcpPolicyOf(settings: JsonValue): McpPolicy {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    return DEFAULT_MCP_POLICY;
  }
  const parsed = mcpPolicySchema.safeParse(settings['mcp']);
  return parsed.success ? parsed.data : DEFAULT_MCP_POLICY;
}
