import { Button, Dialog, Spinner } from '@cellhive/ui';
import { useMutation } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { basePackagesApi } from '../../../lib/api/base-packages';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';

import { ExportJob } from './ExportJob';

export interface ExportBaseDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly baseId: string;
  readonly baseName: string;
  /** The job shown (`null`: the confirmation that starts one). */
  readonly jobId: string | null;
  /** A new export was accepted (`202 { job_id }`), or `null` to confirm a new one. */
  readonly onJob: (jobId: string | null) => void;
  /** `GET /jobs/:id` polling interval (tests). */
  readonly pollMs?: number;
}

/**
 * "Export <base>" (FRONTEND §17.5, CONTRACTS §12.2): first what the package
 * holds — every field, including those roles hide from other members, and
 * not the members, secrets or history — then the job's phases, then its
 * download. Closing it never stops the export: the page keeps its status.
 */
export function ExportBaseDialog({
  open,
  onOpenChange,
  baseId,
  baseName,
  jobId,
  onJob,
  pollMs,
}: ExportBaseDialogProps) {
  const { t } = useTranslation('baseSettings');
  // One key per confirmation: a retried request replays the first answer.
  const idempotencyKey = useRef(`web-${crypto.randomUUID()}`);
  const start = useMutation({
    mutationFn: () => basePackagesApi.export(baseId, idempotencyKey.current),
    onSuccess: (accepted) => {
      idempotencyKey.current = `web-${crypto.randomUUID()}`;
      onJob(accepted.job_id);
    },
  });
  const close = () => {
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('export.dialog.title', { name: baseName })}
      closeLabel={t('export.dialog.close')}
      layout="sheet"
      className="md:max-w-lg"
    >
      {jobId === null ? (
        <div className="flex flex-col gap-4" data-testid="export-confirm">
          <div
            role="note"
            className="flex gap-3 rounded-md border border-warning bg-surface px-3 py-2"
          >
            <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
            <p>{t('export.dialog.warning')}</p>
          </div>
          <p className="text-fg-muted">{t('export.dialog.excluded')}</p>
          {start.isError ? <ErrorAlert error={start.error} /> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={close}>
              {t('export.dialog.cancel')}
            </Button>
            <Button
              disabled={start.isPending}
              onClick={() => {
                start.mutate();
              }}
              data-testid="export-start"
            >
              {start.isPending ? <Spinner /> : null}
              {t('export.dialog.confirm')}
            </Button>
          </div>
        </div>
      ) : (
        <ExportJob
          jobId={jobId}
          baseName={baseName}
          onClose={close}
          onRetry={() => {
            start.reset();
            onJob(null);
          }}
          {...(pollMs === undefined ? {} : { pollMs })}
        />
      )}
    </Dialog>
  );
}
