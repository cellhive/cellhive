import { passwordResetEmail } from '../mail/templates.js';

import { PasswordResetLinks } from './password-reset-links.js';
import { auditForUser } from './user-audit.js';

import type { Db } from '../db/create-db.js';
import type { OrganizationsRepository } from '../db/repositories/organizations.repository.js';
import type { PasswordResetsRepository } from '../db/repositories/password-resets.repository.js';
import type { UsersRepository } from '../db/repositories/users.repository.js';
import type { PasswordResetEmailPayload } from '../jobs/tasks.js';
import type { Mailer } from '../mail/mailer.js';

export interface ForgotPasswordDeps {
  readonly db: Db;
  readonly users: UsersRepository;
  readonly organizations: OrganizationsRepository;
  readonly passwordResets: PasswordResetsRepository;
  /** `null`: email disabled (no `SMTP_URL`). */
  readonly mailer: Mailer | null;
  readonly publicUrl: string;
}

export type ForgotPasswordOutcome = 'sent' | 'skipped';

/**
 * The work behind `POST /auth/forgot-password` (job
 * `auth.password_reset_email`): the HTTP request only enqueues the job, so
 * its timing and response never depend on whether the account exists.
 *
 * Sends a self-service reset link when email is enabled and the address
 * belongs to an active user with a password; does nothing otherwise
 * (`skipped`). The link replaces earlier self-service links only, never
 * one issued by an administrator. Audited as
 * `auth.password_reset_requested` (method `email`) with the request's
 * client context. A failed send throws, so the job is retried with a new
 * link. Neither the address nor the link is logged or returned.
 */
export async function sendForgotPasswordEmail(
  deps: ForgotPasswordDeps,
  payload: PasswordResetEmailPayload,
): Promise<ForgotPasswordOutcome> {
  const mailer = deps.mailer;
  if (mailer === null) return 'skipped';
  const user = await deps.users.findByEmail(payload.email);
  if (user === undefined || user.status !== 'active' || user.password_hash === null) {
    return 'skipped';
  }
  const links = new PasswordResetLinks(deps.passwordResets, deps.publicUrl);
  const link = await deps.db.withTx(async (tx) => {
    const created = await links.create(tx, user.id, { source: 'self_service' });
    await auditForUser(tx, deps.organizations, user.id, {
      action: 'auth.password_reset_requested',
      entityType: 'user',
      entityId: user.id,
      after: { method: 'email', reset_id: created.resetId },
      context: {
        actor: { type: 'system', id: null },
        via: null,
        batch_id: null,
        request_id: payload.request_id,
        ip: payload.ip,
        user_agent: payload.user_agent,
      },
    });
    return created;
  });
  await mailer.send(
    passwordResetEmail(user.email, {
      locale: user.locale,
      displayName: user.display_name,
      resetUrl: link.url,
      expiresAt: link.expiresAt,
    }),
  );
  return 'sent';
}
