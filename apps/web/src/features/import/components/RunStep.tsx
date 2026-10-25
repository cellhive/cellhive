import { Alert, Button } from '@cellhive/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../lib/i18n/format';
import { keys } from '../../../lib/query/keys';
import { importsApi } from '../api';
import { useImportJob } from '../job';

import { ProgressBar } from './ProgressBar';

import type { ImportTarget } from './types';
import type { JobDto } from '@cellhive/contracts';

export interface RunStepProps {
  readonly baseId: string;
  readonly jobId: string;
  readonly target: ImportTarget;
  /** Total data rows of the latest preview (for "N of M rows"). */
  readonly totalRows: number;
  readonly onFinished: (job: JobDto) => void;
  /** Replaces the cancel request (tests). */
  readonly cancelImport?: typeof importsApi.cancel;
  /** `GET /jobs/:id` polling interval (tests). */
  readonly pollMs?: number;
}

/**
 * Step 4: the `table.import` job runs; its progress comes from `job.progress`
 * (polling as the fallback). Cancel asks first: rows already written stay
 * (append), a new table goes to the trash (CONTRACTS §19).
 */
export function RunStep({
  baseId,
  jobId,
  target,
  totalRows,
  onFinished,
  cancelImport = importsApi.cancel,
  pollMs,
}: RunStepProps) {
  const { t } = useTranslation('import');
  const format = useFormatters();
  const queryClient = useQueryClient();
  const { status, progress, job } = useImportJob(jobId, pollMs);
  const [confirming, setConfirming] = useState(false);
  const confirmTitle = useId();
  const keep = useRef<HTMLButtonElement>(null);
  const cancel = useMutation({
    mutationFn: () => cancelImport(baseId, jobId),
    onSuccess: (answer) => {
      queryClient.setQueryData(keys.job(jobId), answer);
    },
  });

  useEffect(() => {
    if (job !== undefined) onFinished(job);
  }, [job, onFinished]);

  useEffect(() => {
    if (confirming) keep.current?.focus();
  }, [confirming]);

  const rows = Math.min(totalRows, Math.round(progress * totalRows));
  const statusLine =
    status === 'queued'
      ? t('run.queued')
      : t('run.running', { done: format.number(rows), total: format.number(totalRows) });

  return (
    <div className="flex flex-col gap-4">
      <p role="status" className="text-body">
        {statusLine}
      </p>
      <ProgressBar
        value={progress}
        label={t('run.progress')}
        valueText={t('percent', { percent: format.number(Math.round(progress * 100)) })}
      />
      <p className="text-label font-normal text-fg-muted">{t('run.background')}</p>
      {cancel.error === null ? null : <ErrorAlert error={cancel.error} />}
      {confirming ? (
        <Alert variant="info" role="alertdialog" aria-labelledby={confirmTitle}>
          <p id={confirmTitle} className="font-medium">
            {t('run.confirmTitle')}
          </p>
          <p>{t(target.mode === 'append' ? 'run.confirmAppend' : 'run.confirmCreate')}</p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              variant="danger"
              size="sm"
              disabled={cancel.isPending}
              onClick={() => {
                cancel.mutate();
                setConfirming(false);
              }}
            >
              {t('run.confirmCancel')}
            </Button>
            <Button
              ref={keep}
              variant="secondary"
              size="sm"
              onClick={() => {
                setConfirming(false);
              }}
            >
              {t('run.keepGoing')}
            </Button>
          </div>
        </Alert>
      ) : (
        <div>
          <Button
            variant="secondary"
            disabled={cancel.isPending || cancel.isSuccess}
            onClick={() => {
              setConfirming(true);
            }}
          >
            {t('run.cancel')}
          </Button>
        </div>
      )}
    </div>
  );
}
