import { Alert, Button, buttonVariants, cn } from '@cellhive/ui';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../lib/i18n/format';
import { useExportJob } from '../job';
import { safeDownloadUrl } from '../model';

export interface ExportStatusProps {
  readonly jobId: string;
  readonly onDismiss: () => void;
  /** `GET /jobs/:id` polling interval (tests). */
  readonly pollMs?: number;
}

/**
 * The audit export job after `202 { job_id }` (CONTRACTS §11.4, §12.2):
 * progress (`job.progress`, polling as the fallback), then the download
 * link of the CSV, or the failure.
 */
export function ExportStatus({ jobId, onDismiss, pollMs }: ExportStatusProps) {
  const { t } = useTranslation('audit');
  const format = useFormatters();
  const { status, progress, job, error } = useExportJob(jobId, pollMs);
  const dismiss = (
    <Button variant="ghost" size="sm" onClick={onDismiss}>
      {t('export.dismiss')}
    </Button>
  );

  if (error !== null && job === undefined) {
    return (
      <div className="flex flex-col gap-2" data-testid="audit-export-status">
        <ErrorAlert error={error} />
        <div>{dismiss}</div>
      </div>
    );
  }

  if (job !== undefined) {
    const url = job.status === 'succeeded' ? safeDownloadUrl(job.result) : null;
    if (url === null) {
      return (
        <Alert variant="danger" data-testid="audit-export-status">
          <p>{t('export.failed')}</p>
          <div>{dismiss}</div>
        </Alert>
      );
    }
    const rows = typeof job.result?.['rows'] === 'number' ? job.result['rows'] : null;
    const expires =
      typeof job.result?.['expires_at'] === 'string' ? job.result['expires_at'] : null;
    return (
      <Alert variant="info" data-testid="audit-export-status">
        <p>{t('export.ready', { count: rows ?? 0 })}</p>
        {job.result?.['truncated'] === true ? <p>{t('export.truncated')}</p> : null}
        {expires === null ? null : (
          <p className="text-fg-muted">{t('export.expires', { time: format.dateTime(expires) })}</p>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          <a
            href={url}
            download
            className={cn(buttonVariants({ variant: 'primary' }))}
            data-testid="audit-export-download"
          >
            <Download aria-hidden="true" />
            {t('export.download')}
          </a>
          {dismiss}
        </div>
      </Alert>
    );
  }

  const percent = Math.round(progress * 100);
  return (
    <Alert variant="info" data-testid="audit-export-status">
      <p>{status === 'queued' ? t('export.queued') : t('export.running', { percent })}</p>
      <div
        role="progressbar"
        aria-label={t('export.progress')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken"
      >
        <div
          className="h-full bg-accent transition-[width] motion-reduce:transition-none"
          style={{ width: `${String(percent)}%` }}
        />
      </div>
    </Alert>
  );
}
