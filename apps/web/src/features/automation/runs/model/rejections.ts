/**
 * Refused email recipients, read for display (T556, QA S5 L1; CONTRACTS §21
 * `SendEmailRecipientErrorParams` and `recipients.rejected[]` of T541):
 * masked addresses and SMTP reply codes only — the server never stores the
 * server's text, so the reason shown is derived from the codes. Pure.
 */

type Json = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** A reply of the receiving server: `550` + `5.1.1`; either part may be missing. */
export interface SmtpReply {
  readonly code: number | null;
  readonly enhanced: string | null;
}

/** Why a recipient was refused, as the screen words it (`automationRuns:rejectionReason.<key>`). */
export const REJECTION_REASONS = [
  'mailbox_unknown',
  'domain_unknown',
  'bad_address',
  'mailbox_disabled',
  'mailbox_full',
  'too_large',
  'policy',
  'sender_rejected',
  'temporary',
  'invalid_address',
  'refused',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export interface RecipientRejection {
  /** `c***@example.com`; `null` when the server sent none (never reconstructed). */
  readonly masked: string | null;
  /** `invalid_address | smtp_temporary | smtp_rejected`, or `null` when unknown. */
  readonly code: string | null;
  readonly smtp: SmtpReply | null;
  readonly reason: RejectionReason;
}

const ENHANCED = /^([245])\.(\d{1,3})\.(\d{1,3})$/u;

function smtpOf(value: unknown): SmtpReply | null {
  if (!isObject(value)) return null;
  const code =
    typeof value['code'] === 'number' && Number.isInteger(value['code']) ? value['code'] : null;
  const enhanced =
    typeof value['enhanced'] === 'string' && ENHANCED.test(value['enhanced'])
      ? value['enhanced']
      : null;
  return code === null && enhanced === null ? null : { code, enhanced };
}

/**
 * The reason of an RFC 3463 enhanced status code (`5.1.1` → the mailbox does
 * not exist), `null` for codes that say nothing specific.
 */
function enhancedReason(enhanced: string): RejectionReason | null {
  const match = ENHANCED.exec(enhanced);
  if (match === null) return null;
  const [, klass, subject, detail] = match;
  if (klass === '4') return 'temporary';
  const key = `${subject ?? ''}.${detail ?? ''}`;
  switch (key) {
    case '1.1':
    case '1.6':
    case '1.10':
      return 'mailbox_unknown';
    case '1.2':
      return 'domain_unknown';
    case '1.3':
      return 'bad_address';
    case '1.7':
    case '1.8':
      return 'sender_rejected';
    case '2.1':
      return 'mailbox_disabled';
    case '2.2':
      return 'mailbox_full';
    case '2.3':
    case '3.4':
      return 'too_large';
    default:
      return subject === '7' ? 'policy' : null;
  }
}

/** The reason from the basic reply code alone (servers without enhanced codes). */
function basicReason(code: number): RejectionReason | null {
  if (code >= 400 && code < 500) return 'temporary';
  switch (code) {
    case 550:
    case 551:
      return 'mailbox_unknown';
    case 552:
      return 'mailbox_full';
    case 553:
      return 'bad_address';
    case 554:
      return 'policy';
    default:
      return null;
  }
}

/**
 * Why one recipient was refused: the enhanced code first (`5.1.1` beats the
 * generic `550`), then the basic code, then the engine's rejection code.
 */
export function rejectionReason(code: string | null, smtp: SmtpReply | null): RejectionReason {
  if (code === 'invalid_address') return 'invalid_address';
  const fromEnhanced = smtp?.enhanced == null ? null : enhancedReason(smtp.enhanced);
  if (fromEnhanced !== null) return fromEnhanced;
  const fromCode = smtp?.code == null ? null : basicReason(smtp.code);
  if (fromCode !== null) return fromCode;
  return code === 'smtp_temporary' ? 'temporary' : 'refused';
}

/** "550 5.1.1" / "550" / `null`. */
export function smtpReplyText(smtp: SmtpReply | null): string | null {
  if (smtp === null) return null;
  const parts = [smtp.code === null ? null : String(smtp.code), smtp.enhanced].filter(
    (part): part is string => part !== null,
  );
  return parts.length === 0 ? null : parts.join(' ');
}

/** `rejected[]` of a step output or of `error.params` (malformed items are dropped). */
export function rejectionsOf(value: unknown): RecipientRejection[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).map((item) => {
    const code = typeof item['code'] === 'string' ? item['code'] : null;
    const smtp = smtpOf(item['smtp']);
    return {
      masked: typeof item['masked'] === 'string' ? item['masked'] : null,
      code,
      smtp,
      reason: rejectionReason(code, smtp),
    };
  });
}

export interface RecipientFailure {
  /** The first refused recipients the server kept (≤ 50). */
  readonly rejected: readonly RecipientRejection[];
  /** Every refused recipient (≥ `rejected.length`). */
  readonly rejectedCount: number;
  /** Recipients accepted before the failure: the message reached none of them. */
  readonly acceptedCount: number;
}

/**
 * The refused recipients of a failed `send_email` step (`error.params`,
 * `SendEmailRecipientErrorParams` — T541), or `null` when the error carries
 * none (other errors, steps that failed before T541).
 */
export function recipientFailureOf(
  params: Readonly<Record<string, unknown>> | undefined,
): RecipientFailure | null {
  if (params === undefined || !Array.isArray(params['rejected'])) return null;
  const rejected = rejectionsOf(params['rejected']);
  const rejectedCount = Math.max(count(params['rejected_count']) ?? 0, rejected.length);
  if (rejectedCount === 0) return null;
  return { rejected, rejectedCount, acceptedCount: count(params['accepted_count']) ?? 0 };
}
