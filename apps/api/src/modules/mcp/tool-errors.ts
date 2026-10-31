import { problemTitle, type McpToolError } from '@cellhive/contracts';

import { resolveProblem } from '../../common/errors/problem-mapping.js';

import type { CallToolResult } from '@modelcontextprotocol/server';

/** One message for every `NOT_FOUND`: missing, another organization, outside `base_ids`, not readable. */
export const MCP_NOT_FOUND_MESSAGE = 'Not found, or not accessible with this API token.';

/** The id of an input record of a write (`update_records`): `records[3].id`. */
const RECORD_ID_PATH = /^records\[\d+\]\.id$/u;

/**
 * A failed tool call as a result with `isError` (CONTRACTS §30.1), so that
 * the model can correct its call: `{ code, message, errors, retry_after? }`
 * from the `AppError`, like a problem document. `NOT_FOUND` keeps only the
 * `records[i].id` items of a write (the same item for every reason, T923).
 * Other errors become `INTERNAL` without their message; `onUnexpected` logs them.
 */
export function toolErrorResult(
  error: unknown,
  onUnexpected: (error: unknown) => void,
): CallToolResult {
  const problem = resolveProblem(error);
  if (problem.unexpected) onUnexpected(error);
  const notFound = problem.code === 'NOT_FOUND';
  const payload: McpToolError = {
    code: problem.code,
    message: notFound ? MCP_NOT_FOUND_MESSAGE : (problem.detail ?? problemTitle(problem.code)),
    errors: (problem.errors ?? []).filter((item) => !notFound || RECORD_ID_PATH.test(item.path)),
    ...(problem.retryAfterSeconds === undefined ? {} : { retry_after: problem.retryAfterSeconds }),
  };
  return {
    isError: true,
    structuredContent: payload,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}
