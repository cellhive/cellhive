import { z } from 'zod';

import { isoDateTimeSchema } from './common.js';
import { idOf } from './ids.js';

/** Background jobs users follow with `GET /jobs/:id` (CONTRACTS §1.1, §12.2). */

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type JobStatusName = (typeof JOB_STATUSES)[number];

/** `202 { job_id }` of an endpoint that starts a background job. */
export const jobAcceptedSchema = z
  .strictObject({ job_id: idOf('job') })
  .meta({ id: 'JobAccepted' });
export type JobAccepted = z.infer<typeof jobAcceptedSchema>;

export const jobSchema = z
  .strictObject({
    id: idOf('job'),
    type: z.string().meta({ description: 'e.g. `audit.export`, `base.export`' }),
    status: z.enum(JOB_STATUSES),
    progress: z.number().min(0).max(1),
    result: z.record(z.string(), z.unknown()).nullable().meta({
      description:
        'Outcome of a succeeded job, e.g. `{ "download_url", "expires_at", "size" }` for exports',
    }),
    error: z
      .record(z.string(), z.unknown())
      .nullable()
      .meta({ description: 'problem+json of a failed job' }),
    created_at: isoDateTimeSchema,
    started_at: isoDateTimeSchema.nullable(),
    finished_at: isoDateTimeSchema.nullable(),
  })
  .meta({ id: 'Job' });
export type JobDto = z.infer<typeof jobSchema>;
