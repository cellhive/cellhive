import { Button } from '@cellhive/ui';
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useDocumentTitle } from '../../../../lib/a11y/use-document-title';

import type { ShareMeta } from '@cellhive/contracts';

/**
 * No realtime through links (SPEC §15A.3, Phase 2): the page reloads what it
 * shows every minute while the tab is visible (≥ 30 s, like the dashboards'
 * `refresh_seconds`), and on the refresh button.
 */
export const SHARE_REFRESH_MS = 60_000;

export function useShareRefresh(refresh: () => void): {
  readonly updatedAt: number;
  readonly refresh: () => void;
} {
  const [updatedAt, setUpdatedAt] = useState(() => Date.now());
  const latest = useRef(refresh);
  useEffect(() => {
    latest.current = refresh;
  });
  const run = useCallback(() => {
    latest.current();
    setUpdatedAt(Date.now());
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') run();
    }, SHARE_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [run]);
  return { updatedAt, refresh: run };
}

export interface ShareViewHeaderProps {
  readonly meta: ShareMeta;
  /** (T814) "Download" (CSV/XLSX) of a link with `allow_export`, else `null`. */
  readonly download: ReactNode;
  /** Number of records (or loading text). */
  readonly count: ReactNode;
  readonly updatedAt: number;
  readonly onRefresh: () => void;
  /** Filter, sort, search of the viewer (when the link allows them). */
  readonly tools?: ReactNode;
}

/** Title of a shared view, its record count, the refresh button and the viewer's tools. */
export function ShareViewHeader({
  meta,
  download,
  count,
  updatedAt,
  onRefresh,
  tools,
}: ShareViewHeaderProps) {
  const { t, i18n } = useTranslation('sharePage');
  useDocumentTitle(meta.view.name);
  const time = new Intl.DateTimeFormat(i18n.language, { timeStyle: 'short' }).format(updatedAt);
  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="text-label font-normal text-fg-muted">
            {meta.view.type === 'kanban' ? t('view.kind.kanban') : t('view.kind.grid')} ·{' '}
            {meta.table.name}
          </p>
          <h1 className="truncate text-title">{meta.view.name}</h1>
        </div>
        <div className="flex items-center gap-3 text-label font-normal text-fg-muted">
          <span data-testid="share-count">{count}</span>
          <span>{t('view.updated', { time })}</span>
          <Button variant="secondary" size="sm" onClick={onRefresh}>
            <RefreshCw aria-hidden="true" />
            {t('view.refresh')}
          </Button>
          {download}
        </div>
      </div>
      {tools === undefined || tools === null ? null : (
        <div
          role="toolbar"
          aria-label={t('view.tools')}
          className="flex flex-wrap items-center gap-2"
        >
          {tools}
        </div>
      )}
    </div>
  );
}
