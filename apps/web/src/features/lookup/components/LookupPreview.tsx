import {
  formatComputedText,
  parseComputedStyle,
  type ComputedResultType,
} from '@cellhive/field-types';
import { Alert, Button, cn, Skeleton } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { Lock, Sigma, TriangleAlert } from 'lucide-react';
import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../lib/api/client';
import { translateError } from '../../../lib/errors/translate';
import { useFormatters } from '../../../lib/i18n/format';
import { orgMembersQuery } from '../../../lib/query/queries';
import { useRecordTitles } from '../use-lookup-preview';

import type { ComputedPreview } from '@cellhive/contracts';

export interface LookupPreviewProps {
  readonly tableId: string;
  readonly orgId: string;
  /** Primary field name of this table (first column). */
  readonly titleHeader: string;
  /** `undefined`: nothing previewed yet. */
  readonly preview: ComputedPreview | undefined;
  /** The definition is not complete: nothing to preview. */
  readonly idle: boolean;
  readonly loading: boolean;
  readonly stale: boolean;
  readonly error: unknown;
  readonly onRetry: () => void;
  /** Source table name (the permission note). */
  readonly sourceName: string | undefined;
}

/**
 * The right pane of the lookup dialog (board "S4b · Cấu hình tra cứu"):
 * the first 5 records the user reads with the value the field would have,
 * formatted like the column (`cell_format=text` of `field-types`); how the
 * value is kept; that people who cannot read the source see a locked cell.
 */
export function LookupPreview({
  tableId,
  orgId,
  titleHeader,
  preview,
  idle,
  loading,
  stale,
  error,
  onRetry,
  sourceName,
}: LookupPreviewProps) {
  const { t, i18n } = useTranslation(['lookup', 'errors']);
  const format = useFormatters();
  const headingId = useId();
  const records = preview?.records;
  const ids = useMemo(() => (records ?? []).map((record) => record.id), [records]);
  const titles = useRecordTitles(tableId, ids);
  const needsUsers = preview?.result_type.kind === 'user';
  const members = useQuery({ ...orgMembersQuery(orgId), enabled: needsUsers && orgId !== '' });
  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of members.data?.items ?? []) {
      map.set(member.user.id, member.user.display_name || member.user.email);
    }
    return map;
  }, [members.data]);

  const text = (value: unknown, type: ComputedResultType): string => {
    if (value === null || value === undefined) return '';
    if (type.kind === 'record') {
      const count = Array.isArray(value) ? value.length : 1;
      return t('lookup:preview.records', { count });
    }
    const style = parseComputedStyle(preview?.style ?? null, type);
    const readable =
      type.kind === 'user'
        ? Array.isArray(value)
          ? (value as unknown[]).map((item) =>
              typeof item === 'string' ? (names.get(item) ?? item) : item,
            )
          : typeof value === 'string'
            ? (names.get(value) ?? value)
            : value
        : value;
    return formatComputedText(readable, type, style.ok ? style.style : null, {
      locale: format.locale,
      timeZone: format.timeZone,
    });
  };

  let body;
  if (idle) {
    body = <p className="text-body text-fg-muted">{t('lookup:preview.idle')}</p>;
  } else if (error !== null && error !== undefined) {
    const translated = translateError(error, i18n);
    const placed = isApiError(error) && error.status === 422;
    body = (
      <Alert variant={placed ? 'info' : 'danger'} data-testid="lookup-preview-error">
        <p>{placed ? t('lookup:preview.invalid') : translated.message}</p>
        {placed ? null : (
          <div>
            <Button variant="secondary" size="sm" onClick={onRetry}>
              {t('lookup:preview.retry')}
            </Button>
          </div>
        )}
      </Alert>
    );
  } else if (loading || preview === undefined) {
    body = (
      <div className="flex flex-col gap-2" role="status" aria-label={t('lookup:preview.loading')}>
        {[0, 1, 2, 3, 4].map((row) => (
          <Skeleton key={row} className="h-8 w-full" />
        ))}
      </div>
    );
  } else if (preview.records.length === 0) {
    body = <p className="text-body text-fg-muted">{t('lookup:preview.empty')}</p>;
  } else {
    body = (
      <div
        role="table"
        aria-labelledby={headingId}
        aria-busy={stale || undefined}
        data-testid="lookup-preview"
        className={cn(
          'overflow-hidden rounded-lg border border-line bg-surface transition-opacity motion-reduce:transition-none',
          stale && 'opacity-60',
        )}
      >
        <div
          role="row"
          className="grid h-8 grid-cols-[minmax(0,1fr)_minmax(0,11rem)] items-center bg-surface-sunken text-label text-fg-muted"
        >
          <span role="columnheader" className="truncate px-2.5">
            {titleHeader}
          </span>
          <span
            role="columnheader"
            className="flex items-center justify-end gap-1.5 px-2.5 text-right"
          >
            <Sigma aria-hidden="true" className="size-3.5" />
            {t('lookup:preview.result')}
          </span>
        </div>
        {preview.records.map((record) => (
          <div
            key={record.id}
            role="row"
            className="grid min-h-9 grid-cols-[minmax(0,1fr)_minmax(0,11rem)] items-center border-t border-line"
          >
            <span role="cell" className="truncate px-2.5 text-body">
              {titles.get(record.id) || t('lookup:preview.untitled')}
            </span>
            <span
              role="cell"
              className="truncate px-2.5 text-right text-body font-medium tabular-nums"
              data-testid="lookup-preview-value"
            >
              {text(record.value, preview.result_type) || (
                <span className="font-normal text-fg-muted">{t('lookup:preview.blank')}</span>
              )}
            </span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      <h3 id={headingId} className="text-body font-semibold text-fg">
        {t('lookup:preview.title')}
      </h3>
      {body}
      {preview !== undefined && error === null ? (
        <p className="text-label font-normal text-fg-muted" data-testid="lookup-compute-mode">
          {t(`lookup:preview.mode.${preview.compute_mode}`)}
        </p>
      ) : null}
      {preview?.perf_warning === 'cross_table_scan' ? (
        <p className="flex items-start gap-1.5 text-label font-normal text-warning">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {t('lookup:preview.perfWarning')}
        </p>
      ) : null}
      {sourceName === undefined ? null : (
        <div
          role="note"
          className="flex items-start gap-2 rounded-lg border border-line bg-surface-sunken px-3 py-2.5 text-label font-normal"
        >
          <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-fg-muted" />
          <span>
            <strong className="font-semibold text-fg">
              {t('lookup:preview.lockedTitle', { table: sourceName })}
            </strong>{' '}
            <span className="text-fg-muted">{t('lookup:preview.lockedHint')}</span>
          </span>
        </div>
      )}
    </section>
  );
}
