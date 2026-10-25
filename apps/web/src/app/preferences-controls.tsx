import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@cellhive/ui';
import { Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { changeLanguage, isLanguage, LANGUAGES } from '../lib/i18n/i18n';
import { THEME_PREFERENCES, useTheme, type ThemePreference } from '../lib/theme/theme';

function isThemePreference(value: string): value is ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference);
}

/** Language and theme radio groups, shared by the user menu and the auth header. */
export function PreferenceMenuItems() {
  const { t, i18n } = useTranslation('common');
  const { preference, setPreference } = useTheme();
  return (
    <>
      <DropdownMenuLabel>{t('preferences.language')}</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={i18n.resolvedLanguage ?? i18n.language}
        onValueChange={(value) => {
          if (isLanguage(value)) void changeLanguage(value);
        }}
      >
        {LANGUAGES.map((language) => (
          <DropdownMenuRadioItem key={language} value={language} lang={language}>
            {t(`languages.${language}`)}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>{t('preferences.theme')}</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={preference}
        onValueChange={(value) => {
          if (isThemePreference(value)) setPreference(value);
        }}
      >
        {THEME_PREFERENCES.map((theme) => (
          <DropdownMenuRadioItem key={theme} value={theme}>
            {t(`preferences.themes.${theme}`)}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  );
}

/** Language/theme menu for screens without a signed-in user. */
export function LanguageThemeControls() {
  const { t } = useTranslation('common');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost">
          <Languages aria-hidden="true" />
          {t('preferences.menu')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <PreferenceMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
