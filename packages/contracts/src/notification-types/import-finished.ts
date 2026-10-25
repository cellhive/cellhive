import { z } from 'zod';

import { idOf } from '../ids.js';

/** How a CSV/XLSX import ended (`import.finished`). */
export const IMPORT_FINISHED_STATUSES = ['succeeded', 'failed', 'cancelled'] as const;
export type ImportFinishedStatus = (typeof IMPORT_FINISHED_STATUSES)[number];

/**
 * `import.finished` (ADR-34 §4; produced from T548): to the person who
 * started a CSV/XLSX import, when its job ends (`entity_type = job`,
 * `table_id` = the table imported into). Counts only: records `created` and
 * `updated`, data rows that failed (`failed_rows`; a `succeeded` import may
 * have some).
 */
export const importFinishedDataSchema = z.strictObject({
  job_id: idOf('job'),
  status: z.enum(IMPORT_FINISHED_STATUSES),
  created: z.int().min(0),
  updated: z.int().min(0),
  failed_rows: z.int().min(0),
});
export type ImportFinishedData = z.infer<typeof importFinishedDataSchema>;
