import { idOf } from '@cellhive/contracts';
import {
  isEmailSendError,
  sendForgotPasswordEmail,
  type ForgotPasswordDeps,
} from '@cellhive/server-core';
import { z } from 'zod';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

const payloadSchema = z.object({
  email: z.string().min(1).max(320),
  request_id: idOf('req').nullable(),
  ip: z.string().max(64).nullable(),
  user_agent: z.string().max(2048).nullable(),
});

export interface PasswordResetEmailDeps extends ForgotPasswordDeps {
  readonly logger: Logger;
}

/**
 * `auth.password_reset_email` (`POST /auth/forgot-password`): emails a
 * self-service reset link when SMTP is configured and the address belongs
 * to an active user with a password; otherwise completes without work.
 * A malformed payload is dropped. Temporary SMTP failures (`4xx`, network)
 * throw, so the job is retried; a rejection (`5xx`) is logged and not
 * retried (T513). Logs never carry the address or the link.
 */
export function createPasswordResetEmailTask(
  deps: PasswordResetEmailDeps,
): Task<'auth.password_reset_email'> {
  return async (payload, helpers) => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      deps.logger.warn({ job_id: helpers.job.id }, 'malformed password reset email payload');
      return;
    }
    let outcome: Awaited<ReturnType<typeof sendForgotPasswordEmail>>;
    try {
      outcome = await sendForgotPasswordEmail(deps, parsed.data);
    } catch (error) {
      if (isEmailSendError(error) && !error.retryable) {
        deps.logger.warn(
          { job_id: helpers.job.id, ...error.toLog() },
          'password reset email rejected by SMTP; not retried',
        );
        return;
      }
      throw error;
    }
    deps.logger.info({ job_id: helpers.job.id, outcome }, 'password reset email request handled');
  };
}
