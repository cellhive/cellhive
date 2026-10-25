import { IMPORT_MAX_FILE_BYTES, IMPORT_MAX_ROWS, type ImportUploadDto } from '@cellhive/contracts';
import { Alert, Button, cn } from '@cellhive/ui';
import { FileUp } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../lib/api/client';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../lib/i18n/format';
import { uploadImportFile } from '../api';
import { checkImportFile, IMPORT_ACCEPT, type FileProblem } from '../file';

import { ProgressBar } from './ProgressBar';

export interface UploadStepProps {
  readonly baseId: string;
  readonly onUploaded: (upload: ImportUploadDto) => void;
  /** Replaces the XHR upload (tests). */
  readonly upload?: typeof uploadImportFile;
}

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'invalid'; readonly problem: FileProblem; readonly name: string }
  | { readonly kind: 'uploading'; readonly name: string; readonly sent: number }
  | { readonly kind: 'failed'; readonly error: unknown };

const MB = 1024 * 1024;

/**
 * Step 1: pick or drop a CSV/TSV/XLSX file (checked here for type and size,
 * CONTRACTS §19), then upload it with a progress bar. The answer holds the
 * first preview.
 */
export function UploadStep({ baseId, onUploaded, upload = uploadImportFile }: UploadStepProps) {
  const { t } = useTranslation('import');
  const format = useFormatters();
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [dragging, setDragging] = useState(false);

  // Leaving the step (closing the wizard) cancels the upload.
  useEffect(() => () => abort.current?.abort(), []);

  const send = (file: File) => {
    const problem = checkImportFile(file);
    if (problem !== null) {
      setState({ kind: 'invalid', problem, name: file.name });
      return;
    }
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setState({ kind: 'uploading', name: file.name, sent: 0 });
    upload(baseId, file, {
      signal: controller.signal,
      onProgress: (sent) => {
        setState((current) => (current.kind === 'uploading' ? { ...current, sent } : current));
      },
    }).then(
      (result) => {
        if (controller.signal.aborted) return;
        onUploaded(result);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ kind: 'failed', error });
      },
    );
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (state.kind === 'uploading') return;
    const file = event.dataTransfer.files[0];
    if (file !== undefined) send(file);
  };

  const uploading = state.kind === 'uploading';
  const limits = t('upload.limits', {
    size: format.number(IMPORT_MAX_FILE_BYTES / MB),
    rows: format.number(IMPORT_MAX_ROWS),
  });

  return (
    <div className="flex flex-col gap-3">
      <div
        data-testid="import-dropzone"
        onDragOver={(event) => {
          event.preventDefault();
          if (!uploading) setDragging(true);
        }}
        onDragLeave={() => {
          setDragging(false);
        }}
        onDrop={onDrop}
        className={cn(
          'flex flex-col items-center gap-3 rounded-lg border-2 border-dashed px-6 py-10 text-center',
          dragging ? 'border-accent bg-accent-soft' : 'border-line-strong bg-surface-sunken',
        )}
      >
        <FileUp aria-hidden="true" className="size-8 text-fg-muted" />
        <p className="text-body font-medium">{t('upload.drop')}</p>
        <p className="text-label font-normal text-fg-muted">{limits}</p>
        <input
          ref={input}
          type="file"
          accept={IMPORT_ACCEPT}
          hidden
          aria-label={t('upload.choose')}
          data-testid="import-file-input"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file !== undefined) send(file);
          }}
        />
        <Button
          variant="secondary"
          disabled={uploading}
          onClick={() => {
            input.current?.click();
          }}
        >
          {t('upload.choose')}
        </Button>
      </div>
      {state.kind === 'uploading' ? (
        <div className="flex flex-col gap-2" aria-live="polite">
          <p className="text-body">{t('upload.uploading', { name: state.name })}</p>
          <ProgressBar
            value={state.sent}
            label={t('upload.progress', { name: state.name })}
            valueText={t('percent', { percent: format.number(Math.round(state.sent * 100)) })}
          />
          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                abort.current?.abort();
                setState({ kind: 'idle' });
              }}
            >
              {t('upload.cancel')}
            </Button>
          </div>
        </div>
      ) : null}
      {state.kind === 'invalid' ? (
        <Alert variant="danger">
          <p>
            {t(`upload.problems.${state.problem}`, {
              name: state.name,
              size: format.number(IMPORT_MAX_FILE_BYTES / MB),
            })}
          </p>
        </Alert>
      ) : null}
      {state.kind === 'failed' ? (
        isApiError(state.error) && state.error.status === 413 ? (
          <Alert variant="danger">
            <p>
              {t('upload.problems.tooLarge', { size: format.number(IMPORT_MAX_FILE_BYTES / MB) })}
            </p>
          </Alert>
        ) : (
          <ErrorAlert error={state.error} />
        )
      ) : null}
    </div>
  );
}
