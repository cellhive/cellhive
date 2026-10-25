import { generateToken, hashToken } from './tokens.js';

import type { Tx } from '../db/create-db.js';
import type { PasswordResetsRepository } from '../db/repositories/password-resets.repository.js';
import type { Id } from '@cellhive/contracts';

/** Who asks for a link: the user (forgot password), an organization admin, or the CLI. */
export type ResetLinkIssuer =
  | { readonly source: 'self_service' }
  | { readonly source: 'admin'; readonly adminId: Id<'usr'> }
  | { readonly source: 'cli' };

/** Reset links are valid for 24 hours (SPEC §14.2). */
export const RESET_LINK_TTL_MS = 24 * 60 * 60 * 1000;

export interface ResetLink {
  /** `<PUBLIC_URL>/reset/<token>`. Secret: return it once, never log it. */
  readonly url: string;
  readonly expiresAt: Date;
  readonly resetId: Id<'pwr'>;
}

/** The web page that redeems a token (C§12.1). */
export function resetUrlOf(publicUrl: string, token: string): string {
  return `${publicUrl}/reset/${token}`;
}

/**
 * Creates one-time password reset links (32-byte token, only its SHA-256
 * stored). Shared by the API (admin link), the worker (forgot password)
 * and the CLI.
 *
 * Earlier unused links of the user stop working, with one exception: a
 * self-service link (forgot password) only replaces earlier self-service
 * links, so that anyone who knows the email address cannot cancel a link
 * an administrator or the CLI issued.
 */
export class PasswordResetLinks {
  constructor(
    private readonly passwordResets: PasswordResetsRepository,
    private readonly publicUrl: string,
  ) {}

  async create(tx: Tx, userId: Id<'usr'>, issuer: ResetLinkIssuer): Promise<ResetLink> {
    const token = generateToken();
    const expiresAt = new Date(Date.now() + RESET_LINK_TTL_MS);
    await this.passwordResets.deleteUnusedForUser(
      userId,
      tx,
      issuer.source === 'self_service' ? { source: 'self_service' } : {},
    );
    const reset = await this.passwordResets.create(
      {
        userId,
        tokenHash: hashToken(token),
        source: issuer.source,
        createdBy: issuer.source === 'admin' ? issuer.adminId : null,
        expiresAt,
      },
      tx,
    );
    return { url: resetUrlOf(this.publicUrl, token), expiresAt, resetId: reset.id };
  }
}
