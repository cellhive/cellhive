import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@cellhive/ui';
import { useTranslation } from 'react-i18next';

import { useDocumentTitle } from '../../../lib/a11y/use-document-title';
import { signOut } from '../../../lib/session/session';

/**
 * `/` for a signed-in user without any organization (removed from their
 * last one). New organizations come from invitations or the CLI (SPEC §14.1A).
 */
export function NoOrganizationPage() {
  const { t } = useTranslation(['org', 'common']);
  useDocumentTitle(t('org:noOrg.title'));
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t('org:noOrg.title')}</CardTitle>
          <CardDescription>{t('org:noOrg.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="secondary"
            onClick={() => {
              void signOut();
            }}
          >
            {t('common:actions.signOut')}
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}

export default NoOrganizationPage;
