import { z } from 'zod';

import { isoDateTimeSchema } from './common.js';
import { idOf } from './ids.js';
import { authProviderSchema } from './oidc.js';
import { canonicalTimeZone } from './time-zones.js';

/**
 * First-time setup, sessions, `GET /me` and password reset (SPEC §13.1,
 * §14.1A, §14.2; CONTRACTS §5A, §12.1).
 */

/** HttpOnly cookie holding the session token (SPEC §14.2). */
export const SESSION_COOKIE = 'ob_session';
/** CSRF cookie and header (SPEC §14.2), defined apart from the schemas. */
export { CSRF_COOKIE, CSRF_HEADER } from './client-constants.js';

/** Shortest password accepted (SPEC §14.2). */
export const PASSWORD_MIN_LENGTH = 10;
/** Longest password accepted; bounds hashing work. */
export const PASSWORD_MAX_LENGTH = 256;
/**
 * Detail code (`errors[].code` of `422 VALIDATION_FAILED`, path `password`)
 * for a password found in the common-password list. Too short / too long
 * use the generic `TOO_SMALL` / `TOO_BIG`.
 */
export const PASSWORD_TOO_COMMON = 'PASSWORD_TOO_COMMON';

export const orgRoleSchema = z
  .enum(['owner', 'admin', 'member'])
  .meta({ id: 'OrgRole', description: 'Role in an organization' });
export type OrgRoleName = z.infer<typeof orgRoleSchema>;

export const emailSchema = z.email().max(254).meta({ example: 'an.nguyen@example.com' });

/**
 * A new password: length rules only. The server additionally rejects
 * passwords from its common-password list (`PASSWORD_TOO_COMMON`).
 */
export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH)
  .max(PASSWORD_MAX_LENGTH)
  .meta({
    description: `At least ${String(PASSWORD_MIN_LENGTH)} characters, not a common password`,
    format: 'password',
  });

function isLocale(value: string): boolean {
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

function isTimeZone(value: string): boolean {
  return canonicalTimeZone(value) !== null;
}

export const localeSchema = z
  .string()
  .min(2)
  .max(35)
  .refine(isLocale, {
    message: 'Must be a BCP 47 language tag',
    params: { code: 'INVALID_LOCALE' },
  })
  .meta({ description: 'BCP 47 language tag', example: 'vi' });

export const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isTimeZone, {
    message: 'Must be an IANA time zone',
    params: { code: 'INVALID_TIME_ZONE' },
  })
  // Stored and used as the IANA primary name PostgreSQL knows (`Asia/Saigon` → `Asia/Ho_Chi_Minh`).
  .overwrite((zone) => canonicalTimeZone(zone) ?? zone)
  .meta({
    description: 'IANA time zone; an alias is replaced by its IANA primary name',
    example: 'Asia/Ho_Chi_Minh',
  });

const displayNameSchema = z.string().trim().min(1).max(100);

export const userSummarySchema = z
  .object({
    id: idOf('usr'),
    email: z.string(),
    display_name: z.string(),
    avatar_url: z.string().nullable(),
  })
  .meta({ id: 'UserSummary', description: 'A user as shown to themselves and to admins' });

export const organizationSummarySchema = z
  .object({ id: idOf('org'), name: z.string(), slug: z.string() })
  .meta({ id: 'OrganizationSummary' });

// --- Setup (SPEC §14.1A) -------------------------------------------------------

/**
 * Public sign-in configuration the web client needs before anyone signs in
 * (SPEC §14.2: the "forgot password" link is shown only when SMTP is set).
 */
export const authConfigSchema = z
  .object({
    smtp_enabled: z.boolean().meta({
      description:
        'True when SMTP is configured, so `POST /auth/forgot-password` emails a link. ' +
        'Otherwise users ask an administrator for a reset link.',
    }),
    // Defaults to `[]` for responses of servers before T707.
    providers: z.array(authProviderSchema).default([]).meta({
      description:
        'OIDC sign-in buttons (CONTRACTS §27.1), as `GET /auth/providers`; empty when none',
    }),
  })
  .meta({ id: 'AuthConfig' });
export type AuthConfig = z.infer<typeof authConfigSchema>;

export const setupStatusSchema = z
  .object({
    setup_required: z.boolean().meta({ description: 'True while the instance has no user yet' }),
    auth_config: authConfigSchema,
  })
  .meta({ id: 'SetupStatus' });
export type SetupStatus = z.infer<typeof setupStatusSchema>;

export const setupRequestSchema = z
  .strictObject({
    email: emailSchema,
    password: newPasswordSchema,
    display_name: displayNameSchema,
    org_name: z.string().trim().min(1).max(100),
    locale: localeSchema.optional().meta({ description: 'Defaults to DEFAULT_LOCALE' }),
    timezone: timeZoneSchema.optional().meta({ description: 'Defaults to DEFAULT_TIMEZONE' }),
  })
  .meta({ id: 'SetupRequest', description: 'First administrator and organization' });
export type SetupRequest = z.infer<typeof setupRequestSchema>;

export const setupResponseSchema = z
  .object({ user: userSummarySchema, organization: organizationSummarySchema })
  .meta({ id: 'SetupResult' });
export type SetupResponse = z.infer<typeof setupResponseSchema>;

// --- Sessions ------------------------------------------------------------------

export const loginRequestSchema = z
  .strictObject({
    email: emailSchema,
    // Length only: existing passwords are checked, not re-validated.
    password: z.string().min(1).max(PASSWORD_MAX_LENGTH).meta({ format: 'password' }),
  })
  .meta({ id: 'LoginRequest' });
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** An organization of the signed-in user, as listed by `GET /me`. */
export const meOrganizationSchema = z
  .object({
    id: idOf('org'),
    name: z.string(),
    slug: z.string(),
    role: orgRoleSchema.meta({ description: "The caller's role in the organization" }),
  })
  .meta({ id: 'MeOrganization' });
export type MeOrganization = z.infer<typeof meOrganizationSchema>;

/** `GET /api/v1/me` (CONTRACTS §5A). */
export const meResponseSchema = z
  .object({
    user: userSummarySchema,
    orgs: z.array(meOrganizationSchema),
    locale: z.string().meta({
      description: "The user's locale, else their first organization's, else DEFAULT_LOCALE",
    }),
    timezone: z.string().meta({
      description: "The user's time zone, else their first organization's, else DEFAULT_TIMEZONE",
    }),
  })
  .meta({ id: 'Me', description: 'The signed-in user and their organizations' });
export type MeResponse = z.infer<typeof meResponseSchema>;

/** Languages a user can pick for themselves (`PATCH /me`): those of the UI and of emails. */
export const USER_LOCALES = ['en', 'vi'] as const;

/** `PATCH /api/v1/me` (CONTRACTS §12.0, T831): keys left out keep their value. */
export const updateMeRequestSchema = z
  .strictObject({
    display_name: displayNameSchema.optional(),
    locale: z.enum(USER_LOCALES).optional().meta({ description: 'UI and email language' }),
    timezone: timeZoneSchema.optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: 'At least one property is required',
  })
  .meta({ id: 'UpdateMeRequest' });
export type UpdateMeRequest = z.infer<typeof updateMeRequestSchema>;

/**
 * Detail code (`errors[].code` of `422 VALIDATION_FAILED`, path
 * `current_password`) of `POST /me/password` with a wrong current password.
 */
export const CURRENT_PASSWORD_INVALID = 'CURRENT_PASSWORD_INVALID';

/**
 * `POST /api/v1/me/password` (CONTRACTS §12.0, T831). `revoke_tokens`
 * defaults to `false`, unlike a reset: the caller proved the current
 * password, so a routine change keeps their integrations working.
 */
export const changePasswordRequestSchema = z
  .strictObject({
    // Length only: the current password is checked, not re-validated.
    current_password: z.string().min(1).max(PASSWORD_MAX_LENGTH).meta({ format: 'password' }),
    new_password: newPasswordSchema,
    revoke_tokens: z.boolean().default(false).meta({
      description:
        'Also revoke every API token of the caller, in every organization (default `false`)',
    }),
  })
  .meta({ id: 'ChangePasswordRequest' });
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
export type ChangePasswordRequestInput = z.input<typeof changePasswordRequestSchema>;

// --- Password reset (SPEC §14.2, CONTRACTS §12.1) --------------------------------

export const forgotPasswordRequestSchema = z
  .strictObject({ email: emailSchema })
  .meta({ id: 'ForgotPasswordRequest' });
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;

/**
 * `revoke_tokens` of a password reset (BACKLOG T802, Quyết định S7 #3): also
 * revoke every API token of the user in every organization. Absent = `true`
 * — a taken-over account is the main reason to reset, so keeping the tokens
 * must be an explicit choice.
 */
const revokeTokensSchema = z
  .boolean()
  .default(true)
  .meta({
    description:
      'Also revoke every API token of the user, in every organization (default `true`; ' +
      '`false` keeps them working)',
  });

export const passwordResetRequestSchema = z
  .strictObject({ password: newPasswordSchema, revoke_tokens: revokeTokensSchema })
  .meta({ id: 'PasswordResetRequest' });
export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>;
export type PasswordResetRequestInput = z.input<typeof passwordResetRequestSchema>;

/**
 * Optional body of `POST /orgs/:orgId/members/:userId/password-reset`: with
 * `revoke_tokens` (default `true`) the member's API tokens are revoked when
 * the link is created, not when it is used (T802).
 */
export const memberPasswordResetRequestSchema = z
  .strictObject({ revoke_tokens: revokeTokensSchema })
  .meta({ id: 'MemberPasswordResetRequest' });
export type MemberPasswordResetRequest = z.infer<typeof memberPasswordResetRequestSchema>;

/** Reset tokens: 32 random bytes, base64url without padding. */
export const RESET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const passwordResetLinkSchema = z
  .object({
    reset_url: z.url().meta({
      description: 'One-time link `<PUBLIC_URL>/reset/<token>`; returned only once',
    }),
    expires_at: isoDateTimeSchema,
  })
  .meta({ id: 'PasswordResetLink' });
export type PasswordResetLink = z.infer<typeof passwordResetLinkSchema>;
