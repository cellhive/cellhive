import { userChannel, type Id, type TelegramLinkDto } from '@cellhive/contracts';
import { Button, buttonVariants, cn, Dialog, Skeleton, Spinner } from '@cellhive/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleAlert,
  CircleCheck,
  Clock,
  ExternalLink,
  Info,
  Link2,
  RefreshCw,
  Send,
  Unlink,
} from 'lucide-react';
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../../lib/i18n/format';
import { keys } from '../../../../lib/query/keys';
import { useRealtimeChannel } from '../../../../lib/realtime/channels';
import { showErrorToast } from '../../../../lib/toast/toast';

import { userChannelsApi, userChannelsQuery } from './api';
import {
  countdownLabel,
  isTelegramChannel,
  isTelegramLink,
  telegramView,
  type TelegramView,
} from './model';

const QrCode = lazy(() => import('./QrCode'));

/** Id of the card, for the "Link Telegram" shortcut of the type × channel table. */
export const TELEGRAM_SECTION_ID = 'telegram-channel';

/** The countdown of a link ticks once a second while it is on screen. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const tick = () => {
      setNow(Date.now());
    };
    // At once (the clock may be old when the link appears), then every second.
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [active]);
  return now;
}

type Tone = 'success' | 'warning' | 'danger' | 'neutral';

const TONES: Record<Tone, { icon: typeof Clock; className: string }> = {
  success: { icon: CircleCheck, className: 'bg-option-2 text-on-option-2' },
  warning: { icon: Clock, className: 'bg-option-3 text-on-option-3' },
  danger: { icon: CircleAlert, className: 'bg-danger/10 text-danger' },
  neutral: { icon: Info, className: 'bg-option-0 text-on-option-0' },
};

/** State of the link: icon + word, never color alone (FRONTEND §9.2). */
function StateBadge({ tone, children }: { readonly tone: Tone; readonly children: ReactNode }) {
  const { icon: Icon, className } = TONES[tone];
  return (
    <span
      data-testid="telegram-state"
      data-tone={tone}
      className={cn(
        'inline-flex w-fit items-center gap-1 rounded-sm px-1.5 py-0.5 text-label font-medium whitespace-nowrap',
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {children}
    </span>
  );
}

/** "Link Telegram" / "Link again" / "New link": creates a one-time link. */
function LinkButton({
  label,
  pending,
  onClick,
  'data-testid': testId,
}: {
  readonly label: string;
  readonly pending: boolean;
  readonly onClick: () => void;
  readonly 'data-testid': string;
}) {
  return (
    <Button data-testid={testId} className="max-lg:h-control" disabled={pending} onClick={onClick}>
      {pending ? <Spinner /> : <Send aria-hidden="true" />}
      {label}
    </Button>
  );
}

export interface TelegramChannelSectionProps {
  readonly orgId: string;
  readonly orgSlug: string;
  readonly userId: string;
  /** Org owner/admin: without a notification bot they get a way to the bot page. */
  readonly isAdmin: boolean;
  readonly onSaved: (message: string) => void;
}

/**
 * "Telegram" card of the notification settings (BACKLOG T555, FRONTEND
 * §14.2, CONTRACTS §22.7): link the caller's own Telegram chat to the
 * organization's notification bot with a one-time `t.me` link (new tab, QR
 * code for a phone, 10-minute countdown), wait for `channel.changed` on
 * `user:<me>` (no polling; read again when the window gets the focus
 * back), then show the bot and since when, with "Unlink"; `error` (blocked
 * bot, bot changed) offers "Link again". Without a notification bot the card
 * explains it (and leads owners/admins to the bot page). The chat id and
 * the Telegram name never reach the client; the link token only lives in
 * memory while the link is on screen.
 */
export function TelegramChannelSection({
  orgId,
  orgSlug,
  userId,
  isAdmin,
  onSaved,
}: TelegramChannelSectionProps) {
  const { t } = useTranslation('notifications');
  const format = useFormatters();
  const queryClient = useQueryClient();
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const openRef = useRef<HTMLAnchorElement>(null);
  const channels = useQuery(userChannelsQuery(orgId));
  const [link, setLink] = useState<(TelegramLinkDto & { readonly createdAt: number }) | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const linked = channels.data?.items.some(
    (item) => isTelegramChannel(item) && item.status === 'linked',
  );
  const now = useNow(link !== null && linked !== true);
  const serverFresh = link !== null && channels.dataUpdatedAt > link.createdAt;
  const view: TelegramView | null =
    channels.data === undefined ? null : telegramView(channels.data, link, now, serverFresh);
  const kind = view?.kind ?? null;

  useRealtimeChannel(userChannel(userId as Id<'usr'>), {
    onMessage: (message) => {
      if (message.type !== 'channel.changed' || message.organization_id !== orgId) return;
      void queryClient.invalidateQueries({ queryKey: keys.userChannels(orgId) });
    },
    onReconnect: () => {
      void queryClient.invalidateQueries({ queryKey: keys.userChannels(orgId) });
    },
  });

  // What changed without the user doing anything (link expired, bot
  // blocked) is said by the card's own status region, derived from the state
  // (its first content is not announced, its changes are).
  const announcement =
    kind === 'linking'
      ? t('settings.telegram.announce.waiting')
      : kind === 'expired'
        ? t('settings.telegram.announce.expired')
        : kind === 'error'
          ? t('settings.telegram.announce.error')
          : '';
  // Linked from the phone: the page's "Saved: …" says it (visible, announced
  // once); the keyboard focus stays on the card when its control went away.
  const previous = useRef<string | null>(null);
  useEffect(() => {
    if (kind === null) return;
    const before = previous.current;
    previous.current = kind;
    if (before === null || before === kind) return;
    if (kind === 'linked') onSaved(t('settings.telegram.announce.linked'));
    if (kind === 'linking') {
      openRef.current?.focus();
    } else if (
      document.activeElement === null ||
      document.activeElement === document.body ||
      !document.activeElement.isConnected
    ) {
      headingRef.current?.focus();
    }
  }, [kind, onSaved, t]);

  const create = useMutation({
    mutationFn: () => userChannelsApi.createTelegramLink(orgId),
    onSuccess: (created) => {
      // Only a `t.me` link is ever shown or encoded.
      if (!isTelegramLink(created.link)) return;
      setLink({ ...created, createdAt: Date.now() });
      void queryClient.invalidateQueries({ queryKey: keys.userChannels(orgId) });
    },
    onError: () => {
      // `TELEGRAM_NOT_CONFIGURED`: the bot was just removed — show it.
      void queryClient.invalidateQueries({ queryKey: keys.userChannels(orgId) });
    },
  });
  const unlink = useMutation({
    mutationFn: () => userChannelsApi.unlinkTelegram(orgId),
    onSuccess: () => {
      const wasLinked = view?.kind === 'linked' || view?.kind === 'error';
      setLink(null);
      setConfirmUnlink(false);
      create.reset();
      void queryClient.invalidateQueries({ queryKey: keys.userChannels(orgId) });
      onSaved(
        wasLinked
          ? t('settings.telegram.announce.unlinked')
          : t('settings.telegram.announce.cancelled'),
      );
    },
    onError: (error) => {
      setConfirmUnlink(false);
      showErrorToast(error);
    },
  });

  const bot = (name: string | null) => (name === null ? t('settings.telegram.theBot') : `@${name}`);
  const startLink = () => {
    create.mutate();
  };
  const cancelButton = (
    <Button
      variant="ghost"
      data-testid="telegram-cancel"
      className="max-lg:h-control"
      disabled={unlink.isPending}
      onClick={() => {
        unlink.mutate();
      }}
    >
      {t('settings.telegram.cancelLink')}
    </Button>
  );

  let body: ReactNode;
  if (view === null) {
    body = channels.isError ? (
      <ErrorAlert error={channels.error} />
    ) : (
      <div role="status" aria-busy="true" aria-label={t('settings.telegram.loading')}>
        <Skeleton className="h-12" />
      </div>
    );
  } else if (view.kind === 'unavailable') {
    body = (
      <div className="flex flex-col items-start gap-2" data-testid="telegram-unavailable">
        <p className="text-body text-fg-muted">
          {isAdmin ? t('settings.telegram.unavailableAdmin') : t('settings.telegram.unavailable')}
        </p>
        {isAdmin ? (
          <Link
            to={`/o/${encodeURIComponent(orgSlug)}/settings/telegram`}
            data-testid="telegram-setup-bot"
            className={cn(buttonVariants({ variant: 'secondary' }), 'max-lg:h-control')}
          >
            {t('settings.telegram.setupBot')}
          </Link>
        ) : null}
      </div>
    );
  } else if (view.kind === 'linked') {
    body = (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3" data-testid="telegram-linked">
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
          <StateBadge tone="success">{t('settings.telegram.state.linked')}</StateBadge>
          <p className="text-body text-fg">
            {view.linkedAt === null
              ? t('settings.telegram.linkedTo', { bot: bot(view.botUsername) })
              : t('settings.telegram.linkedSince', {
                  bot: bot(view.botUsername),
                  date: format.dateTime(view.linkedAt),
                })}
          </p>
          <p className="text-label font-normal text-fg-muted">
            {t('settings.telegram.linkedHint')}
          </p>
        </div>
        <Button
          variant="secondary"
          data-testid="telegram-unlink"
          className="max-lg:h-control"
          onClick={() => {
            setConfirmUnlink(true);
          }}
        >
          <Unlink aria-hidden="true" />
          {t('settings.telegram.unlink')}
        </Button>
      </div>
    );
  } else if (view.kind === 'error') {
    body = (
      <div className="flex flex-col items-start gap-3" data-testid="telegram-error">
        <StateBadge tone="danger">{t('settings.telegram.state.error')}</StateBadge>
        <p className="text-body text-fg" data-testid="telegram-error-reason">
          {t(`settings.telegram.reason.${view.reason ?? 'unknown'}`, {
            bot: bot(view.botUsername),
          })}
        </p>
        <div className="flex flex-wrap gap-2">
          <LinkButton
            data-testid="telegram-relink"
            label={t('settings.telegram.relink')}
            pending={create.isPending}
            onClick={startLink}
          />
          <Button
            variant="ghost"
            data-testid="telegram-remove"
            className="max-lg:h-control"
            disabled={unlink.isPending}
            onClick={() => {
              setConfirmUnlink(true);
            }}
          >
            {t('settings.telegram.unlink')}
          </Button>
        </div>
      </div>
    );
  } else if (view.kind === 'linking') {
    body = (
      <LinkingPanel
        view={view}
        openRef={openRef}
        expiresAtLabel={new Intl.DateTimeFormat(format.locale, {
          timeStyle: 'short',
          timeZone: format.timeZone,
        }).format(new Date(view.expiresAt))}
        actions={
          <>
            <Button
              variant="secondary"
              data-testid="telegram-new-link"
              className="max-lg:h-control"
              disabled={create.isPending}
              onClick={() => {
                create.mutate();
              }}
            >
              <RefreshCw aria-hidden="true" />
              {t('settings.telegram.newLink')}
            </Button>
            {cancelButton}
          </>
        }
      />
    );
  } else if (view.kind === 'expired') {
    body = (
      <div className="flex flex-col items-start gap-3" data-testid="telegram-expired">
        <StateBadge tone="neutral">{t('settings.telegram.state.expired')}</StateBadge>
        <p className="text-body text-fg-muted">{t('settings.telegram.expired')}</p>
        <div className="flex flex-wrap gap-2">
          <LinkButton
            data-testid="telegram-new-link"
            label={t('settings.telegram.newLink')}
            pending={create.isPending}
            onClick={startLink}
          />
          <Button
            variant="ghost"
            className="max-lg:h-control"
            onClick={() => {
              setLink(null);
            }}
          >
            {t('settings.telegram.close')}
          </Button>
        </div>
      </div>
    );
  } else if (view.kind === 'pending') {
    body = (
      <div className="flex flex-col items-start gap-3" data-testid="telegram-pending">
        <StateBadge tone="warning">{t('settings.telegram.state.pending')}</StateBadge>
        <p className="text-body text-fg-muted">{t('settings.telegram.pendingElsewhere')}</p>
        <div className="flex flex-wrap gap-2">
          <LinkButton
            data-testid="telegram-new-link"
            label={t('settings.telegram.newLink')}
            pending={create.isPending}
            onClick={startLink}
          />
          {cancelButton}
        </div>
      </div>
    );
  } else {
    body = (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3" data-testid="telegram-unlinked">
        <p className="min-w-0 flex-1 basis-64 text-body text-fg-muted">
          {t('settings.telegram.intro')}
        </p>
        <LinkButton
          data-testid="telegram-link"
          label={t('settings.telegram.link')}
          pending={create.isPending}
          onClick={startLink}
        />
      </div>
    );
  }

  return (
    <section
      id={TELEGRAM_SECTION_ID}
      aria-labelledby={headingId}
      data-testid="telegram-channel"
      className="flex scroll-mt-4 flex-col gap-4 rounded-lg border border-line bg-surface p-4 sm:p-6"
    >
      <div className="flex flex-col gap-1">
        <h2
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="flex items-center gap-2 text-heading outline-none"
        >
          <Send aria-hidden="true" className="size-4 text-fg-muted" />
          {t('settings.telegram.title')}
        </h2>
        <p className="text-label font-normal text-fg-muted">{t('settings.telegram.description')}</p>
      </div>
      <p role="status" aria-atomic="true" className="sr-only" data-testid="telegram-announce">
        {announcement}
      </p>
      {body}
      {create.isError ? <ErrorAlert error={create.error} /> : null}
      <Dialog
        open={confirmUnlink}
        role="alertdialog"
        layout="sheet"
        className="max-w-lg"
        onOpenChange={(open) => {
          if (!open) setConfirmUnlink(false);
        }}
        title={t('settings.telegram.confirm.title')}
        description={t('settings.telegram.confirm.description')}
        closeLabel={t('settings.telegram.close')}
      >
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              setConfirmUnlink(false);
            }}
          >
            {t('settings.telegram.confirm.keep')}
          </Button>
          <Button
            variant="danger"
            data-testid="telegram-unlink-confirm"
            disabled={unlink.isPending}
            onClick={() => {
              unlink.mutate();
            }}
          >
            {unlink.isPending ? <Spinner /> : null}
            {t('settings.telegram.confirm.unlink')}
          </Button>
        </div>
      </Dialog>
    </section>
  );
}

/**
 * A link is waiting (this tab made it): open it in Telegram (new tab — on a
 * phone the Telegram app) or scan the QR code with a phone, press Start;
 * the countdown is visual only (a screen reader hears the expiry time once,
 * and the state change when it happens — not a tick per second).
 */
function LinkingPanel({
  view,
  openRef,
  expiresAtLabel,
  actions,
}: {
  readonly view: Extract<TelegramView, { kind: 'linking' }>;
  readonly openRef: RefObject<HTMLAnchorElement | null>;
  readonly expiresAtLabel: string;
  readonly actions: ReactNode;
}) {
  const { t } = useTranslation('notifications');
  const bot = view.botUsername === null ? t('settings.telegram.theBot') : `@${view.botUsername}`;
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start" data-testid="telegram-linking">
      <div className="hidden shrink-0 flex-col items-center gap-1.5 sm:flex">
        <Suspense fallback={<Skeleton className="size-40" />}>
          <QrCode value={view.link} label={t('settings.telegram.qrLabel', { bot })} />
        </Suspense>
        <span className="text-label font-normal text-fg-muted">
          {t('settings.telegram.qrHint')}
        </span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <StateBadge tone="warning">{t('settings.telegram.state.waiting')}</StateBadge>
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-body text-fg">
          <li>
            <span className="sm:hidden">{t('settings.telegram.stepOpenPhone')}</span>
            <span className="hidden sm:inline">{t('settings.telegram.stepOpen')}</span>
          </li>
          <li>{t('settings.telegram.stepStart', { bot })}</li>
        </ol>
        <a
          ref={openRef}
          href={view.link}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="telegram-open"
          aria-label={`${t('settings.telegram.open')} ${t('settings.telegram.newTab')}`}
          className={cn(buttonVariants({ variant: 'primary' }), 'w-fit max-lg:h-control')}
        >
          <ExternalLink aria-hidden="true" />
          {t('settings.telegram.open')}
        </a>
        <p
          className="flex items-center gap-2 text-label font-normal text-fg-muted"
          data-testid="telegram-waiting"
        >
          <Spinner />
          {t('settings.telegram.waiting')}
        </p>
        <p className="flex items-center gap-2 text-label font-normal text-fg-muted">
          <Link2 aria-hidden="true" className="size-3.5 shrink-0" />
          <span aria-hidden="true" data-testid="telegram-countdown">
            {t('settings.telegram.countdown', { time: countdownLabel(view.remainingMs) })}
          </span>
          <span className="sr-only">
            {t('settings.telegram.expiresAt', { time: expiresAtLabel })}
          </span>
        </p>
        <div className="flex flex-wrap gap-2">{actions}</div>
      </div>
    </div>
  );
}
