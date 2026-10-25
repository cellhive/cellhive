import { Button, cn, Dialog, Spinner } from '@cellhive/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { keys } from '../../../lib/query/keys';
import { trackJob } from '../../../lib/realtime/jobs';
import { importResultOf } from '../job';

import { MappingStep } from './MappingStep';
import { PreviewStep } from './PreviewStep';
import { ResultStep } from './ResultStep';
import { RunStep } from './RunStep';
import { UploadStep } from './UploadStep';

import type { ImportTarget } from './types';
import type { ImportPreview, ImportUploadDto, JobDto } from '@cellhive/contracts';
import type { QueryClient } from '@tanstack/react-query';

export type { ImportTarget } from './types';

export const IMPORT_STEPS = ['upload', 'preview', 'mapping', 'run', 'result'] as const;
export type ImportStep = (typeof IMPORT_STEPS)[number];

export interface ImportWizardProps {
  readonly baseId: string;
  readonly target: ImportTarget;
  readonly onClose: () => void;
}

/** What changed once an import ended: the new table, or the rows of the table. */
function refreshAfterImport(queryClient: QueryClient, baseId: string, tableId: string | undefined) {
  void queryClient.invalidateQueries({ queryKey: keys.tables(baseId) });
  void queryClient.invalidateQueries({ queryKey: keys.base(baseId), exact: true });
  if (tableId !== undefined) {
    // Realtime (`record.batch`) already refreshes open grids; this covers missed messages.
    void queryClient.invalidateQueries({ queryKey: keys.recordBlocks(tableId) });
    void queryClient.invalidateQueries({ queryKey: keys.groupCountLists(tableId) });
  }
}

function Stepper({ step }: { step: ImportStep }) {
  const { t } = useTranslation('import');
  const current = IMPORT_STEPS.indexOf(step);
  return (
    <ol
      aria-label={t('steps.label')}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-label"
    >
      {IMPORT_STEPS.map((item, index) => (
        <li
          key={item}
          aria-current={index === current ? 'step' : undefined}
          className={cn(
            'flex items-center gap-1.5',
            index === current ? 'font-medium text-fg' : 'font-normal text-fg-muted',
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'flex size-5 items-center justify-center rounded-full border text-label',
              index < current
                ? 'border-accent bg-accent text-on-accent'
                : index === current
                  ? 'border-accent text-accent'
                  : 'border-line-strong',
            )}
          >
            {index < current ? <Check className="size-3" /> : index + 1}
          </span>
          {t(`steps.${item}`)}
          {index < current ? <span className="sr-only">{t('steps.done')}</span> : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * The import wizard (T318, CONTRACTS §19, FRONTEND §2): upload → preview →
 * mapping → run → result, into a new table (base admins) or appended to a
 * table. A lazy chunk: loaded when the dialog first opens.
 *
 * Closing while the job runs does not cancel it: the job goes on and a toast
 * follows it (`trackJob`); cancelling is an explicit, confirmed action.
 */
export function ImportWizard({ baseId, target, onClose }: ImportWizardProps) {
  const { t } = useTranslation('import');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState<ImportStep>('upload');
  const [upload, setUpload] = useState<ImportUploadDto | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobDto | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // Leaving the column step loses the choices made there: asked first (T320 QA).
  const [confirmLeave, setConfirmLeave] = useState(false);
  const guarded = step === 'mapping';
  useEffect(() => {
    if (!guarded) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // Escape inside a menu or list of the step closes that first.
      if (
        event.target instanceof Element &&
        event.target.closest('[role="listbox"], [role="menu"]')
      )
        return;
      // Before the dialog closes itself (its `cancel` follows this key).
      event.preventDefault();
      event.stopPropagation();
      setConfirmLeave((open) => !open);
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => {
      document.removeEventListener('keydown', onKeyDown, { capture: true });
    };
  }, [guarded]);

  // Each step starts at its heading, so screen readers hear where they are.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
  }, [step]);

  const tableIdOf = (ended: JobDto | null) =>
    importResultOf(ended ?? undefined)?.table_id ??
    (target.mode === 'append' ? target.tableId : undefined);

  const onFinished = useCallback(
    (ended: JobDto) => {
      setJob(ended);
      setStep('result');
      const result = importResultOf(ended);
      refreshAfterImport(
        queryClient,
        baseId,
        result?.table_id ?? (target.mode === 'append' ? target.tableId : undefined),
      );
    },
    [queryClient, baseId, target],
  );

  const close = () => {
    if (guarded && !confirmLeave) {
      setConfirmLeave(true);
      return;
    }
    if (step === 'run' && jobId !== null && job === null) {
      // The import goes on in the background, followed by a toast.
      const appendTable = target.mode === 'append' ? target.tableId : undefined;
      trackJob(jobId, {
        messages: {
          running: t('background.running'),
          succeeded: t('background.succeeded'),
          failed: t('background.failed'),
        },
        onSettled: () => {
          refreshAfterImport(queryClient, baseId, appendTable);
        },
      });
    }
    onClose();
  };

  const title =
    target.mode === 'append' ? t('title.append', { table: target.tableName }) : t('title.create');

  const openTable = () => {
    const tableId = tableIdOf(job);
    onClose();
    if (tableId !== undefined && target.mode === 'create_table') {
      void navigate(`/b/${encodeURIComponent(baseId)}/t/${encodeURIComponent(tableId)}`);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={title}
      description={upload === null ? t('description') : t('file', { name: upload.filename })}
      closeLabel={t('close')}
      className="max-w-4xl"
    >
      <div className="flex min-w-0 flex-col gap-4" data-testid="import-wizard">
        <Stepper step={step} />
        {guarded && confirmLeave ? (
          <ConfirmLeave
            onStay={() => {
              setConfirmLeave(false);
            }}
            onLeave={onClose}
          />
        ) : null}
        <h3 ref={heading} tabIndex={-1} className="text-body font-medium outline-none">
          {t(`headings.${step}`)}
        </h3>
        {step === 'upload' ? (
          <UploadStep
            baseId={baseId}
            onUploaded={(uploaded) => {
              setUpload(uploaded);
              setPreview(uploaded.preview);
              setStep('preview');
            }}
          />
        ) : null}
        {step === 'preview' && upload !== null && preview !== null ? (
          <>
            <PreviewStep
              baseId={baseId}
              upload={upload}
              preview={preview}
              onPreview={setPreview}
              onLoading={setPreviewBusy}
            />
            <Footer>
              <Button
                variant="secondary"
                onClick={() => {
                  setUpload(null);
                  setPreview(null);
                  setStep('upload');
                }}
              >
                {t('actions.otherFile')}
              </Button>
              <Button
                disabled={previewBusy || preview.total_rows === 0 || preview.columns.length === 0}
                onClick={() => {
                  setStep('mapping');
                }}
              >
                {t('actions.next')}
              </Button>
            </Footer>
          </>
        ) : null}
        {step === 'mapping' && upload !== null && preview !== null ? (
          <MappingStep
            baseId={baseId}
            target={target}
            upload={upload}
            preview={preview}
            onStarted={(started) => {
              setJobId(started);
              setStep('run');
            }}
            footer={({ disabled, pending, run }) => (
              <Footer>
                <Button
                  variant="secondary"
                  disabled={pending}
                  onClick={() => {
                    setStep('preview');
                  }}
                >
                  {t('actions.back')}
                </Button>
                <Button disabled={disabled || pending} onClick={run}>
                  {pending ? <Spinner /> : null}
                  {t('actions.start', { count: preview.total_rows })}
                </Button>
              </Footer>
            )}
          />
        ) : null}
        {step === 'run' && jobId !== null && preview !== null ? (
          <RunStep
            baseId={baseId}
            jobId={jobId}
            target={target}
            totalRows={preview.total_rows}
            onFinished={onFinished}
          />
        ) : null}
        {step === 'result' && job !== null ? (
          <>
            <ResultStep target={target} job={job} />
            <Footer>
              {job.status === 'succeeded' && target.mode === 'create_table' ? (
                <Button onClick={openTable}>{t('actions.openTable')}</Button>
              ) : null}
              <Button
                variant={
                  job.status === 'succeeded' && target.mode === 'create_table'
                    ? 'secondary'
                    : 'primary'
                }
                onClick={onClose}
              >
                {t('actions.done')}
              </Button>
            </Footer>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}

/** "Leave the import?" asked on Escape or close while columns are being set. */
function ConfirmLeave({ onStay, onLeave }: { onStay: () => void; onLeave: () => void }) {
  const { t } = useTranslation('import');
  const id = useId();
  const stay = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    stay.current?.focus();
  }, []);
  return (
    <div
      role="alertdialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      className="flex flex-col gap-2 rounded-md border border-warning px-3 py-2"
      data-testid="import-confirm-leave"
    >
      <p id={`${id}-title`} className="font-semibold">
        {t('leave.title')}
      </p>
      <p id={`${id}-description`} className="text-body">
        {t('leave.description')}
      </p>
      <div className="flex justify-end gap-2">
        <Button ref={stay} variant="secondary" onClick={onStay}>
          {t('leave.stay')}
        </Button>
        <Button variant="danger" onClick={onLeave}>
          {t('leave.confirm')}
        </Button>
      </div>
    </div>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">{children}</div>
  );
}

export default ImportWizard;
