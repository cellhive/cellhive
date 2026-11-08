import { Alert, Button, buttonVariants, cn } from '@cellhive/ui';
import { CircleAlert, Download, PackageCheck } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import {
  baseExportPhaseOf,
  EXPORT_PHASES,
  exportResultOf,
  jobErrorOf,
  packageDownloadUrl,
} from '../../../lib/api/base-packages';
import { formatBytes } from '../../../lib/attachments/format';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../lib/i18n/format';
import { JobPhases } from '../../../lib/jobs/JobPhases';
import { useJob, type JobState } from '../../../lib/jobs/use-job';

import type { BaseExportResult } from '@cellhive/contracts';

/** What a `base.export` job shows: its outcome once it ended, else its progress. */
export type ExportOutcome =
  | { readonly kind: 'running' | 'queued' }
  | { readonly kind: 'ready'; readonly result: BaseExportResult; readonly url: string }
  | { readonly kind: 'expired' | 'cancelled' }
  | { readonly kind: 'failed'; readonly error: unknown };

/** The outcome of an export job from its state (FRONTEND §17.5). */
export function exportOutcome(state: JobState): ExportOutcome {
  const { job, status, error } = state;
  if (job === undefined) {
    if (error !== null) return { kind: 'failed', error };
    return { kind: status === 'queued' ? 'queued' : 'running' };
  }
  if (job.status === 'succeeded') {
    const result = exportResultOf(job);
    const url = packageDownloadUrl(result);
    return result === undefined || url === null
      ? { kind: 'expired' }
      : { kind: 'ready', result, url };
  }
  if (job.status === 'cancelled') return { kind: 'cancelled' };
  return { kind: 'failed', error: jobErrorOf(job) };
}

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-line bg-surface-sunken px-3 py-2">
      <dt className="text-label font-normal text-fg-muted">{label}</dt>
      <dd className="text-heading tabular-nums">{value}</dd>
    </div>
  );
}

export interface ExportJobProps {
  readonly jobId: string;
  readonly baseName: string;
  /** "Export again" after a failure, a cancel or an expired download. */
  readonly onRetry: () => void;
  readonly onClose: () => void;
  /** `GET /jobs/:id` polling interval (tests). */
  readonly pollMs?: number;
}

/**
 * The export job inside its dialog (CONTRACTS §12.2): the phases while it
 * runs (`job.progress`), then the download with the size, the counts and
 * when the link expires, or what went wrong.
 */
export function ExportJob({ jobId, baseName, onRetry, onClose, pollMs }: ExportJobProps) {
  const { t } = useTranslation('baseSettings');
  const format = useFormatters();
  const state = useJob(jobId, pollMs);
  const outcome = exportOutcome(state);
  const close = (
    <Button variant="secondary" onClick={onClose}>
      {t('export.dialog.close')}
    </Button>
  );
  const retry = (
    <Button variant="secondary" onClick={onRetry}>
      {t('export.retry')}
    </Button>
  );

  if (outcome.kind === 'ready') {
    const { result, url } = outcome;
    const fileName = `${baseName}.chbase`;
    return (
      <div className="flex animate-reveal flex-col gap-4" data-testid="export-ready">
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 animate-pop-in items-center justify-center rounded-full bg-accent-soft text-accent">
            <PackageCheck aria-hidden="true" className="size-5" />
          </span>
          <div className="flex min-w-0 flex-col">
            <p className="text-heading" role="status">
              {t('export.ready.title')}
            </p>
            <p className="truncate text-fg-muted">
              {fileName} · {formatBytes(result.size, format.locale)}
            </p>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label={t('export.counts.tables')} value={format.number(result.counts.tables)} />
          <Stat label={t('export.counts.fields')} value={format.number(result.counts.fields)} />
          <Stat label={t('export.counts.records')} value={format.number(result.counts.records)} />
          <Stat label={t('export.counts.files')} value={format.number(result.counts.attachments)} />
        </dl>
        <div className="flex flex-col gap-1 text-fg-muted">
          {result.expires_at === undefined ? null : (
            <p>{t('export.ready.expires', { time: format.dateTime(result.expires_at) })}</p>
          )}
          <p>{t('export.ready.keepSafe')}</p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {close}
          <a
            href={url}
            download
            aria-label={t('export.ready.downloadName', { name: fileName })}
            className={cn(buttonVariants({ variant: 'primary' }))}
            data-testid="export-download"
          >
            <Download aria-hidden="true" />
            {t('export.ready.download')}
          </a>
        </div>
      </div>
    );
  }

  if (outcome.kind !== 'running' && outcome.kind !== 'queued') {
    return (
      <div className="flex animate-reveal flex-col gap-4" data-testid="export-failed">
        {outcome.kind === 'failed' ? (
          outcome.error === undefined ? (
            <Alert variant="danger">
              <p>{t('export.failed')}</p>
            </Alert>
          ) : (
            <ErrorAlert error={outcome.error} />
          )
        ) : (
          <Alert variant={outcome.kind === 'expired' ? 'info' : 'danger'}>
            <p>{t(outcome.kind === 'expired' ? 'export.expired' : 'export.cancelled')}</p>
          </Alert>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {close}
          {retry}
        </div>
      </div>
    );
  }

  const percent = t('export.percent', { percent: format.number(Math.round(state.progress * 100)) });
  return (
    <div className="flex flex-col gap-4" data-testid="export-progress">
      <JobPhases
        phases={EXPORT_PHASES.map((key) => ({ key, label: t(`export.phases.${key}`) }))}
        current={outcome.kind === 'queued' ? null : baseExportPhaseOf(state.progress)}
        progress={state.progress}
        label={t('export.progress')}
        valueText={percent}
        stateText={{
          done: t('export.state.done'),
          active: t('export.state.active'),
          failed: t('export.state.failed'),
          pending: t('export.state.pending'),
        }}
      />
      <p className="text-fg-muted" aria-live="polite">
        {outcome.kind === 'queued' ? t('export.queued') : t('export.running')}
      </p>
      <div className="flex justify-end">{close}</div>
    </div>
  );
}

export interface ExportStatusLineProps {
  /** The last export of this tab ({@link useJob} of the page). */
  readonly state: JobState;
  readonly baseName: string;
  /** Opens the dialog on the job (progress, failure). */
  readonly onShow: () => void;
  /** The download is gone: forget the job. */
  readonly onExpired: () => void;
}

/**
 * The last export of this tab under "Export base" once its dialog is
 * closed: its progress, its download, or that it failed (details in the
 * dialog). An expired download is forgotten.
 */
export function ExportStatusLine({ state, baseName, onShow, onExpired }: ExportStatusLineProps) {
  const { t } = useTranslation('baseSettings');
  const format = useFormatters();
  const outcome = exportOutcome(state);
  const gone = outcome.kind === 'expired' || outcome.kind === 'cancelled';
  useEffect(() => {
    if (gone) onExpired();
  }, [gone, onExpired]);
  if (gone) return null;
  if (outcome.kind === 'ready') {
    const fileName = `${baseName}.chbase`;
    return (
      <div
        className="flex animate-reveal flex-wrap items-center gap-x-3 gap-y-2"
        data-testid="export-status"
      >
        <PackageCheck aria-hidden="true" className="size-4 shrink-0 text-success" />
        <span role="status">
          {t('export.status.ready', { size: formatBytes(outcome.result.size, format.locale) })}
        </span>
        <a
          href={outcome.url}
          download
          aria-label={t('export.ready.downloadName', { name: fileName })}
          className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}
        >
          <Download aria-hidden="true" />
          {t('export.ready.download')}
        </a>
      </div>
    );
  }
  if (outcome.kind === 'failed') {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="export-status">
        <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-danger" />
        <span role="status">{t('export.status.failed')}</span>
        <Button variant="ghost" size="sm" onClick={onShow}>
          {t('export.showDetails')}
        </Button>
      </div>
    );
  }
  const percent = t('export.percent', { percent: format.number(Math.round(state.progress * 100)) });
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3" data-testid="export-status">
      <div
        aria-hidden="true"
        className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-surface-sunken"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-(--motion-sheet) ease-(--ease-enter) motion-reduce:transition-none"
          style={{ width: `${String(Math.round(state.progress * 100))}%` }}
        />
      </div>
      <span role="status" className="text-fg-muted">
        {outcome.kind === 'queued'
          ? t('export.status.queued')
          : t('export.status.running', { percent })}
      </span>
    </div>
  );
}
