import { Button, cn } from '@cellhive/ui';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Check, Download, Minus, Package, Terminal } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { useDocumentTitle } from '../../../lib/a11y/use-document-title';
import { isJobFinished, useJob } from '../../../lib/jobs/use-job';
import { PAGE_GUTTER, PageHeading } from '../../../lib/layout/page-heading';
import { baseQuery } from '../../../lib/query/queries';

import { ExportBaseDialog } from './ExportBaseDialog';
import { ExportStatusLine } from './ExportJob';
import { readLastExport, writeLastExport } from './model';

const SECTION_CLASSES = 'flex flex-col gap-4 rounded-lg border border-line bg-surface p-5';

const INCLUDED = ['data', 'files', 'views', 'automations'] as const;
const EXCLUDED = ['members', 'secrets', 'history', 'personal'] as const;

/**
 * `/b/:baseId/settings/export` (FRONTEND §17.5, CONTRACTS §12.2), base
 * admins (route guard): what a `.chbase` package of the base holds and what
 * it leaves out, "Export base" (a dialog that starts the `base.export` job
 * and follows it to its download), the status of the last export of this
 * tab, and the command line for bases larger than a browser upload.
 */
export function BaseExportPage() {
  const { t } = useTranslation('baseSettings');
  const { baseId = '' } = useParams();
  const { data: base } = useSuspenseQuery(baseQuery(baseId));
  useDocumentTitle(`${t('export.title')} · ${base.name}`);
  const [lastJob, setLastJob] = useState<string | null>(() => readLastExport(baseId));
  const [dialog, setDialog] = useState<{ open: boolean; jobId: string | null }>({
    open: false,
    jobId: null,
  });
  const last = useJob(lastJob);
  // The last export still runs: the button reads "Show progress".
  const running =
    lastJob !== null &&
    last.job === undefined &&
    last.error === null &&
    !isJobFinished(last.status);

  const onJob = useCallback(
    (jobId: string | null) => {
      setDialog({ open: true, jobId });
      if (jobId !== null) {
        setLastJob(jobId);
        writeLastExport(baseId, jobId);
      }
    },
    [baseId],
  );
  const forget = useCallback(() => {
    setLastJob(null);
    writeLastExport(baseId, null);
  }, [baseId]);

  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <PageHeading
        back={{
          to: `/b/${encodeURIComponent(base.id)}`,
          label: t('page.back', { name: base.name }),
        }}
        icon={Package}
        title={t('export.title')}
        subtitle={t('export.subtitle', { name: base.name })}
      />
      <div
        className={cn('flex max-w-3xl flex-col gap-6 py-6', PAGE_GUTTER)}
        data-testid="base-export-page"
      >
        <section aria-labelledby="export-holds-heading" className={SECTION_CLASSES}>
          <h2 id="export-holds-heading" className="text-heading">
            {t('export.holds.title')}
          </h2>
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <h3 className="text-label text-fg-muted">{t('export.holds.included')}</h3>
              <ul className="flex flex-col gap-2">
                {INCLUDED.map((item) => (
                  <li key={item} className="flex gap-2">
                    <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
                    <span>{t(`export.holds.items.${item}`)}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="text-label text-fg-muted">{t('export.holds.excluded')}</h3>
              <ul className="flex flex-col gap-2">
                {EXCLUDED.map((item) => (
                  <li key={item} className="flex gap-2 text-fg-muted">
                    <Minus aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                    <span>{t(`export.holds.missing.${item}`)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-line pt-4">
            <Button
              data-testid="export-open"
              onClick={() => {
                setDialog({ open: true, jobId: running ? lastJob : null });
              }}
            >
              <Download aria-hidden="true" />
              {running ? t('export.showProgress') : t('export.start')}
            </Button>
            {lastJob === null || dialog.open ? null : (
              <ExportStatusLine
                state={last}
                baseName={base.name}
                onShow={() => {
                  setDialog({ open: true, jobId: lastJob });
                }}
                onExpired={forget}
              />
            )}
          </div>
        </section>
        <section aria-labelledby="export-cli-heading" className={SECTION_CLASSES}>
          <h2 id="export-cli-heading" className="flex items-center gap-2 text-heading">
            <Terminal aria-hidden="true" className="size-4 text-fg-muted" />
            {t('export.cli.title')}
          </h2>
          <p className="text-fg-muted">{t('export.cli.body')}</p>
          <pre className="overflow-x-auto rounded-md bg-surface-sunken px-3 py-2 font-mono text-label font-normal">
            {/* i18next-instruction: a command, not UI text */}
            <code>{`cellhive base export --base ${base.id} --out base.chbase`}</code>
          </pre>
        </section>
      </div>
      <ExportBaseDialog
        open={dialog.open}
        onOpenChange={(open) => {
          setDialog((current) => ({ ...current, open }));
        }}
        baseId={base.id}
        baseName={base.name}
        jobId={dialog.jobId}
        onJob={onJob}
      />
    </div>
  );
}

export default BaseExportPage;
