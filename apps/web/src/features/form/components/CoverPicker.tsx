import {
  FORM_COVER_MAX_BYTES,
  FORM_COVER_MIME_TYPES,
  formCoverUrl,
  type CreateUploadResponse,
  type FormCoverDto,
} from '@cellhive/contracts';
import { Button } from '@cellhive/ui';
import { ImagePlus, RefreshCw, Trash2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../lib/api/client';
import { mimeOfFile } from '../../../lib/attachments/checks';
import { formatBytes, formatProgress } from '../../../lib/attachments/format';
import { putFile, TransferError } from '../../../lib/attachments/transfer';
import { formsApi } from '../api';

/** How a cover is uploaded (tests replace it). */
export interface CoverUploader {
  readonly start: (
    viewId: string,
    body: { readonly filename: string; readonly size: number; readonly mime: string },
    signal: AbortSignal,
  ) => Promise<CreateUploadResponse>;
  readonly put: (
    target: CreateUploadResponse,
    file: File,
    onProgress: (loaded: number) => void,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly complete: (viewId: string, id: string, signal: AbortSignal) => Promise<FormCoverDto>;
}

const DEFAULT_UPLOADER: CoverUploader = {
  start: (viewId, body, signal) => formsApi.createCoverUpload(viewId, body, signal),
  put: (target, file, onProgress, signal) =>
    putFile(target.upload.url, target.upload.headers, file, {
      signal,
      onProgress: (loaded) => {
        onProgress(loaded);
      },
    }),
  complete: (viewId, id, signal) => formsApi.completeCoverUpload(viewId, id, signal),
};

const COVER_TYPES: readonly string[] = FORM_COVER_MIME_TYPES;

type CoverIssue =
  | 'FILE_TOO_LARGE'
  | 'MIME_NOT_ACCEPTED'
  | 'CONTENT_MISMATCH'
  | 'SIZE_MISMATCH'
  | 'UPLOAD_INCOMPLETE'
  | 'VIEW_LOCKED'
  | 'DENIED'
  | 'NETWORK'
  | 'FAILED';

const SERVER_ISSUES: ReadonlySet<string> = new Set([
  'FILE_TOO_LARGE',
  'MIME_NOT_ACCEPTED',
  'CONTENT_MISMATCH',
  'SIZE_MISMATCH',
  'UPLOAD_INCOMPLETE',
  'VIEW_LOCKED',
]);

/** Why an upload failed, as a key of `builder.cover.issue`; `null` when it was cancelled. */
export function coverIssueOf(error: unknown): CoverIssue | null {
  if (error instanceof TransferError) {
    if (error.failure.kind === 'aborted') return null;
    if (error.failure.kind === 'network') return 'NETWORK';
    return error.failure.status === 413 ? 'FILE_TOO_LARGE' : 'FAILED';
  }
  if (isApiError(error)) {
    if (error.code === 'NETWORK_ERROR') return 'NETWORK';
    if (error.status === 403 || error.status === 404) return 'DENIED';
    const detail = error.errors.find((item) => SERVER_ISSUES.has(item.code));
    return (detail?.code as CoverIssue | undefined) ?? 'FAILED';
  }
  if (error instanceof DOMException && error.name === 'AbortError') return null;
  return 'FAILED';
}

/** The checks the server makes on a new cover, before sending anything. */
export function checkCoverFile(file: {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}): CoverIssue | null {
  if (!COVER_TYPES.includes(mimeOfFile(file))) return 'MIME_NOT_ACCEPTED';
  if (file.size > FORM_COVER_MAX_BYTES || file.size === 0) return 'FILE_TOO_LARGE';
  return null;
}

export interface CoverPickerProps {
  readonly viewId: string;
  /** `config.form.cover_attachment_id` being edited. */
  readonly coverId: string | null;
  /**
   * The user may change the view's config (not locked): the server refuses
   * uploads otherwise, so the picker explains instead of offering them.
   */
  readonly canUpload: boolean;
  readonly disabled?: boolean | undefined;
  readonly onChange: (coverId: string | null) => void;
  readonly uploader?: CoverUploader | undefined;
}

type State =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'uploading';
      readonly name: string;
      readonly size: number;
      readonly loaded: number;
      readonly controller: AbortController;
    }
  | { readonly kind: 'failed'; readonly name: string; readonly issue: CoverIssue };

/**
 * The cover image of a form in the builder (T419, CONTRACTS §15): "Add a
 * cover" (PNG, JPEG, GIF, WebP up to 5 MB) uploads through the view
 * (`POST /views/:id/form-cover/uploads`, `PUT`, `complete`) with its
 * progress and a cancel button, then the form names it (saved with the
 * other builder changes). The image shows with "Change" and "Remove"; a
 * refused file says why under the picker. Without the right to change the
 * view (or a locked view) only the image shows, with the reason.
 */
export function CoverPicker({
  viewId,
  coverId,
  canUpload,
  disabled = false,
  onChange,
  uploader = DEFAULT_UPLOADER,
}: CoverPickerProps) {
  const { t, i18n } = useTranslation('form');
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [broken, setBroken] = useState<string | null>(null);
  const uploading = state.kind === 'uploading';
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  const upload = async (file: File) => {
    const issue = checkCoverFile(file);
    if (issue !== null) {
      setState({ kind: 'failed', name: file.name, issue });
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ kind: 'uploading', name: file.name, size: file.size, loaded: 0, controller });
    try {
      const target = await uploader.start(
        viewId,
        { filename: file.name, size: file.size, mime: mimeOfFile(file) },
        controller.signal,
      );
      await uploader.put(
        target,
        file,
        (loaded) => {
          setState((current) => (current.kind === 'uploading' ? { ...current, loaded } : current));
        },
        controller.signal,
      );
      const cover = await uploader.complete(viewId, target.id, controller.signal);
      setState({ kind: 'idle' });
      setBroken(null);
      onChange(cover.id);
    } catch (error) {
      const failed = coverIssueOf(error);
      setState(
        failed === null ? { kind: 'idle' } : { kind: 'failed', name: file.name, issue: failed },
      );
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  };

  const pick = () => {
    input.current?.click();
  };
  const shown = coverId !== null && broken !== coverId;

  return (
    <div className="flex flex-col gap-2" role="group" aria-labelledby={`${id}-label`}>
      <span id={`${id}-label`} className="text-label text-fg">
        {t('builder.cover.label')}
      </span>
      <input
        ref={input}
        type="file"
        accept={COVER_TYPES.join(',')}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        disabled={!canUpload || disabled || uploading}
        data-testid="form-cover-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file !== undefined) void upload(file);
        }}
      />
      {shown ? (
        <img
          src={formCoverUrl(viewId, coverId)}
          alt={t('builder.cover.alt')}
          className="aspect-[4/1] max-h-40 w-full rounded-md border border-line object-cover"
          data-testid="form-builder-cover"
          onError={() => {
            setBroken(coverId);
          }}
        />
      ) : coverId !== null ? (
        <p className="text-label font-normal text-fg-muted">{t('builder.cover.unavailable')}</p>
      ) : null}
      {uploading ? (
        <div
          className="flex min-h-11 items-center gap-2 rounded-md border border-dashed border-line px-3 text-body"
          data-testid="form-cover-upload"
        >
          <span className="min-w-0 flex-1 truncate">{state.name}</span>
          <span
            role="status"
            className="shrink-0 text-label font-normal text-fg-muted tabular-nums"
          >
            {formatProgress(state.loaded, state.size, i18n.language)}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('builder.cover.cancel', { name: state.name })}
            onClick={() => {
              state.controller.abort();
            }}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      ) : canUpload ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            disabled={disabled}
            aria-describedby={`${id}-hint`}
            onClick={pick}
            data-testid="form-cover-pick"
          >
            {coverId === null ? <ImagePlus aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
            {coverId === null ? t('builder.cover.add') : t('builder.cover.change')}
          </Button>
          {coverId === null ? null : (
            <Button
              variant="ghost"
              disabled={disabled}
              onClick={() => {
                onChange(null);
              }}
            >
              <Trash2 aria-hidden="true" />
              {t('builder.cover.remove')}
            </Button>
          )}
        </div>
      ) : null}
      {state.kind === 'failed' ? (
        <p
          role="alert"
          className="text-label font-normal text-danger"
          data-testid="form-cover-issue"
        >
          {t(`builder.cover.issue.${state.issue}`, {
            name: state.name,
            limit: formatBytes(FORM_COVER_MAX_BYTES, i18n.language),
          })}
        </p>
      ) : null}
      <p id={`${id}-hint`} className="text-label font-normal text-fg-muted">
        {canUpload
          ? t('builder.cover.hint', { limit: formatBytes(FORM_COVER_MAX_BYTES, i18n.language) })
          : t('builder.cover.readOnly')}
      </p>
    </div>
  );
}
