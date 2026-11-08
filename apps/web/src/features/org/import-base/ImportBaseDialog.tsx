import { BASE_PACKAGE_DEFAULT_MAX_BYTES, type WorkspaceDto } from '@cellhive/contracts';
import { Alert, Button, cn, Dialog } from '@cellhive/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileArchive, PackagePlus, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import {
  baseImportPhaseOf,
  basePackagesApi,
  checkPackageFile,
  IMPORT_PHASES,
  importResultOf,
  jobErrorOf,
  moreProblemsOf,
  type PackageFileProblem,
} from '../../../lib/api/base-packages';
import { isApiError } from '../../../lib/api/client';
import { formatBytes } from '../../../lib/attachments/format';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../lib/i18n/format';
import { JobPhases } from '../../../lib/jobs/JobPhases';
import { useJob } from '../../../lib/jobs/use-job';
import { keys } from '../../../lib/query/keys';
import { baseQuery } from '../../../lib/query/queries';
import { trackJob } from '../../../lib/realtime/jobs';

import { ImportProblems } from './ImportProblems';
import { ImportReport } from './ImportReport';

/** The phase before those of the job: sending the file. */
const UPLOAD_PHASE = 'upload';

/** Share of the overall bar the upload takes before the job's own phases. */
const UPLOAD_SHARE = 0.1;

type Step =
  | {
      readonly kind: 'pick';
      readonly file: File | null;
      readonly problem: PackageFileProblem | null;
      readonly error: unknown;
    }
  | { readonly kind: 'uploading'; readonly file: File; readonly sent: number }
  | { readonly kind: 'job'; readonly file: File; readonly jobId: string };

const PICK: Step = { kind: 'pick', file: null, problem: null, error: null };

export interface ImportBaseDialogProps {
  readonly workspace: WorkspaceDto;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /**
   * How many times the dialog was opened: opened again after a finished
   * import, it starts over; an import still running shows again.
   */
  readonly opened: number;
  /** Replaces the XHR upload (tests). */
  readonly upload?: typeof basePackagesApi.import;
  /** `GET /jobs/:id` polling interval (tests). */
  readonly pollMs?: number;
}

/** The limit of a `413` upload (`errors[0].params.limit`), if the server said it. */
function uploadLimitOf(error: unknown): number | null {
  if (!isApiError(error) || error.status !== 413) return null;
  const limit = error.errors[0]?.params?.['limit'];
  return typeof limit === 'number' ? limit : BASE_PACKAGE_DEFAULT_MAX_BYTES;
}

/**
 * "Import base from a .chbase file" of a workspace (FRONTEND §17.5,
 * CONTRACTS §12.2): pick or drop a package, upload it (`POST
 * /workspaces/:id/bases/import`, progress of the upload), follow the
 * `base.import` job by phase, then the report with the way into the new
 * base, or every problem of a refused package with where it is. Closing
 * while the job runs never stops it: a toast follows it, and the base
 * appears in the workspace when it is done.
 */
export function ImportBaseDialog({
  workspace,
  open,
  onOpenChange,
  opened,
  upload = basePackagesApi.import,
  pollMs,
}: ImportBaseDialogProps) {
  const { t } = useTranslation('workspace');
  const format = useFormatters();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const untrack = useRef<(() => void) | null>(null);
  const [step, setStep] = useState<Step>(PICK);
  const [dragging, setDragging] = useState(false);
  const jobId = step.kind === 'job' ? step.jobId : null;
  const state = useJob(jobId, pollMs);
  const finished = state.job !== undefined;
  const result = importResultOf(state.job);
  const base = useQuery({ ...baseQuery(result?.base_id ?? ''), enabled: result !== undefined });

  // The new base shows in the workspace (page and sidebar) once it exists.
  const succeeded = state.job?.status === 'succeeded';
  useEffect(() => {
    if (succeeded) void queryClient.invalidateQueries({ queryKey: keys.bases(workspace.id) });
  }, [succeeded, queryClient, workspace.id]);

  // Leaving the page cancels an upload; a running job goes on (a toast follows it if closed).
  useEffect(
    () => () => {
      abort.current?.abort();
    },
    [],
  );

  // Opened again: a finished import starts over; one still running shows again.
  const [openedSeen, setOpenedSeen] = useState(opened);
  if (openedSeen !== opened) {
    setOpenedSeen(opened);
    if (finished || step.kind === 'uploading') setStep(PICK);
  }
  // Shown again: the toast that followed the import while it was closed goes.
  useEffect(() => {
    if (!open) return;
    untrack.current?.();
    untrack.current = null;
  }, [open]);

  const choose = (file: File) => {
    setStep({ kind: 'pick', file, problem: checkPackageFile(file), error: null });
  };

  const send = (file: File) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setStep({ kind: 'uploading', file, sent: 0 });
    upload(workspace.id, file, {
      signal: controller.signal,
      onProgress: (sent) => {
        setStep((current) => (current.kind === 'uploading' ? { ...current, sent } : current));
      },
    }).then(
      (accepted) => {
        if (controller.signal.aborted) return;
        setStep({ kind: 'job', file, jobId: accepted.job_id });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setStep({ kind: 'pick', file, problem: null, error });
      },
    );
  };

  const changeOpen = (next: boolean) => {
    if (!next) {
      if (step.kind === 'uploading') {
        abort.current?.abort();
        setStep({ kind: 'pick', file: step.file, problem: null, error: null });
      } else if (step.kind === 'job' && !finished && untrack.current === null) {
        const name = step.file.name;
        untrack.current = trackJob(step.jobId, {
          messages: {
            running: t('import.toast.running', { name }),
            succeeded: t('import.toast.succeeded', { name }),
            failed: t('import.toast.failed', { name }),
          },
        });
      }
    }
    onOpenChange(next);
  };

  const close = (
    <Button
      variant="secondary"
      onClick={() => {
        changeOpen(false);
      }}
    >
      {t('import.close')}
    </Button>
  );

  let body;
  if (step.kind === 'pick') {
    body = (
      <PickStep
        step={step}
        dragging={dragging}
        setDragging={setDragging}
        input={input}
        onChoose={choose}
        onImport={send}
        onCancel={() => {
          changeOpen(false);
        }}
      />
    );
  } else if (result !== undefined) {
    body = (
      <ImportReport
        baseId={result.base_id}
        baseName={base.data?.name ?? step.file.name.replace(/\.chbase$/iu, '')}
        workspaceName={workspace.name}
        report={result.report}
        closeButton={close}
      />
    );
  } else if (state.job !== undefined || (state.error !== null && step.kind === 'job')) {
    const cancelled = state.job?.status === 'cancelled';
    const again = (
      <Button
        onClick={() => {
          setStep(PICK);
        }}
      >
        {t('import.failed.retry')}
      </Button>
    );
    body = cancelled ? (
      <div className="flex flex-col gap-4" data-testid="import-error">
        <Alert variant="danger">
          <p>{t('import.failed.cancelled')}</p>
        </Alert>
        <div className="flex flex-wrap justify-end gap-2">
          {close}
          {again}
        </div>
      </div>
    ) : (
      <ImportProblems
        error={jobErrorOf(state.job) ?? state.error}
        more={moreProblemsOf(state.job)}
        actions={
          <>
            {close}
            {again}
          </>
        }
      />
    );
  } else {
    const uploading = step.kind === 'uploading';
    const progress = uploading
      ? step.sent * UPLOAD_SHARE
      : UPLOAD_SHARE + state.progress * (1 - UPLOAD_SHARE);
    const queued = !uploading && state.status === 'queued';
    // Queued: the upload is done and the check waits for another import of the organization.
    const current = uploading
      ? UPLOAD_PHASE
      : queued
        ? (IMPORT_PHASES[0] ?? null)
        : baseImportPhaseOf(state.progress);
    const phases = [
      { key: UPLOAD_PHASE, label: t('import.phases.upload') },
      ...IMPORT_PHASES.map((key) => ({ key, label: t(`import.phases.${key}`) })),
    ];
    body = (
      <div className="flex flex-col gap-4" data-testid="import-progress">
        <p className="flex min-w-0 items-center gap-2 font-medium">
          <FileArchive aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
          <span className="truncate">{step.file.name}</span>
          <span className="shrink-0 font-normal text-fg-muted">
            {formatBytes(step.file.size, format.locale)}
          </span>
        </p>
        <JobPhases
          phases={phases}
          current={current}
          progress={progress}
          label={t('import.progress')}
          valueText={t('import.percent', { percent: format.number(Math.round(progress * 100)) })}
          stateText={{
            done: t('import.state.done'),
            active: t('import.state.active'),
            failed: t('import.state.failed'),
            pending: t('import.state.pending'),
          }}
        />
        <p className="text-fg-muted" aria-live="polite">
          {uploading ? t('import.uploading') : queued ? t('import.queued') : t('import.running')}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          {uploading ? (
            <Button
              variant="secondary"
              onClick={() => {
                abort.current?.abort();
                setStep({ kind: 'pick', file: step.file, problem: null, error: null });
              }}
            >
              {t('import.cancelUpload')}
            </Button>
          ) : (
            close
          )}
        </div>
      </div>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={changeOpen}
      title={t('import.title')}
      description={t('import.description', { workspace: workspace.name })}
      closeLabel={t('import.close')}
      layout="sheet"
      className="md:max-w-xl"
    >
      {body}
    </Dialog>
  );
}

interface PickStepProps {
  readonly step: Extract<Step, { kind: 'pick' }>;
  readonly dragging: boolean;
  readonly setDragging: (dragging: boolean) => void;
  readonly input: RefObject<HTMLInputElement | null>;
  readonly onChoose: (file: File) => void;
  readonly onImport: (file: File) => void;
  readonly onCancel: () => void;
}

/** Drop or choose a `.chbase` file, see it, then "Import". */
function PickStep({
  step,
  dragging,
  setDragging,
  input,
  onChoose,
  onImport,
  onCancel,
}: PickStepProps) {
  const { t } = useTranslation('workspace');
  const format = useFormatters();
  const { file, problem, error } = step;
  const limit = uploadLimitOf(error);
  const ready = file !== null && problem === null;
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files[0];
    if (dropped !== undefined) onChoose(dropped);
  };
  return (
    <div className="flex flex-col gap-4" data-testid="import-pick">
      <div
        data-testid="import-dropzone"
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => {
          setDragging(false);
        }}
        onDrop={onDrop}
        className={cn(
          'flex flex-col items-center gap-3 rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors duration-(--motion-enter)',
          dragging ? 'border-accent bg-accent-soft' : 'border-line-strong bg-surface-sunken',
        )}
      >
        <PackagePlus
          aria-hidden="true"
          className={cn(
            'size-8 transition-transform duration-(--motion-enter) ease-(--ease-enter)',
            dragging ? 'text-accent motion-safe:-translate-y-0.5' : 'text-fg-muted',
          )}
        />
        <p className="text-body font-medium">{t('import.drop')}</p>
        <input
          ref={input}
          type="file"
          accept=".chbase"
          hidden
          aria-label={t('import.choose')}
          data-testid="import-base-file"
          onChange={(event) => {
            const chosen = event.target.files?.[0];
            event.target.value = '';
            if (chosen !== undefined) onChoose(chosen);
          }}
        />
        <Button
          variant="secondary"
          onClick={() => {
            input.current?.click();
          }}
        >
          {file === null ? t('import.choose') : t('import.change')}
        </Button>
        <p className="text-label font-normal text-fg-muted">
          {t('import.limits', { size: formatBytes(BASE_PACKAGE_DEFAULT_MAX_BYTES, format.locale) })}
        </p>
      </div>
      {file !== null && problem === null ? (
        <p
          className="flex min-w-0 animate-reveal items-center gap-2 rounded-md border border-line px-3 py-2"
          data-testid="import-chosen"
        >
          <FileArchive aria-hidden="true" className="size-4 shrink-0 text-accent" />
          <span className="truncate font-medium">{file.name}</span>
          <span className="shrink-0 text-fg-muted">{formatBytes(file.size, format.locale)}</span>
        </p>
      ) : null}
      {file !== null && problem !== null ? (
        <Alert variant="danger">
          <p>
            {t(`import.problems.${problem}`, {
              name: file.name,
              size: formatBytes(BASE_PACKAGE_DEFAULT_MAX_BYTES, format.locale),
            })}
          </p>
        </Alert>
      ) : null}
      {error === null ? null : limit !== null ? (
        <Alert variant="danger">
          <p>{t('import.tooLarge', { size: formatBytes(limit, format.locale) })}</p>
        </Alert>
      ) : (
        <ErrorAlert error={error} />
      )}
      <p className="flex gap-2 text-fg-muted">
        <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>{t('import.trust')}</span>
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          {t('import.cancel')}
        </Button>
        <Button
          disabled={!ready}
          onClick={() => {
            if (file !== null && ready) onImport(file);
          }}
          data-testid="import-base-start"
        >
          {t('import.start')}
        </Button>
      </div>
    </div>
  );
}

export default ImportBaseDialog;
