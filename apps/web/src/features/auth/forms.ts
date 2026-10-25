import { newPasswordSchema, setupRequestSchema } from '@cellhive/contracts';
import { z } from 'zod';

/**
 * Form schemas of the auth screens, built from the contract schemas plus
 * client-only checks (password confirmation).
 */

/** Detail code of the client-only "passwords differ" check. */
export const PASSWORD_MISMATCH = 'PASSWORD_MISMATCH';

const confirmation = { path: ['confirm_password'], params: { code: PASSWORD_MISMATCH } };

function passwordsMatch(value: { password: string; confirm_password: string }): boolean {
  return value.password === value.confirm_password;
}

export const setupFormSchema = setupRequestSchema
  .pick({ email: true, password: true, display_name: true, org_name: true })
  .extend({ confirm_password: z.string() })
  .refine(passwordsMatch, confirmation);
export type SetupForm = z.input<typeof setupFormSchema>;

/** The reset screen also asks whether to revoke every API token (on by default, T802). */
export const resetPasswordFormSchema = z
  .object({
    password: newPasswordSchema,
    confirm_password: z.string(),
    revoke_tokens: z.boolean(),
  })
  .refine(passwordsMatch, confirmation);
export type ResetPasswordForm = z.input<typeof resetPasswordFormSchema>;

export const registerFormSchema = z
  .object({
    display_name: z.string().trim().min(1).max(100),
    password: newPasswordSchema,
    confirm_password: z.string(),
  })
  .refine(passwordsMatch, confirmation);
export type RegisterForm = z.input<typeof registerFormSchema>;

/** Navigation state the sign-in screen understands (set after setup or registration). */
export interface LoginNotice {
  notice: 'setupComplete' | 'invitationAccepted' | 'passwordReset';
  email?: string;
}

export function readLoginNotice(state: unknown): LoginNotice | null {
  if (typeof state !== 'object' || state === null || !('notice' in state)) return null;
  const { notice, email } = state as { notice: unknown; email?: unknown };
  if (notice !== 'setupComplete' && notice !== 'invitationAccepted' && notice !== 'passwordReset') {
    return null;
  }
  return typeof email === 'string' ? { notice, email } : { notice };
}
