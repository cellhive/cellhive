import type { TelegramLinkDto, UserChannelDto, UserChannelListDto } from '@cellhive/contracts';

/**
 * What the Telegram card of the notification settings shows (BACKLOG
 * T555, CONTRACTS §22.7, FRONTEND §14.2), from `GET …/me/channels` and the
 * link this tab created (if any). Pure, so that the precedence is tested
 * table-driven:
 *
 * 1. the organization has no notification bot → `unavailable` (even with an
 *    old `error` channel: nothing can be linked);
 * 2. the server says `linked` → `linked` (a link of this tab was used);
 * 3. this tab holds a link → `expired` once it expired, else `linking` —
 *    unless the server, read after the link was made (`serverFresh`), no
 *    longer has it waiting (the bot was changed, the link was cancelled
 *    from another tab): then the server's state;
 * 4. else the server's state: `error` (with its reason), `pending` (a link
 *    created elsewhere — its token is not readable again), or `unlinked`.
 */
export type TelegramView =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unlinked'; readonly botUsername: string | null }
  | {
      readonly kind: 'linking';
      readonly link: string;
      readonly expiresAt: string;
      readonly remainingMs: number;
      readonly botUsername: string | null;
    }
  | { readonly kind: 'expired'; readonly botUsername: string | null }
  | { readonly kind: 'pending'; readonly botUsername: string | null }
  | {
      readonly kind: 'linked';
      readonly botUsername: string | null;
      readonly linkedAt: string | null;
    }
  | {
      readonly kind: 'error';
      readonly reason: UserChannelDto['error_reason'];
      readonly botUsername: string | null;
    };

export type TelegramViewKind = TelegramView['kind'];

/**
 * A link is valid this long (CONTRACTS §22.7, `TELEGRAM_LINK_TOKEN_TTL_MS`;
 * copied so that this lazy chunk imports no value from the contracts module
 * the app shell carries — F§14.1; a test keeps them equal).
 */
export const LINK_TTL_MS = 10 * 60_000;

/** Personal channels are Telegram only today; other kinds are ignored. */
export function isTelegramChannel(channel: { readonly kind: string }): boolean {
  return channel.kind === 'telegram';
}

/**
 * The link was used: the channel was linked after the link was created —
 * both server times (`expires_at` − TTL and `linked_at`), no client clock.
 */
function consumed(link: TelegramLinkDto, channel: UserChannelDto | null): boolean {
  if (channel?.linked_at == null) return false;
  const created = Date.parse(link.expires_at) - LINK_TTL_MS;
  const linkedAt = Date.parse(channel.linked_at);
  return !Number.isNaN(created) && !Number.isNaN(linkedAt) && linkedAt >= created;
}

/** Milliseconds left before `expiresAt` (never negative; an unreadable date is expired). */
export function remainingMs(expiresAt: string, now: number): number {
  const end = Date.parse(expiresAt);
  return Number.isNaN(end) ? 0 : Math.max(0, end - now);
}

export function telegramView(
  channels: UserChannelListDto,
  link: TelegramLinkDto | null,
  now: number,
  serverFresh = false,
): TelegramView {
  if (!channels.available_kinds.includes('telegram')) return { kind: 'unavailable' };
  const channel = channels.items.find(isTelegramChannel) ?? null;
  // A link this tab made and that was used since does not count any more
  // (the channel may have gone to `error` after that).
  const localLink = link !== null && consumed(link, channel) ? null : link;
  const botUsername = channel?.bot_username ?? botOfLink(localLink?.link ?? null);
  if (channel?.status === 'linked') {
    return { kind: 'linked', botUsername, linkedAt: channel.linked_at };
  }
  if (localLink !== null) {
    const left = remainingMs(localLink.expires_at, now);
    if (left === 0) return { kind: 'expired', botUsername };
    if (channel?.status === 'pending' || !serverFresh) {
      return {
        kind: 'linking',
        link: localLink.link,
        expiresAt: localLink.expires_at,
        remainingMs: left,
        botUsername,
      };
    }
  }
  if (channel === null) return { kind: 'unlinked', botUsername };
  if (channel.status === 'pending') return { kind: 'pending', botUsername };
  return { kind: 'error', reason: channel.error_reason, botUsername };
}

/** `https://t.me/acme_bot?start=…` → `acme_bot` (the username only, never the token). */
export function botOfLink(link: string | null): string | null {
  if (link === null) return null;
  try {
    const url = new URL(link);
    if (url.hostname !== 't.me') return null;
    const name = decodeURIComponent(url.pathname.replace(/^\//u, ''));
    return /^[A-Za-z0-9_]{1,64}$/u.test(name) ? name : null;
  } catch {
    return null;
  }
}

/** Only an `https://t.me/…` link is ever rendered as a link or a QR code. */
export function isTelegramLink(link: string): boolean {
  try {
    const url = new URL(link);
    return url.protocol === 'https:' && url.hostname === 't.me';
  } catch {
    return false;
  }
}

/** `581_000` → `9:41` (minutes:seconds, rounded up so that `0:00` means expired). */
export function countdownLabel(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}
