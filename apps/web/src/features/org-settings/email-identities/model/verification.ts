import {
  EMAIL_VERIFICATION_STEPS,
  type EmailVerificationOutcome,
  type EmailVerificationStep,
  type SmtpReplyDto,
  type SmtpSecurity,
} from '@cellhive/contracts';

/**
 * Result of sending a verification email (CONTRACTS §23.3) for the UI: the
 * steps of "Test & verify" (connect → TLS → sign in → send to the address
 * itself) and the message of a failure, keyed by the classified SMTP code.
 */

export type StepState = 'done' | 'failed' | 'skipped' | 'not_run';

export interface StepResult {
  readonly step: EmailVerificationStep;
  readonly state: StepState;
}

/**
 * Each step of an outcome. `security = none` has no TLS step (shown as
 * skipped); steps after the failed one did not run. `rate_limited` ran
 * nothing: `null`.
 */
export function verificationSteps(
  outcome: EmailVerificationOutcome,
  security: SmtpSecurity | null,
): StepResult[] | null {
  if (outcome.status === 'rate_limited') return null;
  const failedAt =
    outcome.status === 'failed' ? EMAIL_VERIFICATION_STEPS.indexOf(outcome.step) : -1;
  return EMAIL_VERIFICATION_STEPS.map((step, index): StepResult => {
    if (step === 'tls' && security === 'none' && failedAt !== index) {
      return { step, state: failedAt !== -1 && index > failedAt ? 'not_run' : 'skipped' };
    }
    if (failedAt === -1 || index < failedAt) return { step, state: 'done' };
    return { step, state: index === failedAt ? 'failed' : 'not_run' };
  });
}

/** Message keys of a failed send (`verify.failure.<key>`). */
export type FailureKey =
  | 'auth_failed'
  | 'send_as_denied'
  | 'host_not_allowed'
  | 'tls_failed'
  | 'connection_failed'
  | 'timeout'
  | 'smtp_not_configured'
  | 'rejected'
  | 'temporary'
  | 'unknown';

/**
 * Which message explains a failed outcome: `535`/AUTH → wrong user name or
 * password; `5.7.60` (Microsoft 365 "SendAsDenied") → the account may not
 * send as the address; then the classified reason.
 */
export function failureKey(
  outcome: Extract<EmailVerificationOutcome, { status: 'failed' }>,
): FailureKey {
  if (outcome.code === 'smtp_not_configured') return 'smtp_not_configured';
  if (outcome.smtp.enhanced === '5.7.60') return 'send_as_denied';
  switch (outcome.reason) {
    case 'auth_failed':
    case 'host_not_allowed':
    case 'tls_failed':
    case 'connection_failed':
    case 'timeout':
    case 'rejected':
    case 'temporary':
      return outcome.reason;
    default:
      return outcome.code === 'smtp_rejected' ? 'rejected' : 'unknown';
  }
}

/** `535 5.7.8` — the reply code and enhanced code, never the server's text. */
export function smtpCodeText(smtp: SmtpReplyDto): string | null {
  const parts = [smtp.code === null ? null : String(smtp.code), smtp.enhanced].filter(
    (part): part is string => part !== null,
  );
  return parts.length === 0 ? null : parts.join(' ');
}

/** The 6 digits typed or pasted (spaces, dashes and other characters dropped). */
export function normalizeCode(input: string): string {
  return input.replace(/\D/gu, '').slice(0, 6);
}
