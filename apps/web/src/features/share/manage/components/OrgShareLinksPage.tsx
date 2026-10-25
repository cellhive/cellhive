import { cn } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { Link2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { useDocumentTitle } from '../../../../lib/a11y/use-document-title';
import { PAGE_GUTTER, PageHeading } from '../../../../lib/layout/page-heading';
import { notFound } from '../../../../lib/navigation/not-found';
import { meQuery } from '../../../../lib/session/session';
import { orgBasesQuery } from '../api';

import { PublicSharingPolicyForm } from './PublicSharingPolicyForm';
import { ShareLinksManager } from './ShareLinksManager';

/**
 * `/o/:orgSlug/settings/share-links` (FRONTEND §2, T316): the public
 * sharing policy of the organization and every share link in it. The route
 * guard lets organization owners/admins only.
 */
export function OrgShareLinksPage() {
  const { t } = useTranslation('share');
  const { orgSlug } = useParams();
  const me = useQuery(meQuery());
  const org = me.data?.orgs.find((item) => item.slug === orgSlug);
  const bases = useQuery({ ...orgBasesQuery(org?.id ?? ''), enabled: org !== undefined });
  useDocumentTitle(org === undefined ? undefined : `${t('settingsPage.orgTitle')} · ${org.name}`);
  if (me.data !== undefined && org === undefined) notFound();
  if (org === undefined) return null;
  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <PageHeading
        back={{
          to: `/o/${encodeURIComponent(org.slug)}`,
          label: t('settingsPage.back', { name: org.name }),
        }}
        icon={Link2}
        title={t('settingsPage.orgTitle')}
        subtitle={t('settingsPage.orgSubtitle', { org: org.name })}
      />
      <div className={cn('flex flex-col gap-8 py-6', PAGE_GUTTER)}>
        <PublicSharingPolicyForm orgId={org.id} />
        <ShareLinksManager scope={{ kind: 'org', orgId: org.id }} bases={bases.data} />
      </div>
    </div>
  );
}

export default OrgShareLinksPage;
