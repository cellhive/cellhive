import { EMAIL_IDENTITY_AUTH_FAILURES_TO_ERROR } from '@cellhive/contracts';

import { AuditWriter } from '../../audit/audit-writer.js';
import { orgScope } from '../../db/repository.js';
import { emit } from '../../events/event-writer.js';
import { isEmailSendError } from '../smtp-errors.js';

import type { EmailIdentitiesRepository } from './email-identities.repository.js';
import type { AuditContext } from '../../audit/audit-entry.js';
import type { Db } from '../../db/create-db.js';
import type { Mailer } from '../mailer.js';
import type { MailTransportRef } from '../transport.js';
import type { Id } from '@cellhive/contracts';

const audit = new AuditWriter();

export interface IdentitySendOutcomeDeps {
  readonly db: Db;
  readonly identities: EmailIdentitiesRepository;
  readonly mailer: Pick<Mailer, 'forgetIdentity'>;
}

/**
 * What a send through an identity SMTP means for the identity (ADR-33 §1A):
 * - `ok` — sent; the consecutive authentication failure count restarts;
 * - `auth_failed` — the server refused the credentials; counted;
 * - `identity_error` — this failure was the `EMAIL_IDENTITY_AUTH_FAILURES_TO_ERROR`-th
 *   in a row: the identity is now `error` (`auth_failed`), audited
 *   `email_identity.error`, its transport closed. The run step fails with
 *   `email_identity_auth_failed`; the automation stays enabled;
 * - `other` — any other failure (not about the credentials).
 */
export type IdentitySendOutcome = 'ok' | 'auth_failed' | 'identity_error' | 'other';

/**
 * Records the result of `Mailer.send` with an identity transport (T514
 * calls it after each send; `error` is what `send` threw, `null` when it
 * returned). Messages through the instance SMTP are not tracked.
 */
export async function recordIdentitySendOutcome(
  deps: IdentitySendOutcomeDeps,
  organizationId: Id<'org'>,
  transport: MailTransportRef,
  error: unknown,
  context: AuditContext = {
    actor: { type: 'system', id: null },
    via: null,
    batch_id: null,
    request_id: null,
    ip: null,
    user_agent: null,
  },
): Promise<IdentitySendOutcome> {
  if (transport.kind !== 'identity') return error === null ? 'ok' : 'other';
  const identityId = transport.identityId as Id<'eid'>;
  if (error === null) {
    await deps.identities.resetAuthFailures(orgScope(organizationId), identityId);
    return 'ok';
  }
  if (!isEmailSendError(error) || error.reason !== 'auth_failed') return 'other';
  const result = await deps.db.withTx(async (tx) => {
    const scope = orgScope(organizationId, tx);
    const counted = await deps.identities.recordAuthFailure(
      scope,
      identityId,
      Number(transport.version),
      EMAIL_IDENTITY_AUTH_FAILURES_TO_ERROR,
    );
    if (counted?.becameError !== true) return counted === undefined ? 'other' : 'auth_failed';
    await emit(tx, {
      type: 'email_identity.error',
      organizationId,
      entityType: 'email_identity',
      entityId: identityId,
      actor: context.actor,
      data: { reason: 'auth_failed', smtp_code: error.smtp?.code ?? null },
    });
    await audit.write(tx, {
      action: 'email_identity.error',
      organizationId,
      baseId: null,
      entityType: 'email_identity',
      entityId: identityId,
      before: { status: 'verified' },
      after: {
        status: 'error',
        error_reason: 'auth_failed',
        smtp_code: error.smtp?.code ?? null,
        smtp_enhanced: error.smtp?.enhanced ?? null,
      },
      context,
    });
    return 'identity_error' as const;
  });
  if (result === 'identity_error') deps.mailer.forgetIdentity(identityId);
  return result;
}
