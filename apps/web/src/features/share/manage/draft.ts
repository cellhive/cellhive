import {
  DEFAULT_SHARE_LINK_SETTINGS,
  SHARE_LINK_PASSWORD_MIN_LENGTH,
  type CreateShareLinkRequest,
  type ShareLinkAudience,
  type ShareLinkDto,
  type ShareLinkSettings,
  type ShareLinkSettingsInput,
  type ShareLinkTargetType,
  type UpdateShareLinkRequest,
} from '@cellhive/contracts';

import { fromLocalInput, toLocalInput } from './policy';

/**
 * On/off settings the share dialog offers for view links (SPEC §15A.1).
 * `allow_download` means downloading attachments only (BACKLOG S4 decision
 * #3, T409) and comes with the list of file fields people with the link
 * could download (T419); `allow_export` (T810, T814) lets them download
 * the whole view as CSV/XLSX.
 */
export const VIEW_SETTINGS = [
  'allow_copy',
  'allow_download',
  'allow_export',
  'allow_search',
  'allow_viewer_filter_sort',
  'show_record_detail',
] as const;
export type ViewSetting = (typeof VIEW_SETTINGS)[number];

/**
 * (T814) On/off settings of dashboard links (CONTRACTS §16): live filters
 * and TV mode (`settings.dashboard`), widget CSV (`allow_export`).
 */
export const DASHBOARD_SETTINGS = ['allow_filter_controls', 'tv_mode', 'allow_export'] as const;
export type DashboardSetting = (typeof DASHBOARD_SETTINGS)[number];

/** Every on/off setting of the dialog. */
export type FlagSetting = ViewSetting | DashboardSetting;
const FLAGS: readonly FlagSetting[] = [...new Set([...VIEW_SETTINGS, ...DASHBOARD_SETTINGS])];

/** Polling periods offered for dashboard links, in seconds (CONTRACTS §16: 30–3 600). */
export const REFRESH_CHOICES = [30, 60, 300, 900, 3600] as const;

/** The on/off settings a link of `targetType` has (forms have none). */
export function settingKeys(targetType: ShareLinkTargetType): readonly FlagSetting[] {
  if (targetType === 'view') return VIEW_SETTINGS;
  if (targetType === 'dashboard') return DASHBOARD_SETTINGS;
  return [];
}

/** The value of an on/off setting of a link (dashboard ones live under `settings.dashboard`). */
export function flagOf(settings: ShareLinkSettings, key: FlagSetting): boolean {
  if (key === 'allow_filter_controls' || key === 'tv_mode') return settings.dashboard[key];
  return settings[key];
}

/** The `settings` of a request turning one setting on or off. */
export function flagPatch(key: FlagSetting, on: boolean): ShareLinkSettingsInput {
  if (key === 'allow_filter_controls' || key === 'tv_mode') return { dashboard: { [key]: on } };
  return { [key]: on };
}

/** Two `settings` of a request as one (`dashboard`/`embed` merged one level deeper, as the API). */
export function mergeSettings(
  a: ShareLinkSettingsInput,
  b: ShareLinkSettingsInput,
): ShareLinkSettingsInput {
  const merged: ShareLinkSettingsInput = { ...a, ...b };
  if (a.dashboard !== undefined && b.dashboard !== undefined) {
    merged.dashboard = { ...a.dashboard, ...b.dashboard };
  }
  if (a.embed !== undefined && b.embed !== undefined) merged.embed = { ...a.embed, ...b.embed };
  return merged;
}

/** The editable state of the share dialog. */
export interface ShareDraft {
  readonly audience: ShareLinkAudience;
  readonly requirePassword: boolean;
  /** New password; empty keeps the current one of an existing link. */
  readonly password: string;
  readonly expires: boolean;
  /** `datetime-local` value (browser time zone). */
  readonly expiresAt: string;
  readonly settings: Readonly<Record<FlagSetting, boolean>>;
  /** (T814) Polling period of a dashboard link, in seconds. */
  readonly refreshSeconds: number;
}

function pickSettings(source: ShareLinkSettings) {
  return Object.fromEntries(FLAGS.map((key) => [key, flagOf(source, key)])) as Record<
    FlagSetting,
    boolean
  >;
}

/** Defaults of a new link (CONTRACTS §16: organization audience), else the link's values. */
export function initialDraft(link?: ShareLinkDto): ShareDraft {
  if (link === undefined) {
    return {
      audience: 'org',
      requirePassword: false,
      password: '',
      expires: false,
      expiresAt: '',
      settings: pickSettings(DEFAULT_SHARE_LINK_SETTINGS),
      refreshSeconds: DEFAULT_SHARE_LINK_SETTINGS.dashboard.refresh_seconds,
    };
  }
  return {
    audience: link.audience,
    requirePassword: link.has_password,
    password: '',
    expires: link.expires_at !== null,
    expiresAt: toLocalInput(link.expires_at),
    settings: pickSettings(link.settings),
    refreshSeconds: link.settings.dashboard.refresh_seconds,
  };
}

export interface DraftErrors {
  password?: 'tooShort';
  expiresAt?: 'past';
}

/** Client-side checks mirroring the contract (the server validates anyway). */
export function validateDraft(
  draft: ShareDraft,
  hasPassword: boolean,
  now: Date = new Date(),
): DraftErrors {
  const errors: DraftErrors = {};
  const typed = draft.password !== '';
  if (
    draft.requirePassword &&
    (typed || !hasPassword) &&
    draft.password.length < SHARE_LINK_PASSWORD_MIN_LENGTH
  ) {
    errors.password = 'tooShort';
  }
  if (draft.expires) {
    const at = fromLocalInput(draft.expiresAt);
    if (at === null || new Date(at).getTime() <= now.getTime()) errors.expiresAt = 'past';
  }
  return errors;
}

export function hasErrors(errors: DraftErrors): boolean {
  return errors.password !== undefined || errors.expiresAt !== undefined;
}

/** `settings` of a new link of `targetType` from the draft (forms: none). */
function draftSettings(
  draft: ShareDraft,
  targetType: ShareLinkTargetType,
): ShareLinkSettingsInput | undefined {
  if (targetType === 'form') return undefined;
  const flags = settingKeys(targetType)
    .map((key) => flagPatch(key, draft.settings[key]))
    .reduce(mergeSettings, {});
  return targetType === 'dashboard'
    ? mergeSettings(flags, { dashboard: { refresh_seconds: draft.refreshSeconds } })
    : flags;
}

/** `POST /views/:id/share-links` (or `/dashboards/:id/share-links`) body of a draft. */
export function createBody(
  draft: ShareDraft,
  targetType: ShareLinkTargetType,
): Partial<CreateShareLinkRequest> {
  const settings = draftSettings(draft, targetType);
  return {
    audience: draft.audience,
    ...(draft.requirePassword ? { password: draft.password } : {}),
    ...(draft.expires ? { expires_at: fromLocalInput(draft.expiresAt) } : {}),
    ...(settings === undefined ? {} : { settings }),
  };
}

/**
 * (T814) Why a link cannot be embedded (BACKLOG S7 decision #14, CONTRACTS
 * §16): only a `public` link without password — the session cookie
 * (`SameSite=Lax`) and the unlock cookie (`SameSite=Strict`) do not reach a
 * frame on another site. `null`: it can.
 */
export function embedBlockedBy(
  link: Pick<ShareLinkDto, 'audience' | 'has_password'>,
): 'audience' | 'password' | null {
  if (link.audience !== 'public') return 'audience';
  if (link.has_password) return 'password';
  return null;
}

/** Who can open a link and whether it has a password, once `body` is saved. */
function afterUpdate(
  link: ShareLinkDto,
  body: UpdateShareLinkRequest,
): Pick<ShareLinkDto, 'audience' | 'has_password'> {
  let hasPassword = link.has_password;
  if (body.password === null) hasPassword = false;
  else if (body.password !== undefined) hasPassword = true;
  return { audience: body.audience ?? link.audience, has_password: hasPassword };
}

/**
 * `PATCH /share-links/:id` body with only what changed, or `null` when
 * nothing did (the form's "Save" stays disabled). (T814) A change that
 * makes an embedded link impossible to embed (audience `org`, a password)
 * turns embedding off in the same request — the API would refuse it with
 * `422 EMBED_NOT_SUPPORTED`.
 */
export function updateBody(
  draft: ShareDraft,
  link: ShareLinkDto,
  targetType: ShareLinkTargetType,
): UpdateShareLinkRequest | null {
  const body: UpdateShareLinkRequest = {};
  if (draft.audience !== link.audience) body.audience = draft.audience;
  if (!draft.requirePassword && link.has_password) body.password = null;
  else if (draft.requirePassword && draft.password !== '') body.password = draft.password;
  const expiresAt = draft.expires ? fromLocalInput(draft.expiresAt) : null;
  const current = link.expires_at === null ? null : new Date(link.expires_at).toISOString();
  // The input has minute precision: compare at that precision.
  if (toLocalInput(expiresAt) !== toLocalInput(current)) body.expires_at = expiresAt;
  if (targetType !== 'form') {
    const changed = settingKeys(targetType).filter(
      (key) => draft.settings[key] !== flagOf(link.settings, key),
    );
    let settings: ShareLinkSettingsInput | null =
      changed.length === 0
        ? null
        : changed.map((key) => flagPatch(key, draft.settings[key])).reduce(mergeSettings, {});
    if (
      targetType === 'dashboard' &&
      draft.refreshSeconds !== link.settings.dashboard.refresh_seconds
    ) {
      settings = mergeSettings(settings ?? {}, {
        dashboard: { refresh_seconds: draft.refreshSeconds },
      });
    }
    if (settings !== null) body.settings = settings;
  }
  if (Object.keys(body).length === 0) return null;
  if (link.settings.embed.enabled && embedBlockedBy(afterUpdate(link, body)) !== null) {
    body.settings = mergeSettings(body.settings ?? {}, { embed: { enabled: false } });
  }
  return body;
}

/** Attachment fields of a link, split by whether its creator may download their files. */
export interface LinkFileFields {
  /** Downloadable by people with the link once `allow_download` is on. */
  readonly downloadable: readonly string[];
  /** Thumbnails only: the creator lacks `file_download_fields` for them. */
  readonly viewOnly: readonly string[];
}

/**
 * The attachment fields among those a link shows (`preview.fields`), split
 * by the creator's right to download (`file_download_fields`, S§14.1): the
 * link can never download more than its creator (CONTRACTS §16A).
 */
export function linkFileFields(
  fields: readonly { readonly id: string; readonly name: string; readonly type: string }[],
  canDownload: (fieldId: string) => boolean,
): LinkFileFields {
  const files = fields.filter((field) => field.type === 'attachment');
  return {
    downloadable: files.filter((field) => canDownload(field.id)).map((field) => field.name),
    viewOnly: files.filter((field) => !canDownload(field.id)).map((field) => field.name),
  };
}

/**
 * Whether saving `body` widens who sees the data, so the scope warning must
 * be acknowledged first (like creating or turning on a link): going public
 * or dropping the password.
 */
export function widensAudience(body: UpdateShareLinkRequest | null): boolean {
  return body?.audience === 'public' || body?.password === null;
}
