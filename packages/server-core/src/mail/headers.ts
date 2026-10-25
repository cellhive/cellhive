import { createHash } from 'node:crypto';

/**
 * Headers every Cellhive email carries (ADR-32 §3, BACKLOG T513), test
 * emails included; they cannot be configured:
 * - `Auto-Submitted: auto-generated` (RFC 3834): responders must not answer;
 * - `X-Auto-Response-Suppress: OOF, AutoReply` (Exchange/Outlook): not `All`,
 *   which would also suppress the non-delivery reports we need;
 * - `X-Cellhive-Automation: <id>` on automation emails (opaque id, no name).
 * No `Sender` header is ever set.
 */

/** Where a message comes from; decides the headers and the quota it counts against. */
export type MailOrigin =
  /** Invitations, password resets, the connection test: no organization quota. */
  | { readonly kind: 'system' }
  /** Notification emails (T512): count against the organization quota. */
  | { readonly kind: 'notification'; readonly organizationId: string }
  /** Automation emails (T514): count against the organization quota. */
  | { readonly kind: 'automation'; readonly organizationId: string; readonly automationId: string };

export const AUTOMATION_HEADER = 'X-Cellhive-Automation';

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Headers of a message from `origin`. Throws on an id that is not opaque (never user text). */
export function mandatoryHeaders(origin: MailOrigin): Record<string, string> {
  const headers: Record<string, string> = {
    'Auto-Submitted': 'auto-generated',
    'X-Auto-Response-Suppress': 'OOF, AutoReply',
  };
  if (origin.kind === 'automation') {
    if (!OPAQUE_ID.test(origin.automationId)) {
      throw new TypeError('automationId must be an opaque id');
    }
    headers[AUTOMATION_HEADER] = origin.automationId;
  }
  return headers;
}

/**
 * Deterministic `Message-ID` for an idempotency key (`run_…:step…`), so a
 * retried send carries the same id and receivers can de-duplicate it. The
 * key is hashed: it never appears in the header.
 */
export function deterministicMessageId(idempotencyKey: string, domain: string): string {
  const hash = createHash('sha256').update(idempotencyKey, 'utf8').digest('hex').slice(0, 40);
  return `<ob.${hash}@${domain.toLowerCase()}>`;
}

/** `<left@right>` with printable ASCII only (no CR/LF, no spaces, no extra `<>`). */
export function isValidMessageId(value: string): boolean {
  return /^<[\x21-\x3b\x3d\x3f-\x7e]{1,200}@[A-Za-z0-9.-]{1,253}>$/.test(value);
}
