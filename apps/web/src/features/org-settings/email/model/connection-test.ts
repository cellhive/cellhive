import type { EmailTestResult, SmtpFailureReason, SmtpReplyDto } from '@cellhive/contracts';

/**
 * Outcome of "Test connection" (CONTRACTS §23.2) as the page explains it:
 * one message per classified SMTP reason (`SMTP_FAILURE_REASONS`), the
 * server's reply code when there is one. Never the server's text (the API
 * does not return it).
 */
export interface ConnectionTestView {
  readonly ok: boolean;
  /** i18n key of the short message under `emailSettings:test`. */
  readonly messageKey: string;
  /** i18n key of the explanation / what to check. */
  readonly hintKey: string;
  /** "535 5.7.8", or `null` without a reply. */
  readonly reply: string | null;
}

/** "535 5.7.8" / "250" / `null`. */
export function replyText(smtp: SmtpReplyDto): string | null {
  if (smtp.code === null) return null;
  return smtp.enhanced === null ? String(smtp.code) : `${String(smtp.code)} ${smtp.enhanced}`;
}

const REASON_KEYS: Readonly<Record<SmtpFailureReason, string>> = {
  auth_failed: 'authFailed',
  host_not_allowed: 'hostNotAllowed',
  tls_failed: 'tlsFailed',
  connection_failed: 'connectionFailed',
  timeout: 'timeout',
  temporary: 'temporary',
  rejected: 'rejected',
  unknown: 'unknown',
};

export function connectionTestView(result: EmailTestResult): ConnectionTestView {
  if (result.status === 'sent') {
    return {
      ok: true,
      messageKey: 'test.sent.title',
      hintKey: 'test.sent.body',
      reply: replyText(result.smtp),
    };
  }
  const key = REASON_KEYS[result.reason];
  return {
    ok: false,
    messageKey: `test.failed.${key}.title`,
    hintKey: `test.failed.${key}.hint`,
    reply: replyText(result.smtp),
  };
}

/** Window of `EMAIL_TEST_SEND_PER_MIN` (per user per minute, CONTRACTS §23.2). */
export const TEST_WINDOW_MS = 60_000;

/**
 * Tests left in the current minute, as far as this page knows: the API
 * does not return the remaining count, so the page counts the tests it
 * sent in the last minute (another tab's tests show up as a `429`).
 */
export function testsLeft(sentAt: readonly number[], limit: number, now: number): number {
  const recent = sentAt.filter((time) => now - time < TEST_WINDOW_MS).length;
  return Math.max(0, limit - recent);
}
