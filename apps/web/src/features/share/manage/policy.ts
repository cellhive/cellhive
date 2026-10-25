import type {
  PublicSharingPolicy,
  ShareLinkDto,
  ShareLinkTargetType,
  ViewType,
} from '@cellhive/contracts';

/** Share link target of a view (CONTRACTS §16): form views make form links. */
export function targetTypeOf(viewType: ViewType): ShareLinkTargetType {
  return viewType === 'form' ? 'form' : 'view';
}

/**
 * Whether the organization policy lets a link of `targetType` be public, and
 * if not why: `disabled` (no public link at all) or `forms_only` (only form
 * links). The server answers `403 PUBLIC_SHARING_DISABLED` anyway.
 */
export function publicBlockedBy(
  policy: PublicSharingPolicy | undefined,
  targetType: ShareLinkTargetType,
): 'disabled' | 'forms_only' | null {
  if (policy === 'disabled') return 'disabled';
  if (policy === 'forms_only' && targetType !== 'form') return 'forms_only';
  return null;
}

/** Filters of the organization list of links. */
export interface BlockedLinkFilters {
  readonly audience: 'public';
  readonly enabled: true;
  readonly target_type?: 'form';
}

/**
 * Filters of the organization list that count the public links a policy
 * would block (CONTRACTS §16: enabled public links the policy does not allow
 * become `blocked`): `count` minus `minus` (forms only: every enabled public
 * link but forms — views and, T814, dashboards); `null` when it blocks none.
 */
export function blockedLinkFilters(
  policy: PublicSharingPolicy,
): { readonly count: BlockedLinkFilters; readonly minus?: BlockedLinkFilters } | null {
  if (policy === 'disabled') return { count: { audience: 'public', enabled: true } };
  if (policy === 'forms_only') {
    return {
      count: { audience: 'public', enabled: true },
      minus: { audience: 'public', enabled: true, target_type: 'form' },
    };
  }
  return null;
}

/**
 * The value of an `<input type="datetime-local">` for an ISO instant, in the
 * browser's time zone (the input has none); `''` for `null`.
 */
export function toLocalInput(iso: string | null): string {
  if (iso === null) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** ISO instant of a `datetime-local` value (browser time zone); `null` when empty or invalid. */
export function fromLocalInput(value: string): string | null {
  if (value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The link of a view that is not revoked (a target has at most one, CONTRACTS §16). */
export function currentLink(links: readonly ShareLinkDto[]): ShareLinkDto | undefined {
  return links[0];
}

/**
 * The address of a link after its token is gone from memory: only the
 * prefix is known, so it is shown masked (`…/s/Ab3xY_…`).
 */
export function maskedUrl(origin: string, tokenPrefix: string): string {
  return `${origin}/s/${tokenPrefix}…`;
}
