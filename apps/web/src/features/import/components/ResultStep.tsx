import { Alert, buttonVariants } from '@cellhive/ui';
import { Download, Link2Off } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { problemToApiError } from '../../../lib/api/client';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { translateDetail } from '../../../lib/errors/translate';
import { useFormatters } from '../../../lib/i18n/format';
import { importResultOf } from '../job';
import { isLinkRowCode, linkErrorCounts } from '../mapping';

import type { ImportTarget } from './types';
import type { ImportJobResult, JobDto } from '@cellhive/contracts';

export interface ResultStepProps {
  readonly target: ImportTarget;
  readonly job: JobDto;
}

function Counts({ result }: { result: ImportJobResult }) {
  const { t } = useTranslation('import');
  const format = useFormatters();
  const items = [
    { key: 'imported', value: result.imported },
    { key: 'skipped', value: result.failed },
    { key: 'read', value: result.rows },
  ] as const;
  return (
    <dl className="grid grid-cols-3 gap-3">
      {items.map((item) => (
        <div
          key={item.key}
          className="flex flex-col gap-0.5 rounded-md border border-line px-3 py-2"
        >
          <dt className="text-label font-normal text-fg-muted">{t(`result.${item.key}`)}</dt>
          <dd className="text-title tabular-nums" data-testid={`import-result-${item.key}`}>
            {format.number(item.value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

type RowError = ImportJobResult['errors'][number];

/** Errors grouped by row of the file, in the order of the report (each group is not empty). */
function errorsByRow(errors: readonly RowError[]): [RowError, ...RowError[]][] {
  const groups = new Map<number, [RowError, ...RowError[]]>();
  for (const error of errors) {
    const group = groups.get(error.row);
    if (group === undefined) groups.set(error.row, [error]);
    else group.push(error);
  }
  return [...groups.values()];
}

/** What is wrong with a cell: an unmatched title stands out with what to do (T419). */
function Problem({ code }: { code: string }) {
  const { t, i18n } = useTranslation('import');
  if (!isLinkRowCode(code)) return <span className="block">{translateDetail(i18n, { code })}</span>;
  return (
    <span className="flex flex-col gap-0.5" data-code={code}>
      <span className="flex items-center gap-1.5 font-medium text-warning">
        <Link2Off aria-hidden="true" className="size-3.5 shrink-0" />
        {t(`result.link.${code}`)}
      </span>
      <span className="text-label font-normal text-fg-muted">{t(`result.linkFix.${code}`)}</span>
    </span>
  );
}

/**
 * Row errors (the first 100) and the full report while it can be downloaded
 * (24 h). Titles of link and parent cells that match no record, or several,
 * stand out with what to do about them (T419); the rejected value itself is
 * only in the report (the job result holds no cell values).
 */
function RowErrors({ result }: { result: ImportJobResult }) {
  const { t } = useTranslation('import');
  const format = useFormatters();
  const [now] = useState(() => Date.now());
  if (result.failed === 0) return null;
  const expired = result.expires_at !== undefined && Date.parse(result.expires_at) <= now;
  const links = linkErrorCounts(result.errors);
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-body font-medium">{t('result.errorsHeading')}</h4>
      {links.notFound + links.ambiguous === 0 ? null : (
        <p className="text-label font-normal text-fg-muted" data-testid="import-link-summary">
          {/* Only the counts that are not zero (T421b). */}
          {links.ambiguous === 0
            ? t('result.linkSummaryNotFound', {
                count: links.notFound,
                formatted: format.number(links.notFound),
              })
            : links.notFound === 0
              ? t('result.linkSummaryAmbiguous', {
                  count: links.ambiguous,
                  formatted: format.number(links.ambiguous),
                })
              : t('result.linkSummary', {
                  count: links.notFound + links.ambiguous,
                  notFound: format.number(links.notFound),
                  ambiguous: format.number(links.ambiguous),
                })}
        </p>
      )}
      <div
        role="region"
        aria-label={t('result.errorsHeading')}
        tabIndex={0}
        className="max-h-60 overflow-auto rounded-md border border-line"
      >
        <table className="w-full border-collapse text-body">
          <thead className="sticky top-0 bg-surface-sunken text-left text-label">
            <tr>
              <th scope="col" className="px-2 py-1.5">
                {t('result.row')}
              </th>
              <th scope="col" className="px-2 py-1.5">
                {t('result.column')}
              </th>
              <th scope="col" className="px-2 py-1.5">
                {t('result.problem')}
              </th>
            </tr>
          </thead>
          <tbody>
            {/* One line per row of the file: its first problem, the others folded (T421b). */}
            {errorsByRow(result.errors).map(([first, ...others]) => (
              <tr
                key={`${String(first.row)}:${String(first.column)}:${first.code}`}
                className="border-t border-line align-top"
                data-testid="import-error-row"
              >
                <td className="px-2 py-1 tabular-nums">
                  {first.data_row === undefined
                    ? format.number(first.row)
                    : // Numbered like the preview; the file's own row number beside it (T320).
                      t('result.rowOf', {
                        dataRow: format.number(first.data_row),
                        fileRow: format.number(first.row),
                      })}
                </td>
                <td className="px-2 py-1">{first.column_name ?? t('result.wholeRow')}</td>
                <td className="px-2 py-1">
                  <Problem code={first.code} />
                  {others.length === 0 ? null : (
                    <details className="mt-1" data-testid="import-error-more">
                      <summary className="cursor-pointer text-label font-normal text-accent">
                        {t('result.moreInRow', {
                          count: others.length,
                          formatted: format.number(others.length),
                        })}
                      </summary>
                      <ul className="mt-1 flex flex-col gap-1.5">
                        {others.map((error) => (
                          <li key={`${String(error.column)}:${error.code}`}>
                            <span className="font-medium">
                              {error.column_name ?? t('result.wholeRow')}
                            </span>
                            <Problem code={error.code} />
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result.errors.length < result.failed ? (
        <p className="text-label font-normal text-fg-muted">
          {t('result.moreErrors', { shown: format.number(result.errors.length) })}
        </p>
      ) : null}
      {result.download_url !== undefined && !expired ? (
        <p className="text-label font-normal text-fg-muted">{t('result.reportHint')}</p>
      ) : null}
      {result.download_url !== undefined && !expired ? (
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={result.download_url}
            download
            className={buttonVariants({ variant: 'secondary', size: 'sm' })}
          >
            <Download aria-hidden="true" />
            {t('result.downloadReport')}
          </a>
          {result.expires_at === undefined ? null : (
            <span className="text-label font-normal text-fg-muted">
              {t('result.reportUntil', { time: format.dateTime(result.expires_at) })}
            </span>
          )}
        </div>
      ) : (
        <p className="text-label font-normal text-fg-muted">{t('result.reportGone')}</p>
      )}
      {result.errors_truncated ? (
        <p className="text-label font-normal text-fg-muted">{t('result.truncated')}</p>
      ) : null}
    </div>
  );
}

/**
 * Step 5: how the import ended — rows imported and skipped, the row errors
 * with their downloadable report, or why the job failed or that it was
 * cancelled (CONTRACTS §19).
 */
export function ResultStep({ target, job }: ResultStepProps) {
  const { t } = useTranslation('import');
  const result = importResultOf(job);
  if (job.status === 'cancelled') {
    return (
      <Alert variant="info">
        <p className="font-medium">{t('result.cancelled')}</p>
        <p>{t(target.mode === 'append' ? 'result.cancelledAppend' : 'result.cancelledCreate')}</p>
      </Alert>
    );
  }
  if (job.status === 'failed') {
    const status = typeof job.error?.['status'] === 'number' ? job.error['status'] : 0;
    return (
      <div className="flex flex-col gap-3">
        <ErrorAlert error={problemToApiError(status, job.error)} />
        <p className="text-fg-muted">
          {t(target.mode === 'append' ? 'result.failedAppend' : 'result.failedCreate')}
        </p>
      </div>
    );
  }
  if (result === undefined) {
    return (
      <Alert variant="success">
        <p>{t('result.done')}</p>
      </Alert>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <Alert variant={result.failed === 0 ? 'success' : 'info'}>
        <p>{result.failed === 0 ? t('result.success') : t('result.partial')}</p>
      </Alert>
      <Counts result={result} />
      <RowErrors result={result} />
    </div>
  );
}
