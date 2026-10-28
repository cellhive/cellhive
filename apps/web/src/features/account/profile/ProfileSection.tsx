import {
  canonicalTimeZone,
  canonicalTimeZones,
  USER_LOCALES,
  type MeResponse,
  type UpdateMeRequest,
} from '@cellhive/contracts';
import { Button, FormField, Input, Select, Spinner } from '@cellhive/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { DEFAULT_LANGUAGE, matchLanguage } from '../../../lib/i18n/i18n';
import { PREFERENCE_KEYS, writePreference } from '../../../lib/preferences';
import { keys } from '../../../lib/query/keys';
import { showToast } from '../../../lib/toast/toast';

import { profileApi } from './api';

/** The limit of `updateMeRequestSchema` (CONTRACTS §12.0). */
const NAME_MAX = 100;

export const SECTION_CLASSES = 'flex flex-col gap-4 rounded-lg border border-line bg-surface p-5';

/**
 * "Profile" of the account page (T831): display name, language and time
 * zone, saved with `PATCH /me` (only what changed). A new language applies
 * at once and becomes this device's choice too (FRONTEND §9.1).
 */
export function ProfileSection({ me }: { readonly me: MeResponse }) {
  const { t } = useTranslation('account');
  const heading = useId();
  return (
    <section aria-labelledby={heading} className={SECTION_CLASSES} data-testid="profile-section">
      <h2 id={heading} className="text-heading">
        {t('profile.title')}
      </h2>
      {/* Saved values remount the form, so it starts clean from them. */}
      <ProfileForm key={`${me.user.display_name}\u0000${me.locale}\u0000${me.timezone}`} me={me} />
    </section>
  );
}

function ProfileForm({ me }: { readonly me: MeResponse }) {
  const { t, i18n } = useTranslation(['account', 'common']);
  const queryClient = useQueryClient();
  const initialLocale = matchLanguage(me.locale) ?? DEFAULT_LANGUAGE;
  const initialZone = canonicalTimeZone(me.timezone) ?? me.timezone;
  const [name, setName] = useState(me.user.display_name);
  const [locale, setLocale] = useState(initialLocale);
  const [timezone, setTimezone] = useState(initialZone);
  const zones = useMemo(() => {
    const all = canonicalTimeZones();
    return all.includes(initialZone) ? all : [initialZone, ...all];
  }, [initialZone]);
  const changes: UpdateMeRequest = {
    ...(name.trim() === me.user.display_name ? {} : { display_name: name.trim() }),
    ...(locale === initialLocale ? {} : { locale }),
    ...(timezone === initialZone ? {} : { timezone }),
  };
  const save = useMutation({
    mutationFn: () => profileApi.update(changes),
    onSuccess: async (updated) => {
      if (changes.locale !== undefined) {
        // `changeLanguage` of lib/i18n, on the provider's instance (the same one in the app).
        writePreference(PREFERENCE_KEYS.language, changes.locale);
        await i18n.changeLanguage(changes.locale);
      }
      queryClient.setQueryData(keys.me(), updated);
      // `i18n.t`, not `t`: the message is in the language just applied.
      showToast({ variant: 'success', message: i18n.t('account:profile.saved') });
    },
  });
  const unchanged = Object.keys(changes).length === 0;
  return (
    <form
      className="flex flex-col gap-4"
      data-testid="profile-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!unchanged && name.trim() !== '') save.mutate();
      }}
    >
      <FormField label={t('account:profile.displayName')}>
        {(control) => (
          <Input
            {...control}
            autoComplete="name"
            maxLength={NAME_MAX}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        )}
      </FormField>
      <FormField label={t('account:profile.language')} hint={t('account:profile.languageHint')}>
        {(control) => (
          <Select
            {...control}
            value={locale}
            onChange={(event) => {
              setLocale(matchLanguage(event.target.value) ?? DEFAULT_LANGUAGE);
            }}
          >
            {USER_LOCALES.map((option) => (
              <option key={option} value={option} lang={option}>
                {t(`common:languages.${option}`)}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <FormField label={t('account:profile.timezone')} hint={t('account:profile.timezoneHint')}>
        {(control) => (
          <Select
            {...control}
            value={timezone}
            onChange={(event) => {
              setTimezone(event.target.value);
            }}
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      {save.isError ? <ErrorAlert error={save.error} /> : null}
      <div className="flex justify-end">
        <Button type="submit" disabled={unchanged || name.trim() === '' || save.isPending}>
          {save.isPending ? <Spinner /> : null}
          {t('account:profile.save')}
        </Button>
      </div>
    </form>
  );
}
