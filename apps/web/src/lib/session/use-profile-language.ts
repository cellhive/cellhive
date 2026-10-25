import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { changeLanguage, hasLanguagePreference, matchLanguage } from '../i18n/i18n';

/**
 * The profile locale of the signed-in user applies until a language is
 * picked on this device (FRONTEND §9.1): the app shell, and the pages
 * outside it such as the 404 screen.
 */
export function useProfileLanguage(locale: string | null | undefined): void {
  const { i18n } = useTranslation();
  const profileLanguage = matchLanguage(locale);
  useEffect(() => {
    if (profileLanguage !== null && !hasLanguagePreference() && profileLanguage !== i18n.language) {
      void changeLanguage(profileLanguage, false);
    }
  }, [profileLanguage, i18n.language]);
}
