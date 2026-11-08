import { newId, type Id } from '@cellhive/contracts';

/**
 * Users in a `.chbase` package (ADR-24 §2.5 and its 2026-11 amendment): a
 * package never holds a user id. Every user reference — a user cell, who
 * created or changed a record, a default user, a reminder recipient, a
 * user in a filter, an automation recipient — is the user's email; an
 * import maps the email to a member of the **target organization** only
 * (never to a user of the instance outside it, which would tell the
 * importer who exists elsewhere).
 */

/** Domain of the placeholder emails of users the source no longer knows (RFC 2606). */
export const UNKNOWN_USER_EMAIL_DOMAIN = 'cellhive.invalid';

/** Emails are compared like `meta.users.email` (`citext`): trimmed, case-insensitive. */
export function normalizePackageEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Whether `email` is a placeholder of the export, not someone's address. */
export function isUnknownUserEmail(email: string): boolean {
  return normalizePackageEmail(email).endsWith(`@${UNKNOWN_USER_EMAIL_DOMAIN}`);
}

/**
 * Export side: user id → email. A user id with no user behind it gets a
 * placeholder `unknown-<n>@cellhive.invalid`, one per id, so the package
 * keeps that two references were the same person without holding the id.
 */
export class PackageUserEmails {
  private readonly emails: ReadonlyMap<string, string>;
  private readonly placeholders = new Map<string, string>();

  constructor(emailsByUserId: ReadonlyMap<string, string> | Iterable<readonly [string, string]>) {
    this.emails = emailsByUserId instanceof Map ? emailsByUserId : new Map(emailsByUserId);
  }

  emailOf(userId: string): string {
    const email = this.emails.get(userId);
    if (email !== undefined) return email;
    let placeholder = this.placeholders.get(userId);
    if (placeholder === undefined) {
      placeholder = `unknown-${String(this.placeholders.size + 1)}@${UNKNOWN_USER_EMAIL_DOMAIN}`;
      this.placeholders.set(userId, placeholder);
    }
    return placeholder;
  }

  emailOrNull(userId: string | null | undefined): string | null {
    return userId === null || userId === undefined ? null : this.emailOf(userId);
  }
}

/**
 * How an import treats an email with no member behind it:
 * - `value` — a stored value (user cell, created/updated by, a default
 *   user, a reminder recipient, a user an automation writes): left out
 *   (the cell is empty, the creator `null`);
 * - `reference` — a user a filter compares with or an automation notifies:
 *   a new user id nobody has, the same for every reference to that email,
 *   so the condition keeps its meaning ("this person, who is not here")
 *   instead of being dropped — dropping a condition could widen a role's
 *   record rule or an automation's condition.
 */
export type PackageUserMode = 'value' | 'reference';

export interface PackageMember {
  readonly id: Id<'usr'>;
  readonly email: string;
}

/** Import side: email → member of the target organization. */
export class PackageUserMatcher {
  private readonly members = new Map<string, Id<'usr'>>();
  private readonly unmatched = new Set<string>();
  private readonly ghosts = new Map<string, Id<'usr'>>();

  constructor(members: Iterable<PackageMember>) {
    for (const member of members) this.members.set(normalizePackageEmail(member.email), member.id);
  }

  /** The member with this email, or `null`. */
  memberOf(email: string): Id<'usr'> | null {
    return this.members.get(normalizePackageEmail(email)) ?? null;
  }

  /** The user id of `email` at a place of `mode` (see {@link PackageUserMode}); `null` = leave out. */
  resolve(email: string, mode: PackageUserMode): Id<'usr'> | null {
    const key = normalizePackageEmail(email);
    const member = this.members.get(key);
    if (member !== undefined) return member;
    this.unmatched.add(key);
    if (mode === 'value') return null;
    let ghost = this.ghosts.get(key);
    if (ghost === undefined) {
      ghost = newId('usr');
      this.ghosts.set(key, ghost);
    }
    return ghost;
  }

  /**
   * Emails of the package that matched no member, sorted (`limit` of
   * them), placeholders of unknown users left out; and how many there are.
   */
  unmatchedEmails(limit: number): { readonly emails: string[]; readonly total: number } {
    const real = [...this.unmatched].filter((email) => !isUnknownUserEmail(email)).sort();
    return { emails: real.slice(0, limit), total: real.length };
  }
}
