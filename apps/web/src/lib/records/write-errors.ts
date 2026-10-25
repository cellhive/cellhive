import { isApiError, type ApiError } from '../api/client';

/** An `errors[]` item that explains why one cell was refused (CONTRACTS §6). */
export interface CellErrorDetail {
  readonly code: string;
  readonly message?: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/** Who wrote the record in the meantime (`VERSION_CONFLICT` params, CONTRACTS §1.4). */
export interface ConflictAuthor {
  readonly id: string;
  /** `null` when the writer is no longer a member of the organization. */
  readonly name: string | null;
}

/**
 * What the edit flow does with a failed write (FRONTEND §4.1 error table).
 * - `conflict`: refetch, show both values, offer to write again;
 * - `cell`: roll back and mark the cell (422);
 * - `denied`: roll back and explain (403);
 * - `not_found`: the record is gone or out of reach: drop the row;
 * - `schema_locked`: roll back, lock editing, retry later;
 * - `transient`: network or server trouble: keep the cell pending and retry;
 * - `fatal`: anything else: roll back and report.
 */
export type WriteFailure =
  | {
      readonly kind: 'conflict';
      readonly currentVersion: number | null;
      readonly updatedBy: ConflictAuthor | null;
      readonly updatedAt: string | null;
    }
  | { readonly kind: 'cell'; readonly error: ApiError; readonly detail: CellErrorDetail }
  | { readonly kind: 'denied'; readonly error: ApiError }
  | { readonly kind: 'not_found'; readonly error: ApiError }
  | { readonly kind: 'schema_locked'; readonly error: ApiError }
  | { readonly kind: 'transient'; readonly error: unknown }
  | { readonly kind: 'fatal'; readonly error: unknown };

/** `422` codes that mark the cell (FRONTEND §4.1). */
export const CELL_ERROR_CODES: ReadonlySet<string> = new Set([
  'INVALID_CELL_VALUE',
  'UNIQUE_VIOLATION',
  'REQUIRED_FIELD_MISSING',
  'INVALID_SELECT_OPTION',
  'LINK_TARGET_NOT_FOUND',
]);

/** `403` codes: the write is not allowed (field `read`, record rule, role). */
export const DENIED_CODES: ReadonlySet<string> = new Set([
  'FIELD_READ_ONLY',
  'RECORD_RULE_VIOLATION',
  'PERMISSION_DENIED',
  'INSUFFICIENT_SCOPE',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function conflictOf(error: ApiError): WriteFailure {
  const params = error.errors.find((item) => item.code === 'VERSION_CONFLICT')?.params ?? {};
  const version = params['current_version'];
  const author = params['updated_by'];
  const at = params['updated_at'];
  return {
    kind: 'conflict',
    currentVersion: typeof version === 'number' ? version : null,
    updatedBy:
      isRecord(author) && typeof author['id'] === 'string'
        ? { id: author['id'], name: typeof author['name'] === 'string' ? author['name'] : null }
        : null,
    updatedAt: typeof at === 'string' ? at : null,
  };
}

/**
 * The `errors[]` item about `fieldId` (path `records[0].fields.<fieldId>`),
 * else the first item, else the top-level code.
 */
function cellDetailOf(error: ApiError, fieldId: string): CellErrorDetail {
  const item =
    error.errors.find((candidate) => candidate.path.includes(fieldId)) ?? error.errors[0];
  if (item === undefined || item.code === error.code) {
    return { code: error.code, ...(item?.params ? { params: item.params } : {}) };
  }
  return {
    code: item.code,
    message: item.message,
    ...(item.params === undefined ? {} : { params: item.params }),
  };
}

/** A refused cell of a bulk request: `records[index].fields.<fieldId>`, or the whole record. */
export interface BulkCellError {
  readonly index: number;
  /** `null` when the item names the record only (`records[index]`). */
  readonly fieldId: string | null;
  readonly detail: CellErrorDetail;
}

const RECORD_PATH = /^records\[(\d+)\](?:\.fields(?:\.([^.[\]"]+)|\[("(?:[^"\\]|\\.)*")\]))?/u;

/**
 * The cells a `422` of a bulk `PATCH` names (FRONTEND §4.2): `errors[].path`
 * is `records[i].fields.<fieldId>` (CONTRACTS §6), or `records[i]` for a
 * problem of the whole record. Items with another path are left out.
 */
export function bulkCellErrors(error: ApiError): BulkCellError[] {
  return error.errors.flatMap((item) => {
    const match = RECORD_PATH.exec(item.path);
    if (match === null) return [];
    const plain = match[2];
    const quoted = match[3];
    const fieldId = plain ?? (quoted === undefined ? null : (JSON.parse(quoted) as string));
    const detail: CellErrorDetail =
      item.code === error.code
        ? { code: error.code, ...(item.params === undefined ? {} : { params: item.params }) }
        : {
            code: item.code,
            message: item.message,
            ...(item.params === undefined ? {} : { params: item.params }),
          };
    return [{ index: Number(match[1]), fieldId, detail }];
  });
}

/** Sorts a failed cell write into the rows of the FRONTEND §4.1 error table. */
export function classifyWriteError(error: unknown, fieldId: string): WriteFailure {
  if (!isApiError(error)) return { kind: 'fatal', error };
  if (error.code === 'NETWORK_ERROR' || error.status >= 500 || error.status === 429) {
    return { kind: 'transient', error };
  }
  if (error.code === 'VERSION_CONFLICT') return conflictOf(error);
  if (error.code === 'SCHEMA_LOCKED') return { kind: 'schema_locked', error };
  if (error.status === 404 || error.code === 'NOT_FOUND') return { kind: 'not_found', error };
  if (DENIED_CODES.has(error.code)) return { kind: 'denied', error };
  if (CELL_ERROR_CODES.has(error.code)) {
    return { kind: 'cell', error, detail: cellDetailOf(error, fieldId) };
  }
  return { kind: 'fatal', error };
}
