import { maskAddress } from './address.js';

import type { EmailFailureCode, SmtpFailureReason } from '@cellhive/contracts';

/**
 * SMTP failure classification (BACKLOG T513, CONTRACTS §23):
 * `smtp_temporary` — `4xx`, network, timeout, TLS: retried;
 * `smtp_rejected` — `5xx` (authentication included): never retried.
 * Only codes are kept: never the server's text (it may echo addresses).
 */

/** Reply code and RFC 3463 enhanced status code of an SMTP answer. */
export interface SmtpReply {
  readonly code: number | null;
  readonly enhanced: string | null;
}

export interface SmtpFailure {
  readonly kind: 'smtp_temporary' | 'smtp_rejected';
  readonly reason: SmtpFailureReason;
  readonly retryable: boolean;
  readonly smtp: SmtpReply;
}

interface NodemailerLikeError {
  readonly code?: unknown;
  readonly responseCode?: unknown;
  readonly response?: unknown;
  readonly message?: unknown;
  readonly accepted?: unknown;
  readonly rejected?: unknown;
  readonly rejectedErrors?: unknown;
}

const ENHANCED = /\b([245]\.\d{1,3}\.\d{1,3})\b/;

/** `250 2.0.0 OK queued` → `{ code: 250, enhanced: '2.0.0' }`. */
export function smtpReplyOf(response: unknown, code?: unknown): SmtpReply {
  const text = typeof response === 'string' ? response : '';
  const numeric =
    typeof code === 'number' && code >= 200 && code <= 599
      ? code
      : /^([2-5]\d\d)\b/.test(text)
        ? Number(text.slice(0, 3))
        : null;
  return { code: numeric, enhanced: ENHANCED.exec(text)?.[1] ?? null };
}

const AUTH_CODES = new Set([530, 534, 535, 538]);
const CONNECTION_CODES = new Set([
  'ECONNECTION',
  'ESOCKET',
  'EDNS',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'EPROTOCOL',
  'EPROXY',
]);
const PERMANENT_CODES = new Set(['EENVELOPE', 'EMESSAGE', 'ESTREAM', 'ECONFIG', 'EMAXRECIPIENTS']);
const TLS_TEXT = /certificate|self[- ]signed|\btls\b|\bssl\b|starttls/i;

function asError(error: unknown): NodemailerLikeError {
  return typeof error === 'object' && error !== null ? error : {};
}

/** The reply that decides: the error's own, else a per-recipient one (a `4xx` wins). */
function decisiveReply(error: NodemailerLikeError): SmtpReply {
  const own = smtpReplyOf(error.response, error.responseCode);
  if (own.code !== null) return own;
  const replies = (Array.isArray(error.rejectedErrors) ? error.rejectedErrors : []).map((item) => {
    const nested = asError(item);
    return smtpReplyOf(nested.response, nested.responseCode);
  });
  return (
    replies.find((reply) => reply.code !== null && reply.code < 500) ??
    replies.find((reply) => reply.code !== null) ??
    own
  );
}

/** Classifies a nodemailer error (or anything thrown while sending). */
export function classifySmtpError(error: unknown): SmtpFailure {
  const err = asError(error);
  const code = typeof err.code === 'string' ? err.code : '';
  const message = typeof err.message === 'string' ? err.message : '';
  const smtp = decisiveReply(err);
  const temporary = (reason: SmtpFailureReason): SmtpFailure => ({
    kind: 'smtp_temporary',
    reason,
    retryable: true,
    smtp,
  });
  const rejected = (reason: SmtpFailureReason): SmtpFailure => ({
    kind: 'smtp_rejected',
    reason,
    retryable: false,
    smtp,
  });
  // SSRF guard of identity SMTP hosts (T530): never retried, the host must change.
  if (code === 'EHOSTBLOCKED') return rejected('host_not_allowed');
  // A TLS failure wins over the reply code (e.g. `502` to a STARTTLS the server lacks).
  if (code === 'ETLS' || code === 'EREQUIRETLS' || code.startsWith('ERR_TLS')) {
    return temporary('tls_failed');
  }
  if (smtp.code !== null && smtp.code >= 400 && smtp.code < 500) {
    return temporary(code === 'EAUTH' ? 'auth_failed' : 'temporary');
  }
  if (smtp.code !== null && smtp.code >= 500) {
    return rejected(code === 'EAUTH' || AUTH_CODES.has(smtp.code) ? 'auth_failed' : 'rejected');
  }
  if (code === 'EAUTH' || code === 'ENOAUTH') return rejected('auth_failed');
  if (code === 'ETIMEDOUT') return temporary('timeout');
  if (CONNECTION_CODES.has(code)) {
    return temporary(TLS_TEXT.test(message) ? 'tls_failed' : 'connection_failed');
  }
  if (PERMANENT_CODES.has(code)) return rejected('rejected');
  if (TLS_TEXT.test(message)) return temporary('tls_failed');
  return temporary('unknown');
}

export interface EmailSendErrorOptions {
  readonly retryable: boolean;
  readonly reason?: SmtpFailureReason | null;
  readonly smtp?: SmtpReply | null;
  /** When to try again (`email_quota_exceeded`). */
  readonly retryAt?: Date | null;
  /** Masked recipients the message could not go to. */
  readonly rejected?: readonly RejectedRecipient[];
  /** Recipients the server had accepted before the failure (default 0). */
  readonly acceptedCount?: number;
}

export interface RejectedRecipient {
  /** `a***@example.com`. */
  readonly masked: string;
  readonly code: 'invalid_address' | 'smtp_temporary' | 'smtp_rejected';
  readonly smtp: SmtpReply | null;
}

/**
 * A message that was not sent. `code` is one of CONTRACTS §23
 * `EMAIL_FAILURE_CODES`; `message` is a fixed English sentence without
 * addresses, subjects or server text, safe to log.
 */
export class EmailSendError extends Error {
  readonly code: EmailFailureCode;
  readonly retryable: boolean;
  readonly reason: SmtpFailureReason | null;
  readonly smtp: SmtpReply | null;
  readonly retryAt: Date | null;
  readonly rejected: readonly RejectedRecipient[];
  /** Recipients the server had accepted before the failure: the message reached none of them. */
  readonly acceptedCount: number;

  constructor(code: EmailFailureCode, message: string, options: EmailSendErrorOptions) {
    // No `cause`: the transport's error text may carry addresses.
    super(message);
    this.name = 'EmailSendError';
    this.code = code;
    this.retryable = options.retryable;
    this.reason = options.reason ?? null;
    this.smtp = options.smtp ?? null;
    this.retryAt = options.retryAt ?? null;
    this.rejected = options.rejected ?? [];
    this.acceptedCount = options.acceptedCount ?? 0;
  }

  /** Loggable summary: codes only. */
  toLog(): Record<string, unknown> {
    return {
      code: this.code,
      retryable: this.retryable,
      reason: this.reason,
      smtp_code: this.smtp?.code ?? null,
      smtp_enhanced: this.smtp?.enhanced ?? null,
    };
  }
}

export function isEmailSendError(error: unknown): error is EmailSendError {
  return error instanceof EmailSendError;
}

/**
 * Recipients the server refused at `RCPT TO`, masked, with their reply
 * (`4xx` → `smtp_temporary`, else `smtp_rejected`) — from a send result or
 * from the error of a send every recipient was refused (`EENVELOPE`).
 */
export function refusedRecipients(source: unknown): RejectedRecipient[] {
  const err = asError(source);
  const errors = Array.isArray(err.rejectedErrors) ? (err.rejectedErrors as unknown[]) : [];
  return (Array.isArray(err.rejected) ? (err.rejected as unknown[]) : []).map(
    (address, index): RejectedRecipient => {
      const nested = asError(errors[index]);
      const smtp = smtpReplyOf(nested.response, nested.responseCode);
      return {
        masked: maskAddress(typeof address === 'string' ? address : String(address)),
        code: smtp.code !== null && smtp.code < 500 ? 'smtp_temporary' : 'smtp_rejected',
        smtp,
      };
    },
  );
}

/**
 * Wraps a transport failure. `invalid`: recipients left out before
 * connecting (`invalid_address`), listed first in `rejected` with the
 * recipients the server refused (QA S5 L1 — never the server's text).
 */
export function smtpSendError(
  error: unknown,
  invalid: readonly RejectedRecipient[] = [],
): EmailSendError {
  const failure = classifySmtpError(error);
  const accepted = asError(error).accepted;
  return new EmailSendError(
    failure.kind,
    failure.retryable
      ? 'The SMTP server could not take the message now.'
      : 'The SMTP server rejected the message.',
    {
      retryable: failure.retryable,
      reason: failure.reason,
      smtp: failure.smtp,
      rejected: [...invalid, ...refusedRecipients(error)],
      acceptedCount: Array.isArray(accepted) ? accepted.length : 0,
    },
  );
}
