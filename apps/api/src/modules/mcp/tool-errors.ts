import { Buffer } from 'node:buffer';

import {
  MCP_TOOL_ERROR_MAX_BYTES,
  MCP_TOOL_ERROR_TEXT_MAX_CHARS,
  MCP_TOOL_ERRORS_MAX,
  MCP_TOOL_ERRORS_UNKNOWN_KEYS_MAX,
  problemTitle,
  type McpToolError,
  type ProblemErrorItem,
} from '@cellhive/contracts';

import { resolveProblem } from '../../common/errors/problem-mapping.js';

import { dataResult } from './envelope.js';
import { cutText } from './shape.js';

import type { CallToolResult } from '@modelcontextprotocol/server';

/** One message for every `NOT_FOUND`: missing, another organization, outside `base_ids`, not readable. */
export const MCP_NOT_FOUND_MESSAGE = 'Not found, or not accessible with this API token.';

/** The id of an input record of a write (`update_records`): `records[3].id`. */
const RECORD_ID_PATH = /^records\[\d+\]\.id$/u;
/** The input record an item points into: `records[3]` of `records[3].fields.Name`. */
const RECORD_PATH = /^records\[\d+\]/u;
/** Items naming a key the input should not have: a field name, or a key of a strict object. */
const UNKNOWN_KEY_CODES: ReadonlySet<string> = new Set(['UNKNOWN_FIELD', 'UNRECOGNIZED_KEY']);

const clip = (text: string) => cutText(text, MCP_TOOL_ERROR_TEXT_MAX_CHARS) ?? text;

function clipped(value: unknown): unknown {
  if (typeof value === 'string') return clip(value);
  if (Array.isArray(value)) return value.map(clipped);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clipped(item)]));
  }
  return value;
}

function clippedItem(item: ProblemErrorItem): ProblemErrorItem {
  return {
    path: clip(item.path),
    code: item.code,
    message: clip(item.message),
    ...(item.params === undefined ? {} : { params: clipped(item.params) as typeof item.params }),
  };
}

/**
 * The items a tool error shows (CONTRACTS §30.1): at most
 * `MCP_TOOL_ERRORS_UNKNOWN_KEYS_MAX` unknown keys per input record of a
 * write (and as many for the rest of the input), at most
 * `MCP_TOOL_ERRORS_MAX` in all, in their order, long strings cut. The
 * error's `total` still counts every item.
 */
export function shownErrors(items: readonly ProblemErrorItem[]): ProblemErrorItem[] {
  const unknownKeys = new Map<string, number>();
  const shown: ProblemErrorItem[] = [];
  for (const item of items) {
    if (shown.length === MCP_TOOL_ERRORS_MAX) break;
    if (UNKNOWN_KEY_CODES.has(item.code)) {
      const record = RECORD_PATH.exec(item.path)?.[0] ?? '';
      const seen = unknownKeys.get(record) ?? 0;
      if (seen === MCP_TOOL_ERRORS_UNKNOWN_KEYS_MAX) continue;
      unknownKeys.set(record, seen + 1);
    }
    shown.push(clippedItem(item));
  }
  return shown;
}

const bytesOf = (result: CallToolResult) => Buffer.byteLength(JSON.stringify(result));

/**
 * The error result within `MCP_TOOL_ERROR_MAX_BYTES`: items left out from
 * the end while it is larger (the most that fit, by bisection), then the
 * message replaced by the code's title if even that is not enough.
 */
function fittedResult(payload: McpToolError): CallToolResult {
  const resultOf = (count: number, message = payload.message) =>
    dataResult({ ...payload, message, errors: payload.errors.slice(0, count) }, true);
  const whole = resultOf(payload.errors.length);
  if (bytesOf(whole) <= MCP_TOOL_ERROR_MAX_BYTES) return whole;
  let fits = 0;
  let over = payload.errors.length;
  while (over - fits > 1) {
    const middle = Math.floor((fits + over) / 2);
    if (bytesOf(resultOf(middle)) <= MCP_TOOL_ERROR_MAX_BYTES) fits = middle;
    else over = middle;
  }
  const fitted = resultOf(fits);
  return bytesOf(fitted) <= MCP_TOOL_ERROR_MAX_BYTES
    ? fitted
    : resultOf(0, problemTitle(payload.code));
}

/**
 * A failed tool call as a result with `isError` (CONTRACTS §30.1), so that
 * the model can correct its call: `{ code, message, errors, total,
 * retry_after? }` from the `AppError`, like a problem document, in a data
 * block like a successful result. `NOT_FOUND` keeps only the
 * `records[i].id` items of a write (the same item for every reason, T923).
 * Other errors become `INTERNAL` without their message; `onUnexpected` logs
 * them. The result stays within `MCP_TOOL_ERROR_MAX_BYTES`.
 */
export function toolErrorResult(
  error: unknown,
  onUnexpected: (error: unknown) => void,
): CallToolResult {
  const problem = resolveProblem(error);
  if (problem.unexpected) onUnexpected(error);
  const notFound = problem.code === 'NOT_FOUND';
  const items = (problem.errors ?? []).filter(
    (item) => !notFound || RECORD_ID_PATH.test(item.path),
  );
  return fittedResult({
    code: problem.code,
    message: notFound ? MCP_NOT_FOUND_MESSAGE : clip(problem.detail ?? problemTitle(problem.code)),
    errors: shownErrors(items),
    total: items.length,
    ...(problem.retryAfterSeconds === undefined ? {} : { retry_after: problem.retryAfterSeconds }),
  });
}
