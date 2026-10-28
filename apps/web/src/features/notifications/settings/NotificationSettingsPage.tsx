import { Button, cn, Select, Skeleton, Switch } from '@cellhive/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCircle2, Database, Info, Lock, Send } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { useDocumentTitle } from '../../../lib/a11y/use-document-title';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { PAGE_GUTTER, PageHeading } from '../../../lib/layout/page-heading';
import { notFound } from '../../../lib/navigation/not-found';
import { isOrgAdmin } from '../../../lib/permissions/org';
import { keys } from '../../../lib/query/keys';
import { meQuery, setupStatusQuery } from '../../../lib/session/session';
import { showErrorToast } from '../../../lib/toast/toast';
import { notificationPreferencesQuery, notificationSettingsQuery, notificationsApi } from '../api';
import { EMAIL_FREQUENCY_OPTIONS } from '../model/items';

import { hourLabel, timeZoneLabel } from './format';
import { userChannelsQuery } from './telegram/api';
import { isTelegramChannel } from './telegram/model';
import { TELEGRAM_SECTION_ID, TelegramChannelSection } from './telegram/TelegramChannelSection';

import type {
  EmailFrequency,
  NotificationChannel,
  NotificationPreferencesDto,
  NotificationSettingsDto,
  NotificationType,
} from '@cellhive/contracts';

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

function Section({
  title,
  description,
  children,
  'data-testid': testId,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  readonly 'data-testid': string;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4 sm:p-6"
    >
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-heading">
          {title}
        </h2>
        {description === undefined ? null : (
          <p className="text-label font-normal text-fg-muted">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

/** "Saved: …" after each change (board "S5 · Notification settings": "After a change"). */
function useSavedMessage() {
  const [message, setMessage] = useState<string | null>(null);
  return { message, setMessage };
}

function EmailFrequencySection({
  orgId,
  settings,
  timeZone,
  onSaved,
}: {
  readonly orgId: string;
  readonly settings: NotificationSettingsDto;
  readonly timeZone: string;
  readonly onSaved: (message: string) => void;
}) {
  const { t, i18n } = useTranslation('notifications');
  const queryClient = useQueryClient();
  const name = useId();
  const save = useMutation({
    mutationFn: (body: { email_frequency?: EmailFrequency; daily_hour?: number }) =>
      notificationsApi.updateSettings(orgId, body),
    onMutate: (body) => {
      const key = keys.notificationSettings(orgId);
      const before = queryClient.getQueryData<NotificationSettingsDto>(key);
      if (before !== undefined) queryClient.setQueryData(key, { ...before, ...body });
      return { before };
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(keys.notificationSettings(orgId), saved);
      onSaved(
        saved.email_frequency === 'daily'
          ? t('settings.saved.daily', { time: hourLabel(saved.daily_hour, i18n.language) })
          : t(`settings.saved.${saved.email_frequency}`),
      );
    },
    onError: (error, _body, context) => {
      if (context?.before !== undefined) {
        queryClient.setQueryData(keys.notificationSettings(orgId), context.before);
      }
      showErrorToast(error);
    },
  });
  return (
    <Section
      data-testid="email-frequency"
      title={t('settings.email.title')}
      description={t('settings.email.description')}
    >
      <div
        role="radiogroup"
        aria-label={t('settings.email.frequency')}
        className="flex flex-col gap-3"
      >
        {EMAIL_FREQUENCY_OPTIONS.map((frequency) => {
          const hintId = `${name}-${frequency}-hint`;
          return (
            <div key={frequency} className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <label className="flex min-h-control min-w-0 flex-1 cursor-pointer items-start gap-2.5 lg:min-h-0">
                <input
                  type="radio"
                  name={name}
                  value={frequency}
                  data-testid={`frequency-${frequency}`}
                  aria-describedby={hintId}
                  checked={settings.email_frequency === frequency}
                  className="mt-0.5 size-4 shrink-0"
                  onChange={() => {
                    save.mutate({ email_frequency: frequency });
                  }}
                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-body font-medium">{t(`settings.email.${frequency}`)}</span>
                  <span id={hintId} className="text-label font-normal text-fg-muted">
                    {t(`settings.email.${frequency}Hint`)}
                  </span>
                </span>
              </label>
              {frequency === 'daily' ? (
                <div className="flex items-center gap-2 pl-6.5 sm:pl-0">
                  <Select
                    aria-label={t('settings.email.hour')}
                    data-testid="daily-hour"
                    className="w-28"
                    disabled={settings.email_frequency !== 'daily'}
                    value={String(settings.daily_hour)}
                    onChange={(event) => {
                      save.mutate({ daily_hour: Number(event.target.value) });
                    }}
                  >
                    {HOURS.map((hour) => (
                      <option key={hour} value={hour}>
                        {hourLabel(hour, i18n.language)}
                      </option>
                    ))}
                  </Select>
                  <span className="text-label font-normal text-fg-muted">
                    {timeZoneLabel(timeZone, i18n.language)}
                  </span>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

/** Moves to the Telegram card and its first action (the "Link Telegram" shortcut, T555). */
function goToTelegramSection(): void {
  const section = document.getElementById(TELEGRAM_SECTION_ID);
  if (section === null) return;
  section.scrollIntoView({ block: 'start' });
  const target =
    section.querySelector<HTMLElement>('button:not([disabled]), a[href]') ??
    section.querySelector<HTMLElement>('h2');
  target?.focus();
}

function PreferencesSection({
  orgId,
  preferences,
  emailEnabled,
  telegramLinked,
  onSaved,
}: {
  readonly orgId: string;
  readonly preferences: NotificationPreferencesDto;
  readonly emailEnabled: boolean;
  /** T555: the Telegram column (only when the organization has a bot) needs a linked chat. */
  readonly telegramLinked: boolean;
  readonly onSaved: (message: string) => void;
}) {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();
  const telegramColumn = preferences.items.some((row) => row.channel === 'telegram');
  const channels: NotificationChannel[] = [
    'in_app',
    ...(emailEnabled ? (['email'] as const) : []),
    ...(telegramColumn ? (['telegram'] as const) : []),
  ];
  const telegramNoteId = 'pref-telegram-note';
  const save = useMutation({
    mutationFn: (item: {
      type: NotificationType;
      channel: NotificationChannel;
      enabled: boolean;
    }) => notificationsApi.updatePreferences(orgId, { items: [item] }),
    onMutate: (item) => {
      const key = keys.notificationPreferences(orgId);
      const before = queryClient.getQueryData<NotificationPreferencesDto>(key);
      if (before !== undefined) {
        queryClient.setQueryData(key, {
          items: before.items.map((row) =>
            row.type === item.type && row.channel === item.channel
              ? { ...row, enabled: item.enabled }
              : row,
          ),
        });
      }
      return { before };
    },
    onSuccess: (saved, item) => {
      queryClient.setQueryData(keys.notificationPreferences(orgId), saved);
      onSaved(
        t(item.enabled ? 'settings.saved.channelOn' : 'settings.saved.channelOff', {
          type: t(`types.${item.type}.name`),
          channel: t(`settings.channels.${item.channel}`),
        }),
      );
    },
    onError: (error, _item, context) => {
      if (context?.before !== undefined) {
        queryClient.setQueryData(keys.notificationPreferences(orgId), context.before);
      }
      showErrorToast(error);
    },
  });
  // The types being produced, in the server's order (CONTRACTS §22.3).
  const types = [...new Set(preferences.items.map((row) => row.type))];
  return (
    <Section
      data-testid="preferences"
      title={t('settings.types.title')}
      description={t('settings.types.description')}
    >
      {telegramColumn && !telegramLinked ? (
        <div
          role="note"
          id={telegramNoteId}
          data-testid="pref-telegram-note"
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md bg-surface-sunken px-3 py-2"
        >
          <Send aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
          <span className="min-w-0 flex-1 basis-48 text-label font-normal text-fg">
            {t('settings.telegram.columnNote')}
          </span>
          <Button
            variant="secondary"
            size="sm"
            className="max-lg:h-control"
            data-testid="pref-telegram-link"
            onClick={goToTelegramSection}
          >
            {t('settings.telegram.link')}
          </Button>
        </div>
      ) : null}
      <div className="-mx-4 overflow-x-auto sm:mx-0">
        <table className="w-full border-collapse text-body">
          <caption className="sr-only">{t('settings.types.caption')}</caption>
          <thead>
            <tr className="border-b border-line text-left text-label text-fg-muted">
              <th scope="col" className="px-4 py-2 font-medium sm:pl-0">
                {t('settings.types.type')}
              </th>
              {channels.map((channel) => (
                <th key={channel} scope="col" className="w-24 px-2 py-2 text-center font-medium">
                  {t(`settings.channels.${channel}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {types.map((type) => {
              const descriptionId = `pref-${type}-hint`;
              return (
                <tr
                  key={type}
                  data-testid={`pref-${type}`}
                  className="border-b border-line last:border-b-0"
                >
                  <th scope="row" className="px-4 py-3 text-left font-normal sm:pl-0">
                    <span className="flex flex-col gap-0.5">
                      <span className="font-medium">{t(`types.${type}.name`)}</span>
                      <span id={descriptionId} className="text-label font-normal text-fg-muted">
                        {t(`types.${type}.description`)}
                      </span>
                    </span>
                  </th>
                  {channels.map((channel) => {
                    const row = preferences.items.find(
                      (item) => item.type === type && item.channel === channel,
                    );
                    if (row === undefined) return <td key={channel} />;
                    const unlinked = channel === 'telegram' && !telegramLinked;
                    return (
                      <td key={channel} className="px-2 py-3 text-center">
                        <span className="inline-flex items-center gap-1.5">
                          <Switch
                            checked={row.enabled}
                            disabled={row.locked || unlinked}
                            data-testid={`pref-${type}-${channel}`}
                            aria-label={t('settings.types.switch', {
                              type: t(`types.${type}.name`),
                              channel: t(`settings.channels.${channel}`),
                            })}
                            aria-describedby={
                              unlinked ? `${descriptionId} ${telegramNoteId}` : descriptionId
                            }
                            onChange={(event) => {
                              save.mutate({ type, channel, enabled: event.target.checked });
                            }}
                          />
                          {row.locked ? (
                            <Lock aria-hidden="true" className="size-3.5 text-fg-muted" />
                          ) : null}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

type FollowSetting = 'auto_follow_created' | 'auto_follow_assigned';

const FOLLOW_SETTINGS: readonly { setting: FollowSetting; label: 'created' | 'assigned' }[] = [
  { setting: 'auto_follow_created', label: 'created' },
  { setting: 'auto_follow_assigned', label: 'assigned' },
];

/**
 * "Following records" (T552, CONTRACTS §22.3, §22.5): follow the records I
 * create / I am assigned to. Saved at once like the rest of the page;
 * turning one off stops new follows only.
 */
function FollowSection({
  orgId,
  settings,
  onSaved,
}: {
  readonly orgId: string;
  readonly settings: NotificationSettingsDto;
  readonly onSaved: (message: string) => void;
}) {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();
  const hintId = useId();
  const save = useMutation({
    mutationFn: (body: Partial<Record<FollowSetting, boolean>>) =>
      notificationsApi.updateSettings(orgId, body),
    onMutate: (body) => {
      const key = keys.notificationSettings(orgId);
      const before = queryClient.getQueryData<NotificationSettingsDto>(key);
      if (before !== undefined) queryClient.setQueryData(key, { ...before, ...body });
      return { before };
    },
    onSuccess: (saved, body) => {
      queryClient.setQueryData(keys.notificationSettings(orgId), saved);
      const item = FOLLOW_SETTINGS.find(({ setting }) => setting in body);
      if (item === undefined) return;
      onSaved(
        t(saved[item.setting] ? 'settings.saved.followOn' : 'settings.saved.followOff', {
          name: t(`settings.follow.${item.label}`),
        }),
      );
    },
    onError: (error, _body, context) => {
      if (context?.before !== undefined) {
        queryClient.setQueryData(keys.notificationSettings(orgId), context.before);
      }
      showErrorToast(error);
    },
  });
  return (
    <Section
      data-testid="follow-settings"
      title={t('settings.follow.title')}
      description={t('settings.follow.description')}
    >
      <ul className="flex flex-col">
        {FOLLOW_SETTINGS.map(({ setting, label }) => {
          const descriptionId = `${hintId}-${label}`;
          return (
            <li
              key={setting}
              className="flex items-start gap-3 border-t border-line py-3 first:border-t-0 first:pt-0"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-body font-medium">{t(`settings.follow.${label}`)}</span>
                <span id={descriptionId} className="text-label font-normal text-fg-muted">
                  {t(`settings.follow.${label}Hint`)}
                </span>
              </span>
              <Switch
                checked={settings[setting]}
                data-testid={`follow-${label}`}
                aria-label={t(`settings.follow.${label}`)}
                aria-describedby={descriptionId}
                onChange={(event) => {
                  save.mutate({ [setting]: event.target.checked });
                }}
              />
            </li>
          );
        })}
      </ul>
      <p className="flex items-start gap-2 text-label font-normal text-fg-muted">
        <Info aria-hidden="true" className="mt-px size-4 shrink-0" />
        {t('settings.follow.effect')}
      </p>
    </Section>
  );
}

function MutedBasesSection({
  orgId,
  settings,
  emailEnabled,
  onSaved,
}: {
  readonly orgId: string;
  readonly settings: NotificationSettingsDto;
  readonly emailEnabled: boolean;
  readonly onSaved: (message: string) => void;
}) {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();
  const unmute = useMutation({
    mutationFn: (base: { id: string; name: string }) => notificationsApi.unmute(orgId, base.id),
    onSuccess: (_result, base) => {
      queryClient.setQueryData<NotificationSettingsDto>(keys.notificationSettings(orgId), (data) =>
        data === undefined
          ? data
          : { ...data, muted_bases: data.muted_bases.filter((item) => item.id !== base.id) },
      );
      onSaved(t('settings.saved.unmuted', { name: base.name }));
    },
    onError: (error) => {
      showErrorToast(error);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.notificationSettings(orgId) }),
  });
  return (
    <Section
      data-testid="muted-bases"
      title={t('settings.muted.title')}
      description={t('settings.muted.description')}
    >
      {emailEnabled ? (
        <p className="flex items-start gap-2 text-label font-normal text-fg-muted">
          <Info aria-hidden="true" className="mt-px size-4 shrink-0" />
          {t('settings.muted.effect')}
        </p>
      ) : null}
      {settings.muted_bases.length === 0 ? (
        <p data-testid="muted-empty" className="text-body text-fg-muted">
          {t('settings.muted.empty')}
        </p>
      ) : (
        <ul className="flex flex-col">
          {settings.muted_bases.map((base) => (
            <li
              key={base.id}
              data-testid={`muted-${base.id}`}
              className="flex items-center gap-3 border-t border-line py-2 first:border-t-0"
            >
              <Database aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
              <span className="min-w-0 flex-1 truncate">{base.name}</span>
              <Button
                variant="secondary"
                size="sm"
                className="max-lg:h-control"
                disabled={unmute.isPending}
                aria-label={t('settings.muted.unmuteLabel', { name: base.name })}
                onClick={() => {
                  unmute.mutate(base);
                }}
              >
                {t('settings.muted.unmute')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function LoadingSections() {
  const { t } = useTranslation('notifications');
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t('settings.loading')}
      className="flex flex-col gap-6"
    >
      {[0, 1].map((index) => (
        <div
          key={index}
          className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-6"
        >
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-72 max-w-full" />
          <Skeleton className="h-16" />
        </div>
      ))}
    </div>
  );
}

/**
 * `/o/:orgSlug/settings/notifications` (T524, FRONTEND §14; board "S5 ·
 * Notification settings"): the caller's notification settings in one
 * organization (CONTRACTS §22.3: they are per member and organization) —
 * email frequency (immediate, daily at a whole hour of the user's time zone,
 * off), the Telegram link (T555: `telegram/`), type × channel (mandatory
 * types locked; the Telegram column only when the organization has a
 * notification bot, usable once linked), following records I create / am
 * assigned to (T552), muted bases. Each change is
 * saved at once ("Saved: …"). Without SMTP on the instance the email
 * channel and the frequency are hidden with an explanation. Every
 * notification email links here (`/me/settings/notifications` redirects).
 */
export function NotificationSettingsPage() {
  const { t } = useTranslation('notifications');
  const { orgSlug } = useParams();
  const me = useQuery(meQuery());
  const org = me.data?.orgs.find((item) => item.slug === orgSlug);
  const orgId = org?.id ?? '';
  const setup = useQuery(setupStatusQuery());
  const settings = useQuery({ ...notificationSettingsQuery(orgId), enabled: org !== undefined });
  const preferences = useQuery({
    ...notificationPreferencesQuery(orgId),
    enabled: org !== undefined,
  });
  const userChannels = useQuery({ ...userChannelsQuery(orgId), enabled: org !== undefined });
  const saved = useSavedMessage();
  useDocumentTitle(org === undefined ? undefined : `${t('settings.title')} · ${org.name}`);
  if (me.data !== undefined && org === undefined) notFound();
  if (org === undefined || me.data === undefined || me.data === null) return null;
  const emailEnabled = setup.data?.auth_config.smtp_enabled === true;
  const error = settings.error ?? preferences.error;

  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <PageHeading
        back={{
          to: `/o/${encodeURIComponent(org.slug)}`,
          label: t('settings.back', { name: org.name }),
        }}
        icon={Bell}
        title={t('settings.title')}
        subtitle={t('settings.subtitle', { org: org.name })}
      />
      <div className={cn('flex w-full max-w-3xl flex-col gap-6 py-6', PAGE_GUTTER)}>
        <div role="status" aria-atomic="true" data-testid="settings-saved" className="empty:-mb-6">
          {saved.message === null ? null : (
            <p className="inline-flex items-center gap-2 rounded-md bg-accent-soft px-3 py-2 text-body text-fg">
              <CheckCircle2 aria-hidden="true" className="size-4 shrink-0 text-accent" />
              {saved.message}
            </p>
          )}
        </div>
        {setup.data !== undefined && !emailEnabled ? (
          <div
            role="note"
            data-testid="no-smtp"
            className="flex items-start gap-3 rounded-lg border border-line bg-surface p-4"
          >
            <Info aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-fg-muted" />
            <div className="flex flex-col gap-1">
              <strong className="text-body font-semibold">{t('settings.noSmtp.title')}</strong>
              <span className="text-label font-normal text-fg-muted">
                {t('settings.noSmtp.body')}
              </span>
            </div>
          </div>
        ) : null}
        {error !== null ? (
          <ErrorAlert error={error} />
        ) : settings.data === undefined || preferences.data === undefined || setup.isPending ? (
          <LoadingSections />
        ) : (
          <>
            {emailEnabled ? (
              <EmailFrequencySection
                orgId={org.id}
                settings={settings.data}
                timeZone={me.data.timezone}
                onSaved={saved.setMessage}
              />
            ) : null}
            <TelegramChannelSection
              orgId={org.id}
              orgSlug={org.slug}
              userId={me.data.user.id}
              isAdmin={isOrgAdmin(org.role)}
              onSaved={saved.setMessage}
            />
            <PreferencesSection
              orgId={org.id}
              preferences={preferences.data}
              emailEnabled={emailEnabled}
              telegramLinked={
                userChannels.data?.items.some(
                  (item) => isTelegramChannel(item) && item.status === 'linked',
                ) === true
              }
              onSaved={saved.setMessage}
            />
            <FollowSection orgId={org.id} settings={settings.data} onSaved={saved.setMessage} />
            <MutedBasesSection
              orgId={org.id}
              settings={settings.data}
              emailEnabled={emailEnabled}
              onSaved={saved.setMessage}
            />
          </>
        )}
      </div>
    </div>
  );
}

export default NotificationSettingsPage;
