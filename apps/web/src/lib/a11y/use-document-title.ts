import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

/** Sets `<title>` to "<page> · Cellhive" (WCAG 2.4.2 page titled). */
export function useDocumentTitle(title: string | undefined): void {
  const { t } = useTranslation('common');
  const appName = t('app.name');
  useEffect(() => {
    document.title = title === undefined || title === '' ? appName : `${title} · ${appName}`;
  }, [title, appName]);
}
