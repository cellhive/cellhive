import { Button, FormField, Input, Spinner } from '@cellhive/ui';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Settings } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useDocumentTitle } from '../../../lib/a11y/use-document-title';
import { orgAdminApi } from '../../../lib/api/org-admin';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../lib/i18n/format';
import { keys } from '../../../lib/query/keys';
import { orgQuery } from '../../../lib/query/queries';
import { showToast } from '../../../lib/toast/toast';
import { Section } from '../api-tokens/components/parts';

import { AdminPage, useSettingsOrg } from './shared';

import type { OrganizationDto } from '@cellhive/contracts';

/** The limit of the organization name (`updateOrganizationRequestSchema`). */
const NAME_MAX = 100;

/**
 * `/o/:orgSlug/settings` (FRONTEND §15.0, T830), owners/admins: the
 * organization's name (`PATCH /orgs/:id`) and its ID, slug and creation
 * date. The other pages are in the settings nav, not repeated here.
 */
export function OrgGeneralPage() {
  const { t } = useTranslation('orgAdmin');
  const { org: summary } = useSettingsOrg();
  const { data: org } = useSuspenseQuery(orgQuery(summary.id));
  useDocumentTitle(`${t('general.title')} · ${org.name}`);
  return (
    <AdminPage org={summary} icon={Settings} title={t('general.title')} narrow>
      {/* Saved values remount the form, so it starts clean from them. */}
      <OrgInfoForm key={org.name} org={org} />
      <OrgFacts org={org} />
    </AdminPage>
  );
}

function OrgInfoForm({ org }: { readonly org: OrganizationDto }) {
  const { t } = useTranslation('orgAdmin');
  const queryClient = useQueryClient();
  const [name, setName] = useState(org.name);
  const next = name.trim();
  const save = useMutation({
    mutationFn: () => orgAdminApi.update(org.id, { name: next }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(keys.org(org.id), updated);
      // The sidebar and the settings nav show the name from `GET /me`.
      await queryClient.invalidateQueries({ queryKey: keys.me() });
      showToast({ variant: 'success', message: t('general.info.saved') });
    },
  });
  const unchanged = next === org.name || next === '';
  return (
    <Section title={t('general.info.title')}>
      <form
        className="flex flex-col gap-4"
        data-testid="org-info-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!unchanged) save.mutate();
        }}
      >
        <FormField label={t('general.info.name')}>
          {(control) => (
            <Input
              {...control}
              maxLength={NAME_MAX}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </FormField>
        {save.isError ? <ErrorAlert error={save.error} /> : null}
        <div className="flex justify-end">
          <Button type="submit" disabled={unchanged || save.isPending}>
            {save.isPending ? <Spinner /> : null}
            {t('general.info.save')}
          </Button>
        </div>
      </form>
    </Section>
  );
}

function OrgFacts({ org }: { readonly org: OrganizationDto }) {
  const { t } = useTranslation('orgAdmin');
  const format = useFormatters();
  const code =
    'rounded-sm bg-surface-sunken px-1.5 py-0.5 font-mono text-label font-normal break-all';
  return (
    <Section title={t('general.facts.title')}>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-center">
        <dt className="text-fg-muted">{t('general.facts.id')}</dt>
        <dd className="flex min-w-0 flex-wrap items-center gap-2">
          <code className={code}>{org.id}</code>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              // The Clipboard API exists only in secure contexts (HTTPS or localhost).
              if (!('clipboard' in navigator)) return;
              navigator.clipboard.writeText(org.id).then(
                () => {
                  showToast({ variant: 'success', message: t('general.facts.copied') });
                },
                () => undefined,
              );
            }}
          >
            {t('general.facts.copy')}
          </Button>
        </dd>
        <dt className="text-fg-muted">{t('general.facts.slug')}</dt>
        <dd>
          <code className={code}>{`/o/${org.slug}`}</code>
        </dd>
        <dt className="text-fg-muted">{t('general.facts.created')}</dt>
        <dd>{format.dateTime(org.created_at)}</dd>
      </dl>
    </Section>
  );
}

export default OrgGeneralPage;
