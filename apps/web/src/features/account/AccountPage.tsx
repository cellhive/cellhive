import { cn } from '@cellhive/ui';
import { useSuspenseQuery } from '@tanstack/react-query';
import { UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMatch } from 'react-router';

import { useDocumentTitle } from '../../lib/a11y/use-document-title';
import { PAGE_GUTTER, PageHeading } from '../../lib/layout/page-heading';
import { meQuery } from '../../lib/session/session';

import { ConnectionsSection } from './connections/ConnectionsSection';
import { PasswordSection } from './profile/PasswordSection';
import { ProfileSection } from './profile/ProfileSection';

/**
 * `/account` (T831, FRONTEND §2): the signed-in user's profile, password
 * and connected accounts. `/account/connections` (where the OIDC link
 * callback returns, CONTRACTS §27.3) is the same page, scrolled to
 * "Connected accounts".
 */
export function AccountPage() {
  const { t } = useTranslation('account');
  const atConnections = useMatch('/account/connections') !== null;
  useDocumentTitle(atConnections ? t('connections.title') : t('page.title'));
  // The app shell's guard has loaded `me`; `null` only after the session ended.
  const { data: me } = useSuspenseQuery(meQuery());
  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <PageHeading icon={UserRound} title={t('page.title')} subtitle={t('page.subtitle')} />
      <div className={cn('flex max-w-3xl flex-col gap-6 py-6', PAGE_GUTTER)}>
        {me === null ? null : <ProfileSection me={me} />}
        <PasswordSection />
        <ConnectionsSection scrollIntoView={atConnections} />
      </div>
    </div>
  );
}

export default AccountPage;
