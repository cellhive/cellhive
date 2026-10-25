import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useParams, useSearchParams } from 'react-router';

import { isApiError } from '../../../../lib/api/client';
import { useFormatters } from '../../../../lib/i18n/format';
import { loginPathFor } from '../../../../lib/navigation/safe-next';
import { keys } from '../../../../lib/query/keys';
import { ShareApi } from '../api';
import { initialChoices, type ViewerChoices } from '../query';

import { SharedForm } from './SharedForm';
import {
  ShareLoading,
  SharePasswordScreen,
  ShareStatusScreen,
  type ShareStatus,
} from './ShareScreens';

import type { SharePageParts } from '../../../../lib/share/public-page';
import type { ShareMeta } from '@cellhive/contracts';

/** The grid (glide) and the board are chunks of their own: a form link loads neither. */
const SharedGrid = lazy(() => import('./SharedGrid'));
const SharedBoard = lazy(() => import('./SharedBoard'));
/** (T814) A dashboard link: its own chunk, never the board's or the grid's. */
const SharedDashboardPage = lazy(() => import('../dashboard/SharedDashboardPage'));
/** (T814) "Download" of a view link with `allow_export`: loaded only for such links. */
const ShareExportMenu = lazy(() => import('./ShareExportMenu'));

export interface SharePageProps {
  readonly parts: SharePageParts;
}

type Screen =
  | { readonly kind: 'loading' }
  | { readonly kind: 'signIn' }
  | { readonly kind: 'password' }
  | { readonly kind: 'status'; readonly status: ShareStatus }
  | { readonly kind: 'dashboard' }
  | { readonly kind: 'ready'; readonly meta: ShareMeta };

/**
 * (T814) The `404` of `meta` for a dashboard link (CONTRACTS §16A: after
 * every other check — audience, password — so those screens come first).
 */
export function isDashboardLink(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.status === 404 &&
    // `DASHBOARD_LINK` of the contracts, spelled out: its module carries zod schemas that
    // the first load of the share page does not (FRONTEND §11.1, T422).
    error.errors.some((item) => item.code === 'DASHBOARD_LINK')
  );
}

/**
 * What a failed request of the link means for the whole page (CONTRACTS
 * §16A): `401` audience `org` without a session → sign in, then back here;
 * `403 SHARE_PASSWORD_REQUIRED` → the password screen (also when the unlock
 * cookie expired while the page was open); `404`, `410`, `429` → their
 * screens. `null`: an error the screen that made the request shows itself.
 */
export function screenOfError(error: unknown, fromMeta: boolean): Screen | null {
  if (!isApiError(error)) return fromMeta ? { kind: 'status', status: 'error' } : null;
  if (error.status === 401) return { kind: 'signIn' };
  if (error.code === 'SHARE_PASSWORD_REQUIRED') return { kind: 'password' };
  if (error.status === 410) return { kind: 'status', status: 'gone' };
  if (error.status === 404 && (fromMeta || error.code === 'NOT_FOUND')) {
    return { kind: 'status', status: 'notFound' };
  }
  if (!fromMeta) return null;
  if (error.status === 429) return { kind: 'status', status: 'rateLimited' };
  return { kind: 'status', status: 'error' };
}

/**
 * An `org` link opened without a session: the sign-in page of the app (a
 * full page load: the share entry has no sign-in screen), then back here.
 */
function SignInFirst({ next }: { next: { pathname: string; search: string; hash: string } }) {
  const target = loginPathFor(next);
  useEffect(() => {
    window.location.assign(target);
  }, [target]);
  return <ShareLoading />;
}

/**
 * The public share page `/s/:token` (FRONTEND §2, SPEC §15A, T317). No app
 * shell and no session needed (`audience = public`); an `org` link sends
 * people who are not signed in to the sign-in page and back. The link's
 * `meta` decides the screen: password, "no longer available", not found,
 * a read-only grid or board, or a public form. Nothing about the
 * organization or other people is shown (FRONTEND §12), no WebSocket is
 * opened (the page polls, SPEC §15A.3), and the viewer's filter, sort and
 * search stay on this page.
 */
export function SharePage({ parts }: SharePageProps) {
  const { token = '' } = useParams();
  const location = useLocation();
  const [params] = useSearchParams();
  // (T814) `?embed=1`: framed by another site (the layout drops the share header too).
  const embed = params.get('embed') === '1';
  const queryClient = useQueryClient();
  const api = useMemo(() => new ShareApi(token), [token]);
  const format = useFormatters();
  const locale = useMemo(
    () => ({ locale: format.locale, timeZone: format.timeZone }),
    [format.locale, format.timeZone],
  );
  const meta = useQuery({
    queryKey: keys.shareMeta(token),
    queryFn: ({ signal }) => api.meta(signal),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  /** A later request ended the page (link revoked while open, unlock expired…). */
  const [ended, setEnded] = useState<Screen | null>(null);
  const [choices, setChoices] = useState<ViewerChoices | null>(null);

  const onFatal = useCallback((error: unknown) => {
    const screen = screenOfError(error, false);
    if (screen !== null) setEnded(screen);
  }, []);
  const onDashboardError = useCallback((error: unknown) => {
    setEnded(screenOfError(error, true) ?? { kind: 'status', status: 'error' });
  }, []);
  const { refetch } = meta;
  const reopen = useCallback(() => {
    setEnded(null);
    // A dashboard link reads its dashboard again (after an unlock, a retry).
    queryClient.removeQueries({ queryKey: keys.shareDashboard(token) });
    void refetch();
  }, [refetch, queryClient, token]);

  let screen: Screen;
  if (ended !== null) screen = ended;
  else if (meta.isPending) screen = { kind: 'loading' };
  else if (meta.isError && isDashboardLink(meta.error)) screen = { kind: 'dashboard' };
  else if (meta.isError)
    screen = screenOfError(meta.error, true) ?? { kind: 'status', status: 'error' };
  else screen = { kind: 'ready', meta: meta.data };

  switch (screen.kind) {
    case 'loading':
      return <ShareLoading />;
    case 'signIn':
      return <SignInFirst next={location} />;
    case 'password':
      return <SharePasswordScreen api={api} onUnlocked={reopen} />;
    case 'status':
      return (
        <ShareStatusScreen
          status={screen.status}
          onRetry={
            screen.status === 'error' || screen.status === 'rateLimited' ? reopen : undefined
          }
        />
      );
    case 'dashboard':
      return (
        <Suspense fallback={<ShareLoading />}>
          <SharedDashboardPage
            api={api}
            Dashboard={parts.Dashboard}
            embed={embed}
            onLoadError={onDashboardError}
            onFatal={onFatal}
          />
        </Suspense>
      );
    case 'ready': {
      const data = screen.meta;
      if (data.target_type === 'form') {
        return (
          <Suspense fallback={<ShareLoading />}>
            <SharedForm
              meta={data}
              api={api}
              FormRenderer={parts.FormRenderer}
              locale={locale}
              onFatal={onFatal}
            />
          </Suspense>
        );
      }
      const props = {
        meta: data,
        api,
        // `allow_export` of the link and the creator's `download` right (CONTRACTS §16A); the
        // menu is a chunk of its own, loaded here so the grid and board chunks do not grow.
        download: data.settings.allow_export ? (
          <Suspense fallback={null}>
            <ShareExportMenu api={api} />
          </Suspense>
        ) : null,
        parts,
        locale,
        choices: choices ?? initialChoices(data),
        onChoices: setChoices,
        onFatal,
      };
      return (
        <Suspense fallback={<ShareLoading />}>
          {data.view.type === 'kanban' ? <SharedBoard {...props} /> : <SharedGrid {...props} />}
        </Suspense>
      );
    }
  }
}

export default SharePage;
