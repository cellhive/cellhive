import { MAX_RECORDS_PER_REQUEST } from '@cellhive/contracts';
import { AppError } from '@cellhive/server-core/errors';

import { ZodValidationPipe } from './zod-validation.pipe.js';

import type { z } from 'zod';

/**
 * `ZodValidationPipe` for bulk bodies: a list under `key` longer than
 * 1 000 items is `413 PAYLOAD_TOO_LARGE` (CONTRACTS §6), checked before the
 * schema so that it is not reported as `422 TOO_BIG`.
 */
export class BatchBodyPipe<S extends z.ZodType> extends ZodValidationPipe<S> {
  constructor(
    schema: S,
    private readonly key: string,
    private readonly maxItems: number = MAX_RECORDS_PER_REQUEST,
  ) {
    super(schema);
  }

  override transform(value: unknown): z.output<S> {
    const list =
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)[this.key]
        : undefined;
    if (Array.isArray(list) && list.length > this.maxItems) {
      throw new AppError('PAYLOAD_TOO_LARGE', {
        detail: `At most ${String(this.maxItems)} items per request.`,
        errors: [
          {
            path: this.key,
            code: 'TOO_BIG',
            message: `At most ${String(this.maxItems)} items per request`,
            params: { maximum: this.maxItems },
          },
        ],
      });
    }
    return super.transform(value);
  }
}
