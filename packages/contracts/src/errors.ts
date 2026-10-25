import { z } from 'zod';

import { ERROR_CODES, ERROR_STATUS, problemTypeUri, type ErrorCode } from './error-codes.js';
import { idOf } from './ids.js';

export {
  ERROR_CODES,
  ERROR_STATUS,
  PROBLEM_CONTENT_TYPE,
  PROBLEM_TYPE_BASE,
  errorStatus,
  isErrorCode,
  problemTitle,
  problemTypeUri,
  type ErrorCode,
  type ErrorStatus,
} from './error-codes.js';

export const errorCodeSchema = z
  .enum(ERROR_CODES as [ErrorCode, ...ErrorCode[]])
  .meta({ id: 'ErrorCode', description: 'Error code from the catalogue (CONTRACTS §6)' });

/**
 * One entry of `errors[]`. `code` here is a detail code (e.g.
 * `EXPECTED_NUMBER`), not limited to the §6 catalogue.
 */
export const problemErrorItemSchema = z
  .object({
    path: z
      .string()
      .meta({ description: 'Location of the problem, e.g. `records[0].fields.Amount`' }),
    code: z
      .string()
      .meta({ description: 'Machine-readable detail code used by the UI for translation' }),
    message: z.string().meta({ description: 'English message' }),
    params: z
      .record(z.string(), z.unknown())
      .optional()
      .meta({ description: 'Parameters for translating the message, e.g. `position`, `limit`' }),
  })
  .meta({ id: 'ProblemErrorItem', description: 'Detail of one validation problem' });

export type ProblemErrorItem = z.infer<typeof problemErrorItemSchema>;

/**
 * RFC 9457 problem document (CONTRACTS §6). `status` and `type` must agree
 * with `code`.
 */
export const problemDetailsSchema = z
  .object({
    type: z.url().meta({ description: 'Problem type URI; ends with the code' }),
    title: z.string().meta({ description: 'Short English summary' }),
    status: z.int().meta({ description: 'HTTP status code' }),
    code: errorCodeSchema,
    detail: z.string().optional().meta({ description: 'English explanation for this occurrence' }),
    errors: z.array(problemErrorItemSchema).optional(),
    request_id: idOf('req'),
  })
  .superRefine((problem, ctx) => {
    if (problem.status !== ERROR_STATUS[problem.code]) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: `Status for ${problem.code} must be ${String(ERROR_STATUS[problem.code])}`,
      });
    }
    if (problem.type !== problemTypeUri(problem.code)) {
      ctx.addIssue({
        code: 'custom',
        path: ['type'],
        message: `Type for ${problem.code} must be ${problemTypeUri(problem.code)}`,
      });
    }
  })
  .meta({ id: 'ProblemDetails', description: 'Error response (RFC 9457 problem+json)' });

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
