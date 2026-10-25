import { z } from 'zod';

/** Offset lists (CONTRACTS §1.1). */
export const DEFAULT_LIST_LIMIT = 50;
/** Record lists (CONTRACTS §1.1). */
export const DEFAULT_RECORD_LIMIT = 200;
/** Upper bound for offset and record lists (CONTRACTS §1.1). */
export const MAX_LIST_LIMIT = 1000;
/** Most record ids in one `POST …/records/query` (`ids`). */
export const MAX_QUERY_IDS = 1000;
/** Cursor lists: audit, history, trash (CONTRACTS §11). */
export const DEFAULT_CURSOR_LIMIT = 50;
export const MAX_CURSOR_LIMIT = 200;
/** Above this row count record lists return `total_estimate` instead of `total` (SPEC §7.1). */
export const EXACT_TOTAL_THRESHOLD = 100_000;

function limitParam(defaultLimit: number, maxLimit: number) {
  return z.coerce
    .number()
    .int()
    .min(1)
    .max(maxLimit)
    .default(defaultLimit)
    .meta({ description: `Page size (default ${String(defaultLimit)}, max ${String(maxLimit)})` });
}

const offsetParam = z.coerce
  .number()
  .int()
  .min(0)
  .default(0)
  .meta({ description: 'Number of items to skip' });

/** `?offset=&limit=` for offset lists. */
export const offsetQuerySchema = z.object({
  offset: offsetParam,
  limit: limitParam(DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT),
});
export type OffsetQuery = z.infer<typeof offsetQuerySchema>;

/** `?offset=&limit=` for record lists. */
export const recordOffsetQuerySchema = z.object({
  offset: offsetParam,
  limit: limitParam(DEFAULT_RECORD_LIMIT, MAX_LIST_LIMIT),
});
export type RecordOffsetQuery = z.infer<typeof recordOffsetQuerySchema>;

/** `?cursor=&limit=` for cursor lists. The cursor is opaque to clients. */
export const cursorQuerySchema = z.object({
  cursor: z.string().min(1).optional().meta({ description: 'Opaque cursor from `next_cursor`' }),
  limit: limitParam(DEFAULT_CURSOR_LIMIT, MAX_CURSOR_LIMIT),
});
export type CursorQuery = z.infer<typeof cursorQuerySchema>;

const countSchema = z.int().min(0);
const offsetSchema = z.int().min(0);
const pageLimitSchema = z.int().min(1).max(MAX_LIST_LIMIT);

/** `{ items, total, offset, limit }`. */
export function offsetListSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    total: countSchema,
    offset: offsetSchema,
    limit: pageLimitSchema,
  });
}

/**
 * `{ records, total | total_estimate, offset, limit }`. Exactly one of
 * `total` (exact count) or `total_estimate` (above 100,000 rows) is present.
 */
export function recordListSchema<T extends z.ZodType>(record: T) {
  const page = {
    records: z.array(record),
    offset: offsetSchema,
    limit: pageLimitSchema,
  };
  return z.union([
    z.strictObject({ ...page, total: countSchema }),
    z.strictObject({
      ...page,
      total_estimate: countSchema.meta({ description: 'Approximate row count' }),
    }),
    z.strictObject(page).meta({ description: 'Without a count (`include_total: false`)' }),
  ]);
}

const nextCursorSchema = z
  .string()
  .min(1)
  .nullable()
  .meta({ description: 'Cursor for the next page, `null` on the last page' });

/** `{ items, next_cursor }` — no `total`. */
export function cursorListSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), next_cursor: nextCursorSchema });
}

/** `{ records, next_cursor }` — no `total` (e.g. record trash). */
export function cursorRecordListSchema<T extends z.ZodType>(record: T) {
  return z.object({ records: z.array(record), next_cursor: nextCursorSchema });
}
