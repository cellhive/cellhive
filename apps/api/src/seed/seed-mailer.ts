import { EmailSendError, type Mailer, type MailSendResult } from '@cellhive/server-core';

/**
 * The mail service of `pnpm seed:demo` (BACKLOG T519): the seed keeps the
 * instance mail configuration — so a sample sender identity on the domain of
 * `SMTP_FROM` gets the `send_as` mode it would get through the API — but
 * never connects to an SMTP server or sends anything: every send and every
 * SMTP check fails as `smtp_not_configured`. Creating a sender identity
 * therefore records a failed verification email and leaves it `pending`
 * (the seed never verifies an identity, CONTRACTS §9), and invitations are
 * not mailed (`instanceConfigured` is `false`, as before T519).
 */
export class SeedMailer implements Mailer {
  readonly instanceConfigured = false;
  readonly instance = null;

  send(): Promise<MailSendResult> {
    return Promise.reject(notSent());
  }

  verify(): Promise<void> {
    return Promise.reject(notSent());
  }

  forgetIdentity(): void {
    // Nothing cached: no transport is ever opened.
  }

  close(): void {
    // Nothing to close.
  }
}

function notSent(): EmailSendError {
  return new EmailSendError('smtp_not_configured', 'The demo seed sends no email.', {
    retryable: false,
  });
}
