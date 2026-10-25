import { Button, cn, Dialog, Select, Skeleton, Spinner } from '@cellhive/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CircleAlert, CircleCheck, Clock, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { keys } from '../../../../lib/query/keys';
import { showToast } from '../../../../lib/toast/toast';
import { Note } from '../../email-identities/components/parts';

import { notificationChannelsApi, orgNotificationChannelsQuery } from './api';
import { DeliveryModeSection } from './DeliveryModeSection';

import type { OrgNotificationChannelsDto, SecretDto, TelegramBotStatus } from '@cellhive/contracts';

/** Value of the "no bot" option of the select. */
const NONE = '';

const STATUS_STYLE: Record<
  TelegramBotStatus | 'unknown',
  { icon: typeof Clock; className: string }
> = {
  ok: { icon: CircleCheck, className: 'bg-option-2 text-on-option-2' },
  webhook_conflict: { icon: TriangleAlert, className: 'bg-option-3 text-on-option-3' },
  invalid_token: { icon: CircleAlert, className: 'bg-danger/10 text-danger' },
  unknown: { icon: Clock, className: 'bg-option-0 text-on-option-0' },
};

/** State of the notification bot: icon + word, never color alone (FRONTEND §9.2). */
function BotStatusBadge({ status }: { readonly status: TelegramBotStatus | null }) {
  const { t } = useTranslation('telegramBots');
  const key = status ?? 'unknown';
  const { icon: Icon, className } = STATUS_STYLE[key];
  return (
    <span
      data-testid="notification-bot-status"
      data-status={key}
      className={cn(
        'inline-flex w-fit items-center gap-1 rounded-sm px-1.5 py-0.5 text-label font-medium whitespace-nowrap',
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {t(`notificationBot.status.${key}`)}
    </span>
  );
}

export interface NotificationBotSectionProps {
  readonly orgId: string;
  /** The organization's `telegram_bot` secrets (`undefined` while loading). */
  readonly bots: readonly SecretDto[] | undefined;
}

/**
 * "Notification bot" of the Telegram bots page (BACKLOG T555, FRONTEND
 * §15.4, CONTRACTS §22.7): which `telegram_bot` secret of the organization
 * sends members their notifications, its `@username` and the state the
 * poller last saw (`ok`, `webhook_conflict`, `invalid_token`) with what to
 * do about it. Changing or removing the bot breaks every member's link
 * (`bot_changed`), so that is confirmed first; choosing the first bot is not.
 */
export function NotificationBotSection({ orgId, bots }: NotificationBotSectionProps) {
  const { t } = useTranslation('telegramBots');
  const headingId = useId();
  const selectId = useId();
  const hintId = useId();
  const queryClient = useQueryClient();
  const channels = useQuery(orgNotificationChannelsQuery(orgId));
  const current = channels.data?.telegram.secret_id ?? null;
  const [choice, setChoice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const selected = choice ?? current ?? NONE;
  const save = useMutation({
    mutationFn: (secretId: string | null) =>
      notificationChannelsApi.update(orgId, {
        telegram_secret_id: secretId as OrgNotificationChannelsDto['telegram']['secret_id'],
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(keys.orgNotificationChannels(orgId), saved);
      // The bot's usages changed (a `notification_channel` entry moved).
      void queryClient.invalidateQueries({ queryKey: keys.orgSecrets(orgId) });
      setChoice(null);
      setConfirming(false);
      showToast({
        variant: 'success',
        message:
          saved.telegram.bot_username === null
            ? t('notificationBot.toast.removed')
            : t('notificationBot.toast.saved', { username: saved.telegram.bot_username }),
      });
    },
    onError: () => {
      setConfirming(false);
    },
  });
  const changed = selected !== (current ?? NONE);
  const submit = () => {
    if (!changed) return;
    // Choosing the first bot breaks nothing; changing or removing it does.
    if (current !== null) setConfirming(true);
    else save.mutate(selected === NONE ? null : selected);
  };
  const botName = (secretId: string | null) =>
    secretId === null ? null : (bots?.find((bot) => bot.id === secretId)?.name ?? null);
  const telegram = channels.data?.telegram;

  return (
    <section
      aria-labelledby={headingId}
      data-testid="notification-bot"
      className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4 sm:p-6"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Bell aria-hidden="true" className="size-4.5" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={headingId} className="text-heading">
            {t('notificationBot.title')}
          </h2>
          <p className="text-label font-normal text-fg-muted">{t('notificationBot.description')}</p>
        </div>
      </div>
      {channels.isPending ? (
        <div role="status" aria-busy="true" aria-label={t('notificationBot.loading')}>
          <Skeleton className="h-16" />
        </div>
      ) : channels.isError ? (
        <ErrorAlert error={channels.error} />
      ) : (
        <>
          {telegram === undefined || telegram.secret_id === null ? (
            <p data-testid="notification-bot-none" className="text-body text-fg-muted">
              {t('notificationBot.none')}
            </p>
          ) : (
            <div className="flex flex-col gap-3" data-testid="notification-bot-current">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span
                  className="font-medium break-all text-fg"
                  data-testid="notification-bot-username"
                >
                  {telegram.bot_username === null ? '—' : `@${telegram.bot_username}`}
                </span>
                {botName(telegram.secret_id) === null ? null : (
                  <span className="text-label font-normal text-fg-muted">
                    {t('notificationBot.secretName', { name: botName(telegram.secret_id) })}
                  </span>
                )}
                <BotStatusBadge status={telegram.status} />
              </div>
              {telegram.status === 'webhook_conflict' ? (
                <Note
                  tone="warning"
                  title={t('notificationBot.webhookConflict.title')}
                  data-testid="notification-bot-guidance"
                >
                  <span>{t('notificationBot.webhookConflict.body')}</span>
                </Note>
              ) : telegram.status === 'invalid_token' ? (
                <Note
                  tone="danger"
                  title={t('notificationBot.invalidToken.title')}
                  data-testid="notification-bot-guidance"
                >
                  <span>{t('notificationBot.invalidToken.body')}</span>
                </Note>
              ) : null}
            </div>
          )}
          {bots !== undefined && bots.length === 0 ? (
            <p
              className="text-label font-normal text-fg-muted"
              data-testid="notification-bot-no-bots"
            >
              {t('notificationBot.noBots')}
            </p>
          ) : (
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <label htmlFor={selectId} className="text-label text-fg">
                {t('notificationBot.select')}
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  id={selectId}
                  data-testid="notification-bot-select"
                  className="w-full min-w-0 sm:w-80"
                  aria-describedby={hintId}
                  disabled={bots === undefined || save.isPending}
                  value={selected}
                  onChange={(event) => {
                    save.reset();
                    setChoice(event.target.value);
                  }}
                >
                  <option value={NONE}>{t('notificationBot.noneOption')}</option>
                  {(bots ?? []).map((bot) => (
                    <option key={bot.id} value={bot.id}>
                      {bot.name}
                    </option>
                  ))}
                </Select>
                <Button
                  type="submit"
                  data-testid="notification-bot-save"
                  className="max-lg:h-control"
                  disabled={!changed || save.isPending}
                >
                  {save.isPending && !confirming ? <Spinner /> : null}
                  {t('notificationBot.save')}
                </Button>
              </div>
              <span id={hintId} className="text-label font-normal text-fg-muted">
                {current === null
                  ? t('notificationBot.hintFirst')
                  : t('notificationBot.hintChange')}
              </span>
            </form>
          )}
          {save.isError ? <ErrorAlert error={save.error} /> : null}
          {telegram === undefined || telegram.secret_id === null ? null : (
            // T614: how the bot receives /start and /stop (polling or webhook).
            <DeliveryModeSection orgId={orgId} telegram={telegram} />
          )}
        </>
      )}
      <Dialog
        open={confirming}
        role="alertdialog"
        layout="sheet"
        className="max-w-lg"
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
        title={
          selected === NONE
            ? t('notificationBot.confirm.removeTitle')
            : t('notificationBot.confirm.changeTitle')
        }
        description={t('notificationBot.confirm.description')}
        closeLabel={t('form.close')}
      >
        <div className="flex flex-col gap-4">
          <p className="text-body text-fg">
            {selected === NONE
              ? t('notificationBot.confirm.removeBody')
              : t('notificationBot.confirm.changeBody', {
                  name: botName(selected) ?? '',
                })}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setConfirming(false);
              }}
            >
              {t('form.cancel')}
            </Button>
            <Button
              variant="danger"
              data-testid="notification-bot-confirm"
              disabled={save.isPending}
              onClick={() => {
                save.mutate(selected === NONE ? null : selected);
              }}
            >
              {save.isPending ? <Spinner /> : null}
              {selected === NONE
                ? t('notificationBot.confirm.remove')
                : t('notificationBot.confirm.change')}
            </Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
}
