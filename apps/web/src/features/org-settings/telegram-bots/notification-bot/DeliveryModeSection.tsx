import { Button, cn, Spinner } from '@cellhive/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, Clock } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { keys } from '../../../../lib/query/keys';
import { showToast } from '../../../../lib/toast/toast';
import { Note } from '../../email-identities/components/parts';

import { notificationChannelsApi } from './api';
import { DELIVERY_MODES, deliveryModeErrorOf } from './delivery-mode';

import type {
  OrgNotificationChannelsDto,
  TelegramDeliveryMode,
  TelegramWebhookStatus,
} from '@cellhive/contracts';

const WEBHOOK_STYLE: Record<
  TelegramWebhookStatus | 'unknown',
  { icon: typeof Clock; className: string }
> = {
  ok: { icon: CircleCheck, className: 'bg-option-2 text-on-option-2' },
  error: { icon: CircleAlert, className: 'bg-danger/10 text-danger' },
  unknown: { icon: Clock, className: 'bg-option-0 text-on-option-0' },
};

/** What the hourly check last saw of the webhook: icon + word, never color alone. */
function WebhookStatusBadge({ status }: { readonly status: TelegramWebhookStatus | null }) {
  const { t } = useTranslation('telegramBots');
  const key = status ?? 'unknown';
  const { icon: Icon, className } = WEBHOOK_STYLE[key];
  return (
    <span
      data-testid="delivery-mode-webhook-status"
      data-status={key}
      className={cn(
        'inline-flex w-fit items-center gap-1 rounded-sm px-1.5 py-0.5 text-label font-medium whitespace-nowrap',
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {t(`notificationBot.mode.webhookStatus.${key}`)}
    </span>
  );
}

export interface DeliveryModeSectionProps {
  readonly orgId: string;
  readonly telegram: OrgNotificationChannelsDto['telegram'];
}

/**
 * How the notification bot receives `/start` and `/stop` (BACKLOG T614,
 * CONTRACTS §22.7, ADR-35 §7; board "S5c · Integrations settings" not drawn
 * yet — built like the radio rows of FRONTEND §15.3): polling (default) or
 * webhook, saved with "Apply". The webhook choice is off, with why, when
 * the server says the instance cannot use it (`webhook_available: false`,
 * T616) — or, as a fallback, once a save is refused with
 * `PUBLIC_URL_NOT_HTTPS` (for the rest of the visit). A webhook of the bot
 * set elsewhere (`TELEGRAM_WEBHOOK_CONFLICT`) is explained step by step. In
 * webhook mode the state of the hourly check (`webhook_status`) is shown.
 */
export function DeliveryModeSection({ orgId, telegram }: DeliveryModeSectionProps) {
  const { t } = useTranslation('telegramBots');
  const queryClient = useQueryClient();
  const name = useId();
  const unavailableId = useId();
  const current: TelegramDeliveryMode = telegram.delivery_mode ?? 'polling';
  const [choice, setChoice] = useState<TelegramDeliveryMode | null>(null);
  const [refusedHere, setRefusedHere] = useState(false);
  const webhookUnavailable = refusedHere || !telegram.webhook_available;
  const selected = choice ?? current;
  const save = useMutation({
    mutationFn: (mode: TelegramDeliveryMode) =>
      notificationChannelsApi.update(orgId, { telegram_delivery_mode: mode }),
    onSuccess: (saved) => {
      queryClient.setQueryData(keys.orgNotificationChannels(orgId), saved);
      setChoice(null);
      showToast({
        variant: 'success',
        message:
          saved.telegram.delivery_mode === 'webhook'
            ? t('notificationBot.mode.toast.webhook')
            : t('notificationBot.mode.toast.polling'),
      });
    },
    onError: (error) => {
      if (deliveryModeErrorOf(error) === 'public_url') {
        setRefusedHere(true);
        setChoice(null);
      }
    },
  });
  const failure = save.isError ? deliveryModeErrorOf(save.error) : null;
  const changed = selected !== current;

  return (
    <form
      className="flex flex-col gap-3 border-t border-line pt-4"
      data-testid="delivery-mode"
      data-mode={current}
      onSubmit={(event) => {
        event.preventDefault();
        if (changed) save.mutate(selected);
      }}
    >
      <fieldset className="flex flex-col gap-3" disabled={save.isPending}>
        <legend className="mb-1 text-body font-medium text-fg">
          {t('notificationBot.mode.legend')}
        </legend>
        {DELIVERY_MODES.map((mode) => {
          const hintId = `${name}-${mode}`;
          const off = mode === 'webhook' && webhookUnavailable && current !== 'webhook';
          return (
            <label
              key={mode}
              className={cn(
                'flex min-h-control items-start gap-2.5 lg:min-h-0',
                off ? 'cursor-not-allowed text-fg-muted' : 'cursor-pointer',
              )}
            >
              <input
                type="radio"
                name={name}
                value={mode}
                data-testid={`delivery-mode-${mode}`}
                checked={selected === mode}
                disabled={off}
                aria-describedby={off ? `${hintId} ${unavailableId}` : hintId}
                className="mt-0.5 size-4 shrink-0 accent-accent"
                onChange={() => {
                  save.reset();
                  setChoice(mode);
                }}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body font-medium">
                  {t(`notificationBot.mode.${mode}`)}
                  {mode === current ? (
                    <span className="text-label font-normal text-fg-muted">
                      {t('notificationBot.mode.current')}
                    </span>
                  ) : null}
                </span>
                <span id={hintId} className="text-label font-normal text-fg-muted">
                  {t(`notificationBot.mode.${mode}Hint`)}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>
      {webhookUnavailable && current !== 'webhook' ? (
        <p
          id={unavailableId}
          className="text-label font-normal text-fg-muted"
          data-testid="delivery-mode-unavailable"
        >
          {t('notificationBot.mode.unavailable')}
        </p>
      ) : null}
      {current === 'webhook' ? (
        <div className="flex flex-col gap-2" data-testid="delivery-mode-webhook-state">
          <div className="flex flex-wrap items-center gap-2 text-label font-normal">
            <span className="text-fg-muted">{t('notificationBot.mode.webhookStatusLabel')}</span>
            <WebhookStatusBadge status={telegram.webhook_status} />
          </div>
          {telegram.webhook_status === 'error' ? (
            <Note
              tone="danger"
              title={t('notificationBot.mode.webhookError.title')}
              data-testid="delivery-mode-webhook-error"
            >
              <span>{t('notificationBot.mode.webhookError.body')}</span>
            </Note>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          variant="secondary"
          data-testid="delivery-mode-save"
          className="max-lg:h-control"
          disabled={!changed || save.isPending}
        >
          {save.isPending ? <Spinner /> : null}
          {t('notificationBot.mode.apply')}
        </Button>
      </div>
      {failure === 'public_url' ? (
        <Note
          tone="danger"
          role="alert"
          title={t('notificationBot.mode.publicUrl.title')}
          data-testid="delivery-mode-error"
        >
          <span>{t('notificationBot.mode.publicUrl.body')}</span>
        </Note>
      ) : failure === 'conflict' ? (
        <Note
          tone="warning"
          role="alert"
          title={t('notificationBot.mode.conflict.title')}
          data-testid="delivery-mode-error"
        >
          <span>{t('notificationBot.mode.conflict.intro')}</span>
          <ol className="list-decimal pl-5">
            <li>{t('notificationBot.mode.conflict.step1')}</li>
            <li>{t('notificationBot.mode.conflict.step2')}</li>
          </ol>
          <span>{t('notificationBot.mode.conflict.meanwhile')}</span>
        </Note>
      ) : save.isError ? (
        <ErrorAlert error={save.error} />
      ) : null}
    </form>
  );
}
