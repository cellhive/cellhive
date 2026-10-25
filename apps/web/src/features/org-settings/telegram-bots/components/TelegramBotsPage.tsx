import { Button, cn, Skeleton } from '@cellhive/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Bot, Pencil, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { useDocumentTitle } from '../../../../lib/a11y/use-document-title';
import { secretsApi } from '../../../../lib/api/secrets';
import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../../lib/i18n/format';
import { PAGE_GUTTER, PageHeading } from '../../../../lib/layout/page-heading';
import { notFound } from '../../../../lib/navigation/not-found';
import { keys } from '../../../../lib/query/keys';
import { orgBasesQuery } from '../../../../lib/query/queries';
import { meQuery } from '../../../../lib/session/session';
import { showToast } from '../../../../lib/toast/toast';
import { orgNotificationChannelsQuery } from '../notification-bot/api';
import { fellBackToPolling } from '../notification-bot/delivery-mode';
import { NotificationBotSection } from '../notification-bot/NotificationBotSection';

import { BotFormDialog, DeleteBotDialog } from './BotDialogs';

import type { SecretDto } from '@cellhive/contracts';

/**
 * `/o/:orgSlug/settings/telegram` (BACKLOG T516, CONTRACTS §24): the
 * organization's Telegram bots for `send_telegram` — name, the bases they
 * may be used in, who added them; add, change (token write-only), delete
 * (refused while automations use the bot). T555: the "Notification bot"
 * section on top chooses the bot that sends members their notifications;
 * that bot is labelled in the list and cannot be deleted. Owners/admins only (guard
 * `orgSettings` of the layout; others get the 404 screen).
 */
export function TelegramBotsPage() {
  const { t } = useTranslation('telegramBots');
  const format = useFormatters();
  const { orgSlug } = useParams();
  const me = useQuery(meQuery());
  const org = me.data?.orgs.find((item) => item.slug === orgSlug);
  const orgId = org?.id ?? '';
  const enabled = org !== undefined;
  const list = useQuery({
    queryKey: keys.orgSecrets(orgId),
    queryFn: ({ signal }) => secretsApi.list(orgId, signal),
    enabled,
  });
  const bases = useQuery({ ...orgBasesQuery(orgId), enabled });
  const channels = useQuery({ ...orgNotificationChannelsQuery(orgId), enabled });
  const notificationBotId = channels.data?.telegram.secret_id ?? null;
  const baseNames = useMemo(
    () => new Map((bases.data ?? []).map((base) => [base.id, base.name] as const)),
    [bases.data],
  );
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<'new' | SecretDto | null>(null);
  const [deleting, setDeleting] = useState<SecretDto | null>(null);
  useDocumentTitle(org === undefined ? undefined : `${t('page.title')} · ${org.name}`);

  if (me.data !== undefined && org === undefined) notFound();
  if (org === undefined) return null;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.orgSecrets(orgId) });
  };
  // The organization's secrets include HTTP ones (T606): this page lists the bots only.
  const bots = list.data?.items.filter((item) => item.kind === 'telegram_bot');
  const items = bots ?? [];
  const scopeText = (bot: SecretDto) =>
    bot.base_scope === 'all'
      ? t('scope.all')
      : bot.base_ids.map((id) => baseNames.get(id) ?? t('scope.unknownBase')).join(', ') ||
        t('scope.none');
  const add = () => {
    setEditing('new');
  };

  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <PageHeading
        back={{
          to: `/o/${encodeURIComponent(org.slug)}`,
          label: t('page.back', { name: org.name }),
        }}
        icon={Bot}
        title={t('page.title')}
        subtitle={t('page.subtitle')}
        actions={
          <Button data-testid="bot-add" onClick={add}>
            <Plus aria-hidden="true" />
            {t('page.add')}
          </Button>
        }
      />
      <div className={cn('flex flex-col gap-4 py-6', PAGE_GUTTER)}>
        <NotificationBotSection orgId={orgId} bots={bots} />
        <h2 className="sr-only">{t('page.listHeading')}</h2>
        {list.isPending ? (
          <div
            role="status"
            aria-busy="true"
            aria-label={t('page.loading')}
            className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4"
          >
            {[0, 1].map((row) => (
              <Skeleton key={row} className="h-12" />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : items.length === 0 ? (
          <section
            data-testid="bots-empty"
            className="flex flex-col items-start gap-2.5 rounded-lg border border-line bg-surface p-6"
          >
            <span className="flex size-10 items-center justify-center rounded-lg bg-accent-soft text-accent">
              <Bot aria-hidden="true" className="size-5" />
            </span>
            <h2 className="text-heading">{t('page.emptyTitle')}</h2>
            <p className="text-body text-fg-muted">{t('page.empty')}</p>
            <Button variant="secondary" onClick={add}>
              <Plus aria-hidden="true" />
              {t('page.add')}
            </Button>
          </section>
        ) : (
          <ul
            aria-label={t('page.title')}
            className="flex flex-col rounded-lg border border-line bg-surface"
            data-testid="bot-list"
          >
            {items.map((bot) => (
              <li
                key={bot.id}
                data-testid="bot-row"
                className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-4 py-3 first:border-t-0"
              >
                <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate font-medium text-fg">{bot.name}</span>
                    {bot.id === notificationBotId ? (
                      <span
                        data-testid="bot-notification-label"
                        className="inline-flex w-fit items-center gap-1 rounded-sm bg-accent-soft px-1.5 py-0.5 text-label font-medium whitespace-nowrap text-accent"
                      >
                        <Bell aria-hidden="true" className="size-3.5 shrink-0" />
                        {t('notificationBot.label')}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-label font-normal text-fg-muted">
                    {t('page.scopeLine', { scope: scopeText(bot) })}
                  </span>
                  <span className="text-label font-normal text-fg-muted">
                    {t('page.addedBy', {
                      name: bot.created_by?.name ?? t('page.unknownUser'),
                      date: format.dateTime(bot.created_at),
                    })}
                  </span>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="secondary"
                    aria-label={t('page.edit', { name: bot.name })}
                    onClick={() => {
                      setEditing(bot);
                    }}
                  >
                    <Pencil aria-hidden="true" />
                    {t('page.editShort')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('page.delete', { name: bot.name })}
                    data-testid="bot-delete"
                    onClick={() => {
                      setDeleting(bot);
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="text-label font-normal text-fg-muted">{t('page.whoSees')}</p>
      </div>
      <BotFormDialog
        orgId={orgId}
        state={editing}
        bases={bases.data}
        notificationBotId={notificationBotId}
        notificationBotMode={channels.data?.telegram.delivery_mode ?? null}
        onClose={() => {
          setEditing(null);
        }}
        onSaved={(bot, created) => {
          setEditing(null);
          refresh();
          showToast({
            variant: 'success',
            message: t(created ? 'toast.added' : 'toast.saved', { name: bot.name }),
          });
          if (bot.id === notificationBotId) {
            // T609: another bot's token puts the notification bot back to polling — say so.
            const before = channels.data?.telegram.delivery_mode;
            void queryClient
              .query({ ...orgNotificationChannelsQuery(orgId), staleTime: 0 })
              .then((after) => {
                if (fellBackToPolling(before, after.telegram.delivery_mode)) {
                  showToast({ variant: 'info', message: t('notificationBot.mode.toast.fellBack') });
                }
              })
              .catch(() => undefined);
          }
        }}
      />
      <DeleteBotDialog
        orgId={orgId}
        bot={deleting}
        notificationBotId={notificationBotId}
        onClose={() => {
          setDeleting(null);
        }}
        onDeleted={(bot) => {
          setDeleting(null);
          refresh();
          showToast({ variant: 'success', message: t('toast.deleted', { name: bot.name }) });
        }}
      />
    </div>
  );
}

export default TelegramBotsPage;
