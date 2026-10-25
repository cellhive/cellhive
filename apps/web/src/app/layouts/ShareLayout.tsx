import { Select, Spinner } from '@cellhive/ui';
import { Languages } from 'lucide-react';
import { Suspense, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet } from 'react-router';

import { Logo } from '../../lib/brand/Logo';
import { changeLanguage, isLanguage, LANGUAGES } from '../../lib/i18n/i18n';
import { SessionlessProvider } from '../../lib/session/sessionless';

/** Placeholder while the share page or a translation loads. */
export function ShareLoading() {
  const { t } = useTranslation('common');
  return (
    <div role="status" className="flex flex-1 items-center justify-center gap-2 p-6 text-fg-muted">
      <Spinner />
      <span>{t('loading')}</span>
    </div>
  );
}

/**
 * Language of the share page for people without an account: a native
 * `<select>` (light, works with every keyboard and mobile picker); the
 * choice is remembered on the device (`localStorage`, FRONTEND §9.1).
 */
function LanguagePicker() {
  const { t, i18n } = useTranslation('common');
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Languages aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
      <label htmlFor={id} className="sr-only">
        {t('preferences.language')}
      </label>
      <Select
        id={id}
        className="w-36"
        value={i18n.resolvedLanguage ?? i18n.language}
        onChange={(event) => {
          if (isLanguage(event.target.value)) void changeLanguage(event.target.value);
        }}
      >
        {LANGUAGES.map((language) => (
          <option key={language} value={language} lang={language}>
            {t(`languages.${language}`)}
          </option>
        ))}
      </Select>
    </div>
  );
}

/**
 * Layout of the public share pages (`/s/:token`, FRONTEND §2, T317): no app
 * shell, no navigation, no session needed. The product mark (nothing about
 * the organization or the person who shared, FRONTEND §12) and the language
 * picker. The page is never indexed and never sends the token as a
 * `Referer`: nginx and `vite preview` send `X-Robots-Tag` and
 * `Referrer-Policy` (SPEC §15A.3), `share.html` has the same rules as
 * `<meta>`, and so does this layout (React hoists them into `<head>`) when
 * the app navigates to a share page.
 */
export function ShareLayout() {
  return (
    // A viewport-high column: the grid fills what the header leaves, other pages scroll inside.
    <div className="flex h-dvh flex-col bg-canvas">
      <meta name="robots" content="noindex, nofollow" />
      <meta name="referrer" content="no-referrer" />
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-line bg-surface px-4 py-2">
        <Logo />
        <LanguagePicker />
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <Suspense fallback={<ShareLoading />}>
          <SessionlessProvider value>
            <Outlet />
          </SessionlessProvider>
        </Suspense>
      </div>
    </div>
  );
}

export default ShareLayout;
