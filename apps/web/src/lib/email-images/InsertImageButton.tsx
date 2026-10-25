import {
  EMAIL_IMAGE_MAX_UPLOAD_BYTES,
  EMAIL_IMAGE_MIME_TYPES,
  type CreateUploadResponse,
  type EmailAssetDto,
} from '@cellhive/contracts';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
} from '@cellhive/ui';
import { ImagePlus, Paperclip, Upload } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../api/client';
import { mimeOfFile } from '../attachments/checks';
import { putFile, TransferError } from '../attachments/transfer';

import { emailImagesApi, type EmailImageTarget } from './api';

/** How an image is uploaded (tests replace it). */
export interface EmailImageUploader {
  readonly start: (
    target: EmailImageTarget,
    body: { readonly filename: string; readonly size: number; readonly mime: string },
    signal: AbortSignal,
  ) => Promise<CreateUploadResponse>;
  readonly put: (target: CreateUploadResponse, file: File, signal: AbortSignal) => Promise<void>;
  readonly complete: (
    target: EmailImageTarget,
    id: string,
    signal: AbortSignal,
  ) => Promise<EmailAssetDto>;
}

const DEFAULT_UPLOADER: EmailImageUploader = {
  start: (target, body, signal) => emailImagesApi.start(target, body, signal),
  put: (target, file, signal) =>
    putFile(target.upload.url, target.upload.headers, file, { signal }),
  complete: (target, id, signal) => emailImagesApi.complete(target, id, signal),
};

const IMAGE_TYPES: readonly string[] = EMAIL_IMAGE_MIME_TYPES;

/** Why an image was not inserted, as a key of `issue`. */
export type EmailImageIssue =
  | 'MIME_NOT_ACCEPTED'
  | 'FILE_TOO_LARGE'
  | 'IMAGE_UNREADABLE'
  | 'CONTENT_MISMATCH'
  | 'DENIED'
  | 'NETWORK'
  | 'FAILED';

const SERVER_ISSUES: ReadonlySet<string> = new Set([
  'MIME_NOT_ACCEPTED',
  'FILE_TOO_LARGE',
  'IMAGE_UNREADABLE',
  'CONTENT_MISMATCH',
]);

/** The checks the server makes before anything is sent: raster type, size. */
export function checkEmailImageFile(file: {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}): EmailImageIssue | null {
  if (!IMAGE_TYPES.includes(mimeOfFile(file))) return 'MIME_NOT_ACCEPTED';
  if (file.size === 0 || file.size > EMAIL_IMAGE_MAX_UPLOAD_BYTES) return 'FILE_TOO_LARGE';
  return null;
}

/** Why an upload failed; `null` when it was cancelled. */
export function emailImageIssueOf(error: unknown): EmailImageIssue | null {
  if (error instanceof TransferError) {
    if (error.failure.kind === 'aborted') return null;
    if (error.failure.kind === 'network') return 'NETWORK';
    return error.failure.status === 413 ? 'FILE_TOO_LARGE' : 'FAILED';
  }
  if (isApiError(error)) {
    if (error.code === 'NETWORK_ERROR') return 'NETWORK';
    if (error.status === 403 || error.status === 404) return 'DENIED';
    const detail = error.errors.find((item) => SERVER_ISSUES.has(item.code));
    return (detail?.code as EmailImageIssue | undefined) ?? 'FAILED';
  }
  if (error instanceof DOMException && error.name === 'AbortError') return null;
  return 'FAILED';
}

/** An attachment field whose images an email body may show (`![alt](field:fld_…)`). */
export interface EmailImageField {
  readonly id: string;
  readonly name: string;
}

export interface InsertImageButtonProps {
  readonly target: EmailImageTarget;
  /** The uploaded image, ready to insert (`asset.markdown`). */
  readonly onInsert: (asset: EmailAssetDto) => void;
  /**
   * Attachment fields of the trigger record (email bodies only, T522): the
   * button opens a menu "Upload an image" / "Images of field …".
   */
  readonly fields?: readonly EmailImageField[] | undefined;
  readonly onInsertField?: ((field: EmailImageField) => void) | undefined;
  /** Why no image may be added now (e.g. the maximum is reached); disables the button. */
  readonly disabledReason?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly uploader?: EmailImageUploader | undefined;
  /** Tab order of the button inside a toolbar with a roving tab stop (T522). */
  readonly tabIndex?: number | undefined;
  /** `data-tool` of the button: its key in such a toolbar. */
  readonly toolId?: string | undefined;
}

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'uploading'; readonly name: string }
  | { readonly kind: 'failed'; readonly issue: EmailImageIssue }
  | { readonly kind: 'done'; readonly name: string };

/**
 * "Insert image" of the email editors (BACKLOG T534; signature editors of
 * T526/T533, body editor of T522): picks a PNG, JPEG, GIF or WebP image,
 * uploads it to the organization (signatures) or the automation (body), and
 * hands back the processed image to insert as `![alt](asset:att_…)`. Never
 * a URL: emails embed it as an inline `cid:` part. With `fields`, the menu
 * also offers the images of an attachment field of the trigger record.
 * Progress and failures are announced in a live region.
 */
export function InsertImageButton({
  target,
  onInsert,
  fields,
  onInsertField,
  disabledReason,
  disabled = false,
  uploader = DEFAULT_UPLOADER,
  tabIndex,
  toolId,
}: InsertImageButtonProps) {
  const { t } = useTranslation('emailImages');
  const input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const [state, setState] = useState<State>({ kind: 'idle' });
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );
  const uploading = state.kind === 'uploading';
  const off = disabled || uploading || disabledReason !== undefined;

  const upload = async (file: File) => {
    const issue = checkEmailImageFile(file);
    if (issue !== null) {
      setState({ kind: 'failed', issue });
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    setState({ kind: 'uploading', name: file.name });
    try {
      const started = await uploader.start(
        target,
        { filename: file.name, size: file.size, mime: mimeOfFile(file) },
        abort.signal,
      );
      await uploader.put(started, file, abort.signal);
      const asset = await uploader.complete(target, started.id, abort.signal);
      setState({ kind: 'done', name: file.name });
      onInsert(asset);
    } catch (error) {
      const failed = emailImageIssueOf(error);
      setState(failed === null ? { kind: 'idle' } : { kind: 'failed', issue: failed });
    } finally {
      if (controller.current === abort) controller.current = null;
    }
  };

  const pick = () => {
    input.current?.click();
  };
  const label = t('insert');
  // A disabled button gets no hover or focus, so a tooltip could never tell
  // why it is off: the reason is visible text next to it (T527).
  const reasonId = useId();
  const describedBy = disabledReason === undefined ? undefined : reasonId;
  const icon = <ImagePlus aria-hidden="true" />;
  const withFields = fields !== undefined && fields.length > 0 && onInsertField !== undefined;

  return (
    <>
      <input
        ref={input}
        type="file"
        accept={IMAGE_TYPES.join(',')}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        disabled={off}
        data-testid="email-image-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file !== undefined) void upload(file);
        }}
      />
      {withFields ? (
        <DropdownMenu modal={false}>
          <Tooltip content={label}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="toolbar"
                aria-label={label}
                aria-disabled={off}
                aria-describedby={describedBy}
                disabled={off}
                tabIndex={tabIndex}
                data-tool={toolId}
                data-testid="email-image-insert"
              >
                {icon}
              </Button>
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={pick}>
              <Upload aria-hidden="true" />
              {t('upload')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t('fields')}</DropdownMenuLabel>
            {fields.map((field) => (
              <DropdownMenuItem
                key={field.id}
                onSelect={() => {
                  onInsertField(field);
                }}
              >
                <Paperclip aria-hidden="true" />
                {field.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Tooltip content={label}>
          <Button
            variant="ghost"
            size="toolbar"
            aria-label={label}
            aria-describedby={describedBy}
            disabled={off}
            tabIndex={tabIndex}
            data-tool={toolId}
            data-testid="email-image-insert"
            onMouseDown={(event) => {
              // Keep the selection of the text area.
              event.preventDefault();
            }}
            onClick={pick}
          >
            {icon}
          </Button>
        </Tooltip>
      )}
      {disabledReason === undefined ? null : (
        <span
          id={reasonId}
          className="px-1 text-label font-normal text-fg-muted"
          data-testid="email-image-disabled-reason"
        >
          {disabledReason}
        </span>
      )}
      <span role="status" aria-live="polite" className="sr-only" data-testid="email-image-status">
        {state.kind === 'uploading'
          ? t('uploading', { name: state.name })
          : state.kind === 'done'
            ? t('inserted', { name: state.name })
            : ''}
      </span>
      {state.kind === 'failed' ? (
        <span
          role="alert"
          className="px-1 text-label font-normal text-danger"
          data-testid="email-image-error"
        >
          {t(`issue.${state.issue}`)}
        </span>
      ) : null}
    </>
  );
}
