import { Button, cn, Skeleton, Spinner } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { Check, ShieldCheck, Sparkles, Upload } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useDocumentTitle } from '../../../../lib/a11y/use-document-title';
import { isApiError } from '../../../../lib/api/client';
import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { translateDetail } from '../../../../lib/errors/translate';
import { useFormatters } from '../../../../lib/i18n/format';
import { PAGE_GUTTER, PageHeading } from '../../../../lib/layout/page-heading';
import { showToast } from '../../../../lib/toast/toast';
import { useSettingsOrg } from '../../admin/shared';
import { aiSettingsQuery, useUpdateAiSettings } from '../api';
import {
  changesOf,
  draftErrors,
  draftOf,
  SERVER_PATHS,
  type AiDraft,
  type DraftField,
} from '../model';

import { DataSection } from './DataSection';
import { LimitsSection } from './LimitsSection';
import { ProviderSection } from './ProviderSection';
import { StatusSection } from './StatusSection';
import { UsageSection } from './UsageSection';

import type { AiSettingsDto } from '@cellhive/contracts';

function LoadingSections() {
  const { t } = useTranslation('orgAi');
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t('loading')}
      className="flex flex-col gap-4"
      data-testid="ai-settings-loading"
    >
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-5"
        >
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-72 max-w-full" />
          <Skeleton className={index === 1 ? 'h-32' : 'h-12'} />
        </div>
      ))}
    </div>
  );
}

/** Side cards: what leaves the server, and who sees the page. */
function Aside() {
  const { t } = useTranslation('orgAi');
  return (
    <aside className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-6 lg:w-72 lg:shrink-0">
      <section
        aria-labelledby="ai-sent-title"
        className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4"
      >
        <h2 id="ai-sent-title" className="flex items-center gap-2 text-heading">
          <Upload aria-hidden="true" className="size-4 text-accent" />
          {t('aside.sentTitle')}
        </h2>
        <ul className="flex list-disc flex-col gap-1 pl-4 text-label font-normal text-fg-muted">
          <li>{t('aside.sentAlways')}</li>
          <li>{t('aside.sentData')}</li>
          <li>{t('aside.sentNever')}</li>
        </ul>
      </section>
      <section
        aria-labelledby="ai-audience-title"
        className="flex flex-col gap-1 rounded-lg border border-line bg-surface-sunken p-4"
      >
        <h2 id="ai-audience-title" className="flex items-center gap-2 text-body font-semibold">
          <ShieldCheck aria-hidden="true" className="size-4 text-fg-muted" />
          {t('aside.audienceTitle')}
        </h2>
        <p className="text-label font-normal text-fg-muted">{t('aside.audienceBody')}</p>
      </section>
    </aside>
  );
}

/**
 * The editable part of the page: the draft of the provider and limits form
 * (saved with "Save changes" in a bar that rises while there are changes),
 * and the switches that apply at once (AI on, record values, prompt log).
 */
function AiSettingsForm({
  orgId,
  orgName,
  settings,
}: {
  readonly orgId: string;
  readonly orgName: string;
  readonly settings: AiSettingsDto;
}) {
  const { t, i18n } = useTranslation('orgAi');
  const format = useFormatters();
  const save = useUpdateAiSettings(orgId);
  const [edited, setEdited] = useState<AiDraft | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const draft = edited ?? draftOf(settings, format.number);
  const changes = changesOf(settings, draft);
  const errors = draftErrors(draft);
  const invalid = Object.keys(errors).length > 0;
  const dirty = changes !== null;
  const update = (patch: Partial<AiDraft>) => {
    setEdited({ ...draft, ...patch });
    // A server error is about the values sent: editing them clears it.
    if (save.isError) save.reset();
  };
  // Client checks first, then the server's `errors[]` under their field.
  const messages: Partial<Record<DraftField, string>> = {};
  for (const [field, reason] of Object.entries(errors)) {
    messages[field as DraftField] = t(`errors.${reason}`);
  }
  if (isApiError(save.error)) {
    for (const item of save.error.errors) {
      const field = SERVER_PATHS[item.path];
      if (field === undefined || messages[field] !== undefined) continue;
      // T906: the generic secret message is about automations; a key has its own.
      messages[field] =
        item.code === 'SECRET_HOST_NOT_ALLOWED' ? t('errors.keyIp') : translateDetail(i18n, item);
    }
  }
  const reset = () => {
    setEdited(null);
    setSubmitted(false);
    save.reset();
  };
  const submit = () => {
    setSubmitted(true);
    if (changes === null || invalid || save.isPending) return;
    save.mutate(changes, {
      onSuccess: () => {
        setEdited(null);
        setSubmitted(false);
        showToast({ variant: 'success', message: t('saved') });
      },
    });
  };
  const serverPaths = Object.keys(SERVER_PATHS);
  const otherError =
    save.error !== null &&
    (!isApiError(save.error) ||
      save.error.errors.length === 0 ||
      save.error.errors.some((item) => !serverPaths.includes(item.path)));

  return (
    <div
      className={cn(
        'flex min-w-0 flex-1 flex-col gap-4',
        // While the save bar sticks to the bottom, focus scrolls clear of it (WCAG 2.4.11).
        dirty &&
          '[&_button]:scroll-mb-24 [&_input]:scroll-mb-24 [&_select]:scroll-mb-24 [&_summary]:scroll-mb-24',
      )}
      data-testid="ai-settings-form"
    >
      <StatusSection orgId={orgId} orgName={orgName} settings={settings} />
      <ProviderSection
        orgId={orgId}
        orgName={orgName}
        settings={settings}
        draft={draft}
        errors={messages}
        onChange={update}
      />
      <DataSection orgId={orgId} settings={settings} />
      <LimitsSection settings={settings} draft={draft} errors={messages} onChange={update} />
      <UsageSection orgId={orgId} />
      {dirty ? (
        <div
          data-testid="ai-settings-bar"
          className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface px-4 py-3 shadow-popover motion-safe:animate-sheet-in sm:mx-0 sm:rounded-lg sm:border"
        >
          <span className="mr-auto text-label font-normal text-fg-muted">{t('unsaved')}</span>
          {otherError ? (
            <ErrorAlert error={save.error} hidePaths={serverPaths} className="basis-full" />
          ) : null}
          <Button
            variant="ghost"
            type="button"
            disabled={save.isPending}
            onClick={reset}
            data-testid="ai-settings-cancel"
          >
            {t('cancel')}
          </Button>
          <Button
            disabled={save.isPending || (submitted && invalid)}
            onClick={submit}
            data-testid="ai-settings-save"
          >
            {save.isPending ? <Spinner /> : <Check aria-hidden="true" />}
            {t('save')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * `/o/:orgSlug/settings/ai` (FRONTEND §15.8, T912; CONTRACTS §29.1):
 * organization owners/admins (route guard `orgSettings`, others the 404
 * screen). No design board: built from the F§9.3 tokens and the email
 * settings page (F§15.3) — status with the AI switch, provider (presets,
 * model, write-only key, "Test connection" with the allowlist shortcut),
 * data and privacy, limits, usage of the last 30 days.
 */
export function AiSettingsPage() {
  const { t } = useTranslation('orgAi');
  const { org } = useSettingsOrg();
  const settings = useQuery(aiSettingsQuery(org.id));
  useDocumentTitle(`${t('title')} · ${org.name}`);
  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <PageHeading
        back={{ to: `/o/${encodeURIComponent(org.slug)}`, label: t('back', { name: org.name }) }}
        icon={Sparkles}
        title={t('title')}
        subtitle={t('subtitle')}
      />
      <div
        className={cn(
          'flex w-full max-w-[1120px] flex-col gap-6 py-6 lg:flex-row lg:items-start',
          PAGE_GUTTER,
        )}
      >
        {settings.error !== null ? (
          <div className="min-w-0 flex-1">
            <ErrorAlert error={settings.error} />
          </div>
        ) : settings.data === undefined ? (
          <div className="min-w-0 flex-1">
            <LoadingSections />
          </div>
        ) : (
          <AiSettingsForm orgId={org.id} orgName={org.name} settings={settings.data} />
        )}
        <Aside />
      </div>
    </div>
  );
}

export default AiSettingsPage;
