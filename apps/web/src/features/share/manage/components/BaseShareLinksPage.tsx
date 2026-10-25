import { cn } from '@cellhive/ui';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Link2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { useDocumentTitle } from '../../../../lib/a11y/use-document-title';
import { PAGE_GUTTER, PageHeading } from '../../../../lib/layout/page-heading';
import { baseQuery } from '../../../../lib/query/queries';

import { ShareLinksManager } from './ShareLinksManager';

/**
 * `/b/:baseId/settings/share-links` (FRONTEND §2, T316): every link to a
 * view or form of the base. The route guard lets base admins/owners only.
 */
export function BaseShareLinksPage() {
  const { t } = useTranslation('share');
  const { baseId = '' } = useParams();
  const { data: base } = useSuspenseQuery(baseQuery(baseId));
  useDocumentTitle(`${t('settingsPage.baseTitle')} · ${base.name}`);
  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <PageHeading
        back={{
          to: `/b/${encodeURIComponent(base.id)}`,
          label: t('settingsPage.back', { name: base.name }),
        }}
        icon={Link2}
        title={t('settingsPage.baseTitle')}
        subtitle={t('settingsPage.baseSubtitle', { base: base.name })}
      />
      <div className={cn('flex flex-col gap-6 py-6', PAGE_GUTTER)}>
        <ShareLinksManager scope={{ kind: 'base', baseId: base.id }} />
      </div>
    </div>
  );
}

export default BaseShareLinksPage;
