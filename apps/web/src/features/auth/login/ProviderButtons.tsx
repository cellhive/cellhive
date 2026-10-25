import { Button } from '@cellhive/ui';
import { useTranslation } from 'react-i18next';

import { API_BASE } from '../../../lib/api/client';

import type { AuthProvider } from '@cellhive/contracts';

/**
 * Where a provider button goes (CONTRACTS §27.2): a plain navigation to
 * `…/start`, never a fetch — the API answers with a redirect to the provider.
 * `next` is already a safe internal path (`safeNextPath`); the server checks
 * it again.
 */
export function oidcStartHref(slug: string, next: string | null): string {
  const path = `${API_BASE}/auth/oidc/${encodeURIComponent(slug)}/start`;
  return next === null ? path : `${path}?${new URLSearchParams({ next }).toString()}`;
}

/**
 * "Continue with <name>" for each OIDC provider of `auth_config.providers`
 * (CONTRACTS §12.0, §27.1). The operator's `name` is the only provider text
 * shown.
 */
export function ProviderButtons({
  providers,
  next,
}: {
  readonly providers: readonly AuthProvider[];
  readonly next: string | null;
}) {
  const { t } = useTranslation('auth');
  if (providers.length === 0) return null;
  return (
    <>
      <ul className="flex flex-col gap-2" aria-label={t('login.sso.label')}>
        {providers.map((provider) => (
          <li key={provider.slug}>
            <Button asChild variant="secondary" className="w-full">
              <a href={oidcStartHref(provider.slug, next)}>
                {t('login.sso.continueWith', { name: provider.name })}
              </a>
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-3 text-label font-normal text-fg-muted">
        <span aria-hidden="true" className="h-px flex-1 bg-line" />
        {t('login.sso.or')}
        <span aria-hidden="true" className="h-px flex-1 bg-line" />
      </div>
    </>
  );
}
