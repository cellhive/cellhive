import { Button } from '@cellhive/ui';
import { TriangleAlert } from 'lucide-react';
import { Component, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { isRouteErrorResponse, useRouteError } from 'react-router';

import { useDocumentTitle } from '../lib/a11y/use-document-title';
import { isApiError } from '../lib/api/client';
import { ErrorAlert } from '../lib/errors/ErrorAlert';

import { NotFoundPage, NotFoundPanel } from './NotFoundPage';

function isNotFound(error: unknown): boolean {
  return (
    (isRouteErrorResponse(error) && error.status === 404) ||
    (isApiError(error) && error.status === 404)
  );
}

function reload(): void {
  window.location.reload();
}

function ErrorContent({ error }: { error: unknown }) {
  const { t } = useTranslation('common');
  useDocumentTitle(t('errorPage.title'));
  return (
    <div className="flex max-w-lg flex-col gap-4">
      <div className="flex items-center gap-2">
        <TriangleAlert aria-hidden="true" className="size-5 text-danger" />
        <h1 className="text-title">{t('errorPage.title')}</h1>
      </div>
      <p className="text-fg-muted">{t('errorPage.description')}</p>
      {isApiError(error) ? <ErrorAlert error={error} /> : null}
      <div>
        <Button onClick={reload}>{t('errorPage.reload')}</Button>
      </div>
    </div>
  );
}

/**
 * Route-level boundary (FRONTEND §8.2) for full-page routes. Render errors
 * are not logged anywhere: no telemetry, and no record data in the console.
 */
export function RouteErrorPage() {
  const error = useRouteError();
  if (isNotFound(error)) return <NotFoundPage />;
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas p-6">
      <ErrorContent error={error} />
    </main>
  );
}

/** Boundary of a page inside the app shell: navigation stays usable. */
export function RouteErrorPanel() {
  const error = useRouteError();
  if (isNotFound(error)) return <NotFoundPanel />;
  return (
    <div className="p-8">
      <ErrorContent error={error} />
    </div>
  );
}

interface RootErrorBoundaryState {
  failed: boolean;
}

function RootErrorFallback() {
  const { t } = useTranslation('common');
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-canvas p-6 text-center">
      <h1 className="text-title">{t('errorPage.title')}</h1>
      <p className="max-w-md text-fg-muted">{t('errorPage.description')}</p>
      <Button onClick={reload}>{t('errorPage.reload')}</Button>
    </main>
  );
}

/**
 * Last-resort boundary around the router and providers (FRONTEND §8.2).
 * Errors are deliberately not reported: no telemetry (SPEC §1A).
 */
export class RootErrorBoundary extends Component<{ children: ReactNode }, RootErrorBoundaryState> {
  override state: RootErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): RootErrorBoundaryState {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? <RootErrorFallback /> : this.props.children;
  }
}
