import { Button, cn } from '@cellhive/ui';
import { TriangleAlert } from 'lucide-react';
import { Component, lazy, type ComponentType, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useDocumentTitle } from '../a11y/use-document-title';

import { canReloadPage, ChunkLoadFailed, reloadPage, retryChunk } from './lazy-route';

/**
 * Where a chunk error shows: `page` is a route's screen; `inline` takes the
 * place of a panel or a part of a page; `overlay` floats at the bottom for
 * what would have opened over the page (dialog, drawer, popover) or sits in
 * a toolbar.
 */
export type ChunkErrorVariant = 'page' | 'inline' | 'overlay';

interface ChunkErrorProps {
  variant: ChunkErrorVariant;
  /**
   * "Try again": loads the chunk again. The place's own loading state shows
   * meanwhile (Suspense fallback, the router's first-load skeleton), then the
   * content, or this message again.
   */
  onRetry: () => void;
}

/** The heading of a route's chunk error, which is also the page title (WCAG 2.4.2). */
function PageTitle({ title }: { title: string }) {
  useDocumentTitle(title);
  return <h1 className="text-title">{title}</h1>;
}

/** "Couldn't load this page" (or "this part") with "Try again" and "Reload page" (FRONTEND §8.2). */
export function ChunkError({ variant, onRetry }: ChunkErrorProps) {
  const { t } = useTranslation('common');
  const page = variant === 'page';
  const title = t(page ? 'chunkError.page' : 'chunkError.part');
  // Offered once (lazy-route.ts): right after a reload, only "Try again" is left.
  const reload = canReloadPage();
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center gap-3 p-6 text-center',
        // Floats like a toast (FRONTEND §8.1), bottom center: the toasts keep the bottom right.
        variant === 'overlay' &&
          'fixed inset-x-4 bottom-4 z-50 mx-auto max-w-sm animate-pop-in rounded-lg border border-line bg-surface p-4 shadow-popover',
      )}
    >
      {/* Decorative: lucide sets `aria-hidden` itself. */}
      <TriangleAlert className="size-6 text-danger" />
      {page ? <PageTitle title={title} /> : <p className="font-medium">{title}</p>}
      <p className="max-w-md text-fg-muted">{t('chunkError.description')}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button onClick={onRetry}>{t('chunkError.retry')}</Button>
        {reload ? (
          <Button variant="secondary" onClick={reloadPage}>
            {t('chunkError.reload')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * `React.lazy` for panels and parts of pages (T902): {@link retryChunk}, and
 * an error boundary of its own, so a failure stays inside the panel
 * ({@link ChunkError}) while the rest of the page keeps working; any other
 * error goes on to the boundary above. React keeps a rejected lazy for good,
 * so a failure swaps in a fresh one: "Try again", or the panel's next
 * opening, loads the chunk again.
 */
export function lazyPanel<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
  variant: Exclude<ChunkErrorVariant, 'page'> = 'inline',
): ComponentType<P> {
  const loadChunk = retryChunk(load);
  let Lazy = lazy(loadChunk);
  return class LazyPanel extends Component<P, { error: unknown }> {
    override state: { error: unknown } = { error: null };

    static getDerivedStateFromError(error: unknown) {
      return { error };
    }

    override componentDidCatch(error: unknown): void {
      if (error instanceof ChunkLoadFailed) Lazy = lazy(loadChunk);
    }

    override render(): ReactNode {
      const { error } = this.state;
      if (error === null) return <Lazy {...this.props} />;
      // Not a chunk error: on to the boundary above (a boundary never catches its own render).
      if (!(error instanceof ChunkLoadFailed)) throw error as Error;
      return (
        <ChunkError
          variant={variant}
          onRetry={() => {
            this.setState({ error: null });
          }}
        />
      );
    }
  };
}

/**
 * {@link lazyPanel} for what opens over the page (record panel, dialog,
 * drawer, popover with its frame in the chunk, lightbox) or sits in a
 * toolbar: the message floats at the bottom, where it can always be seen.
 */
export function lazyOverlay<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
): ComponentType<P> {
  return lazyPanel(load, 'overlay');
}
