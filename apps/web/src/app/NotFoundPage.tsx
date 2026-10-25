import { Button } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { SearchX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useDocumentTitle } from '../lib/a11y/use-document-title';
import { meQuery } from '../lib/session/session';
import { useProfileLanguage } from '../lib/session/use-profile-language';

/**
 * One screen for "does not exist" and "no access" (FRONTEND §2): the UI
 * must not reveal whether a resource exists.
 */
export function NotFoundPage() {
  const { t } = useTranslation('common');
  // Outside the app shell, but in the signed-in user's language all the same.
  const me = useQuery(meQuery());
  useProfileLanguage(me.data?.locale);
  useDocumentTitle(t('notFound.title'));
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-canvas p-6 text-center">
      <SearchX aria-hidden="true" className="size-8 text-fg-muted" />
      <h1 className="text-title">{t('notFound.title')}</h1>
      <p className="max-w-md text-fg-muted">{t('notFound.description')}</p>
      <Button asChild variant="secondary">
        <Link to="/">{t('notFound.home')}</Link>
      </Button>
    </main>
  );
}

/** The same message inside the app shell, keeping the navigation. */
export function NotFoundPanel() {
  const { t } = useTranslation('common');
  useDocumentTitle(t('notFound.title'));
  return (
    <div className="flex flex-col items-start gap-3 p-8">
      <h1 className="text-title">{t('notFound.title')}</h1>
      <p className="max-w-md text-fg-muted">{t('notFound.description')}</p>
      <Button asChild variant="secondary">
        <Link to="/">{t('notFound.home')}</Link>
      </Button>
    </div>
  );
}
