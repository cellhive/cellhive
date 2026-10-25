import { z } from 'zod';

import { booleanQueryParam, isoDateTimeSchema } from './common.js';
import { idOf } from './ids.js';
import { offsetListSchema, offsetQuerySchema } from './pagination.js';

/**
 * Share links (SPEC §15A, CONTRACTS §16; BACKLOG T304): management by
 * signed-in users. The public endpoints under `/shares/{token}` come with
 * T305/T306.
 */

export const SHARE_LINK_TARGET_TYPES = ['view', 'form', 'dashboard'] as const;
export const shareLinkTargetTypeSchema = z
  .enum(SHARE_LINK_TARGET_TYPES)
  .meta({ id: 'ShareLinkTargetType', description: '`dashboard` since S7 (T809)' });
export type ShareLinkTargetType = z.infer<typeof shareLinkTargetTypeSchema>;

export const SHARE_LINK_AUDIENCES = ['org', 'public'] as const;
export const shareLinkAudienceSchema = z.enum(SHARE_LINK_AUDIENCES).meta({
  id: 'ShareLinkAudience',
  description: '`org`: any signed-in member of the organization holding the link; `public`: anyone',
});
export type ShareLinkAudience = z.infer<typeof shareLinkAudienceSchema>;

/** Organization policy for public links (`organizations.settings.public_sharing`). */
export const PUBLIC_SHARING_POLICIES = ['allowed', 'forms_only', 'disabled'] as const;
export const publicSharingPolicySchema = z.enum(PUBLIC_SHARING_POLICIES).meta({
  id: 'PublicSharingPolicy',
  description:
    '`allowed` (default), `forms_only` (only form links may be public) or `disabled` (no ' +
    'public link). Public links the policy no longer allows stop working (`410`) but are kept.',
});
export type PublicSharingPolicy = z.infer<typeof publicSharingPolicySchema>;
export const DEFAULT_PUBLIC_SHARING: PublicSharingPolicy = 'allowed';

/**
 * State of a link that is not revoked: `blocked` = a public link that the
 * organization policy no longer allows. Only `active` links work.
 */
export const SHARE_LINK_STATUSES = ['active', 'disabled', 'expired', 'blocked'] as const;
export const shareLinkStatusSchema = z.enum(SHARE_LINK_STATUSES).meta({ id: 'ShareLinkStatus' });
export type ShareLinkStatus = z.infer<typeof shareLinkStatusSchema>;

export const SHARE_LINK_PASSWORD_MIN_LENGTH = 6;
export const SHARE_LINK_PASSWORD_MAX_LENGTH = 128;
/** Most ids in one bulk revoke. */
export const MAX_SHARE_LINK_BULK = 1000;
/** Shortest dashboard refresh through a link (SPEC §15A.3): the page polls, no WS. */
export const MIN_SHARE_REFRESH_SECONDS = 30;
/** Longest dashboard refresh through a link (BACKLOG T809: 30–3 600 s). */
export const MAX_SHARE_REFRESH_SECONDS = 3600;
/** Most origins allowed to embed one link (BACKLOG S7 decision 16). */
export const MAX_EMBED_ORIGINS = 20;
/** Characters of the token kept in clear to identify a link (`token_prefix`). */
export const SHARE_TOKEN_PREFIX_LENGTH = 6;
/** Length of a token: 32 random bytes, base64url without padding. */
export const SHARE_TOKEN_LENGTH = 43;

/** Detail code (`VALIDATION_FAILED`): the option exists in the contract but not in this release. */
export const NOT_AVAILABLE_YET = 'NOT_AVAILABLE_YET';
/** Detail code (`VALIDATION_FAILED`): personal views cannot be shared. */
export const PERSONAL_VIEW = 'PERSONAL_VIEW';
/**
 * Detail code (`VALIDATION_FAILED`, path `settings.embed.enabled`): only a
 * `public` link without password can be embedded (BACKLOG S7 decision 14).
 */
export const EMBED_NOT_SUPPORTED = 'EMBED_NOT_SUPPORTED';
/**
 * Detail code (`VALIDATION_FAILED`, path `settings.embed.allowed_origins` or
 * one of its items): not an origin that may embed a link, or no origin while
 * embedding is on (S7 decision 16).
 */
export const INVALID_ORIGIN = 'INVALID_ORIGIN';
/**
 * Detail code of the `404` of `GET /shares/{token}/meta` for a dashboard
 * link (T809): the page reads `GET /shares/{token}/dashboard` instead.
 */
export const DASHBOARD_LINK = 'DASHBOARD_LINK';

const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
const ORIGIN_PATTERN = /^(https?):\/\/([A-Za-z0-9.-]+|\[::1\])(?::(\d{1,5}))?\/?$/u;
const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/u;

/**
 * The origin `value` names, or `null` when it may not embed a link (BACKLOG
 * S7 decision 16): `https://host[:port]` only — no path, query, fragment,
 * user info, IPv6 literal other than the loopback, or wildcard;
 * `http://localhost[:port]` (and `127.0.0.1`, `[::1]`) only with
 * `allowLocalHttp` (development). The result is normalized (lower-case
 * host, default port dropped, no final `/`), so it goes into
 * `frame-ancestors` as is.
 */
export function embedOriginOf(
  value: string,
  options: { readonly allowLocalHttp: boolean } = { allowLocalHttp: false },
): string | null {
  const match = ORIGIN_PATTERN.exec(value);
  if (match === null) return null;
  const scheme = match[1] as 'http' | 'https';
  const host = (match[2] ?? '').toLowerCase();
  const local = LOCAL_HOSTS.has(host);
  if (scheme === 'http' && !(options.allowLocalHttp && local)) return null;
  if (!local && (host.length > 253 || !host.split('.').every((label) => HOST_LABEL.test(label)))) {
    return null;
  }
  let port = '';
  if (match[3] !== undefined) {
    const number = Number(match[3]);
    if (number < 1 || number > 65_535) return null;
    if (number !== (scheme === 'https' ? 443 : 80)) port = `:${String(number)}`;
  }
  return `${scheme}://${host}${port}`;
}

const originSchema = z
  .string()
  .max(2048)
  .meta({
    description:
      'Origin allowed to embed the link: `https://host[:port]` (no path, no wildcard); ' +
      '`http://localhost[:port]` only in development (`422 INVALID_ORIGIN` otherwise)',
  });

/** Stored settings, every key present (SPEC §15A.1). */
export const shareLinkSettingsSchema = z
  .object({
    allow_download: z.boolean(),
    allow_export: z.boolean().meta({
      description:
        'Anyone holding the link may export the whole view as CSV/XLSX ' +
        '(`GET /shares/{token}/export`, T810) while the creator keeps `base_rule.download`; ' +
        'view links only',
    }),
    allow_copy: z.boolean(),
    allow_search: z.boolean(),
    allow_viewer_filter_sort: z.boolean(),
    show_record_detail: z.boolean(),
    embed: z.object({ enabled: z.boolean(), allowed_origins: z.array(z.string()) }).meta({
      description:
        'Embedding (T809): `/s/{token}?embed=1` may be framed by `allowed_origins` ' +
        '(`Content-Security-Policy: frame-ancestors …`); only a `public` link without password',
    }),
    dashboard: z
      .object({
        allow_filter_controls: z.boolean(),
        refresh_seconds: z.int(),
        tv_mode: z.boolean(),
      })
      .meta({
        description:
          'Dashboard links only (T809): live filters allowed, polling period of the page, TV mode',
      }),
  })
  .meta({ id: 'ShareLinkSettings' });
export type ShareLinkSettings = z.infer<typeof shareLinkSettingsSchema>;

export const DEFAULT_SHARE_LINK_SETTINGS: ShareLinkSettings = {
  allow_download: false,
  allow_export: false,
  allow_copy: false,
  allow_search: true,
  allow_viewer_filter_sort: true,
  show_record_detail: true,
  embed: { enabled: false, allowed_origins: [] },
  dashboard: { allow_filter_controls: true, refresh_seconds: 60, tv_mode: false },
};

/**
 * Settings in a request: every key optional; a present key replaces the
 * stored value (`embed`, `dashboard` merge one level deeper).
 * `embed.enabled = true` (T809, S7 decisions 14–16) needs a `public` link
 * without password (`422 EMBED_NOT_SUPPORTED`) and 1–20 allowed origins
 * (`INVALID_ORIGIN`). `allow_download` is accepted from S4 and means
 * downloading attachments through the link only (BACKLOG open question S4
 * #3, T409). `allow_export` (S7 decision 17, T810) lets the link export its
 * view as a file — on a dashboard link, a widget's numbers as CSV (T809);
 * `true` on a form link is `422 VALIDATION_FAILED` / `NOT_ALLOWED`.
 * `allow_viewer_filter_sort` and `show_record_detail` do not apply to
 * dashboard links, `dashboard` applies only to them.
 */
export const shareLinkSettingsInputSchema = z
  .strictObject({
    allow_download: z.boolean().optional(),
    allow_export: z.boolean().optional(),
    allow_copy: z.boolean().optional(),
    allow_search: z.boolean().optional(),
    allow_viewer_filter_sort: z.boolean().optional(),
    show_record_detail: z.boolean().optional(),
    embed: z
      .strictObject({
        enabled: z.boolean().optional(),
        allowed_origins: z.array(originSchema).max(MAX_EMBED_ORIGINS).optional(),
      })
      .optional(),
    dashboard: z
      .strictObject({
        allow_filter_controls: z.boolean().optional(),
        refresh_seconds: z
          .int()
          .min(MIN_SHARE_REFRESH_SECONDS)
          .max(MAX_SHARE_REFRESH_SECONDS)
          .optional(),
        tv_mode: z.boolean().optional(),
      })
      .optional(),
  })
  .meta({ id: 'ShareLinkSettingsInput' });
export type ShareLinkSettingsInput = z.infer<typeof shareLinkSettingsInputSchema>;

const passwordSchema = z
  .string()
  .min(SHARE_LINK_PASSWORD_MIN_LENGTH)
  .max(SHARE_LINK_PASSWORD_MAX_LENGTH)
  .meta({ description: 'Stored as an argon2id hash; never returned' });

export const createShareLinkRequestSchema = z
  .strictObject({
    audience: shareLinkAudienceSchema.default('org'),
    password: passwordSchema.nullish(),
    expires_at: isoDateTimeSchema.nullish().meta({ description: 'Must be in the future' }),
    enabled: z.boolean().default(true),
    settings: shareLinkSettingsInputSchema.optional(),
  })
  .meta({ id: 'CreateShareLinkRequest' });
export type CreateShareLinkRequest = z.infer<typeof createShareLinkRequestSchema>;

export const updateShareLinkRequestSchema = z
  .strictObject({
    audience: shareLinkAudienceSchema.optional(),
    password: passwordSchema.nullable().optional().meta({ description: '`null` removes it' }),
    expires_at: isoDateTimeSchema.nullable().optional(),
    enabled: z.boolean().optional(),
    settings: shareLinkSettingsInputSchema.optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: 'At least one property is required',
  })
  .meta({ id: 'UpdateShareLinkRequest' });
export type UpdateShareLinkRequest = z.infer<typeof updateShareLinkRequestSchema>;

export const shareLinkSchema = z
  .object({
    id: idOf('shl'),
    base_id: idOf('bse'),
    table_id: idOf('tbl')
      .nullable()
      .meta({ description: 'Table of the view or form; `null` for a dashboard link' }),
    target_type: shareLinkTargetTypeSchema,
    target_id: z.string(),
    target_name: z.string().nullable().meta({
      description: 'Name of the target view, form or dashboard; `null` when it no longer exists',
    }),
    audience: shareLinkAudienceSchema,
    status: shareLinkStatusSchema,
    token_prefix: z.string().meta({ description: 'First 6 characters of the token' }),
    has_password: z.boolean(),
    expires_at: isoDateTimeSchema.nullable(),
    enabled: z.boolean(),
    settings: shareLinkSettingsSchema,
    created_by: z.object({ id: idOf('usr'), name: z.string().nullable() }),
    last_accessed_at: isoDateTimeSchema.nullable(),
    access_count: z.int().min(0),
    created_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
  })
  .meta({ id: 'ShareLink' });
export type ShareLinkDto = z.infer<typeof shareLinkSchema>;

/** Response of create and regenerate: the only time the token is ever returned. */
export const createdShareLinkSchema = shareLinkSchema
  .extend({
    token: z.string().meta({ description: '32 random bytes, base64url; returned only once' }),
    url: z.string().meta({ description: '`<PUBLIC_URL>/s/<token>`' }),
  })
  .meta({ id: 'CreatedShareLink' });
export type CreatedShareLinkDto = z.infer<typeof createdShareLinkSchema>;

export const shareLinkListSchema = offsetListSchema(shareLinkSchema).meta({ id: 'ShareLinkList' });
export type ShareLinkList = z.infer<typeof shareLinkListSchema>;

/** `GET /bases/:id/share-links` and `GET /orgs/:id/share-links`. */
export const shareLinkListQuerySchema = offsetQuerySchema.extend({
  audience: shareLinkAudienceSchema.optional(),
  enabled: booleanQueryParam.optional(),
  target_type: shareLinkTargetTypeSchema.optional(),
  created_by: idOf('usr').optional(),
});
export type ShareLinkListQuery = z.infer<typeof shareLinkListQuerySchema>;

export const orgShareLinkListQuerySchema = shareLinkListQuerySchema.extend({
  base_id: idOf('bse').optional(),
});
export type OrgShareLinkListQuery = z.infer<typeof orgShareLinkListQuerySchema>;

export const revokeShareLinksRequestSchema = z
  .strictObject({ ids: z.array(idOf('shl')).min(1).max(MAX_SHARE_LINK_BULK) })
  .meta({ id: 'RevokeShareLinksRequest' });
export type RevokeShareLinksRequest = z.infer<typeof revokeShareLinksRequestSchema>;

export const revokeShareLinksResponseSchema = z
  .object({
    revoked: z.array(idOf('shl')).meta({
      description: 'Links revoked by this call; unknown or already revoked ids are skipped',
    }),
  })
  .meta({ id: 'RevokeShareLinksResponse' });
export type RevokeShareLinksResponse = z.infer<typeof revokeShareLinksResponseSchema>;

/** What people outside will see through a link of this view (SPEC §15A.1 warning). */
export const shareLinkPreviewSchema = z
  .object({
    target_type: shareLinkTargetTypeSchema,
    record_count: z
      .int()
      .min(0)
      .nullable()
      .meta({ description: 'Records readable through the link; `null` for a form' }),
    record_count_estimated: z.boolean(),
    fields: z.array(
      z.object({
        id: idOf('fld'),
        name: z.string(),
        type: z.string(),
        access: z.enum(['read', 'create']),
      }),
    ),
  })
  .meta({ id: 'ShareLinkPreview' });
export type ShareLinkPreview = z.infer<typeof shareLinkPreviewSchema>;
