import { cn } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { Plug } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { useDocumentTitle } from '../../../../lib/a11y/use-document-title';
import { PAGE_GUTTER, PageHeading } from '../../../../lib/layout/page-heading';
import { notFound } from '../../../../lib/navigation/not-found';
import { meQuery } from '../../../../lib/session/session';

import { AllowlistSection } from './AllowlistSection';
import { HttpSecretsSection, LegacyHostsBanner } from './HttpSecretsSection';

/**
 * `/o/:orgSlug/settings/integrations` (BACKLOG T613; board "S5c ·
 * Integrations settings" is not drawn yet — built like the Telegram bots
 * and email settings pages): the outbound HTTP allowlist and the HTTP
 * secrets of the organization. Owners/admins only (guard `orgSettings` of
 * the layout; others get the 404 screen, the API answers `403`).
 */
export function IntegrationsPage() {
  const { t } = useTranslation('orgIntegrations');
  const { orgSlug } = useParams();
  const me = useQuery(meQuery());
  const org = me.data?.orgs.find((item) => item.slug === orgSlug);
  useDocumentTitle(org === undefined ? undefined : `${t('page.title')} · ${org.name}`);

  if (me.data !== undefined && org === undefined) notFound();
  if (org === undefined) return null;

  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <PageHeading
        back={{
          to: `/o/${encodeURIComponent(org.slug)}`,
          label: t('page.back', { name: org.name }),
        }}
        icon={Plug}
        title={t('page.title')}
        subtitle={t('page.subtitle')}
      />
      <div className={cn('flex flex-col gap-4 py-6', PAGE_GUTTER)}>
        <LegacyHostsBanner orgId={org.id} />
        <AllowlistSection orgId={org.id} />
        <HttpSecretsSection orgId={org.id} />
        <p className="text-label font-normal text-fg-muted">{t('page.whoSees')}</p>
      </div>
    </div>
  );
}

export default IntegrationsPage;
