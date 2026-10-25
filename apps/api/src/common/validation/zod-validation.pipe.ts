import { AppError, zodIssuesToProblemErrors } from '@cellhive/server-core/errors';

import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/**
 * Validates a request part against a schema from `@cellhive/contracts`:
 * `@Body(new ZodValidationPipe(createThingSchema)) body: CreateThing`.
 * Failures become `422 VALIDATION_FAILED` with `errors[].path` such as
 * `records[0].fields.x` (CONTRACTS §6). Returns the parsed (transformed) value.
 */
export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    // `reportInput` lets the mapper tell "missing" from "wrong type"; the input
    // itself is never copied into the response.
    const result = this.schema.safeParse(value, { reportInput: true });
    if (!result.success) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'The request does not match the expected schema.',
        errors: zodIssuesToProblemErrors(result.error.issues),
      });
    }
    return result.data;
  }
}
