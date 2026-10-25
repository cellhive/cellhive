import { DEFAULT_ATTACHMENT_MAX_FILE_BYTES } from '@cellhive/contracts';
import { fileExtensionOf } from '@cellhive/field-types';
import { Button } from '@cellhive/ui';
import { Paperclip, RotateCw, X } from 'lucide-react';
import { useId, useMemo, useRef, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { acceptLabels, inputAccept } from '../../../lib/attachments/checks';
import { formatBytes, formatProgress } from '../../../lib/attachments/format';
import { itemsOf, type InputItem, type InputValue } from '../model/values';

import type { ControlProps } from './QuestionInput';
import type { UploadItem, UploadStore, UploadTarget } from '../../../lib/attachments/uploads';
import type { CellFile } from '../../../lib/attachments/value';
import type { AttachmentOptions } from '@cellhive/field-types';

export interface FileQuestionProps {
  readonly target: UploadTarget;
  readonly options: AttachmentOptions;
  readonly value: InputValue;
  /** Changes the value from the one it holds when the change lands (uploads finish later). */
  readonly update: (change: (current: InputValue) => InputValue) => void;
  readonly control: ControlProps;
  readonly labelId: string;
  /** `null`: files cannot be added here (preview). */
  readonly store: UploadStore | null;
  /** Most bytes of all the files of one submission (form links: 100 MB, CONTRACTS §17). */
  readonly maxTotalBytes?: number | undefined;
}

const NO_ITEMS: readonly UploadItem[] = [];

/**
 * The input of a file question (T410): "Add files", the files already
 * uploaded (removable), and the uploads on their way with their progress
 * or why they stopped. Uploads go through the form's `UploadStore` (T418
 * flow: checks, presigned `PUT`, `complete`); a finished file joins the
 * question's value. On a form link, the files are bound to the submit token
 * the form is sent with (CONTRACTS §17). The line under the button says
 * what the question takes (types, how many files, size per file and, on a
 * link, for all files); a refused upload says why with the limit that
 * applies (T419: including the link's total size and an expired session).
 */
export function FileQuestion({
  target,
  options,
  value,
  update,
  control,
  labelId,
  store,
  maxTotalBytes,
}: FileQuestionProps) {
  const { t, i18n } = useTranslation('form');
  const language = i18n.language;
  const helperId = useId();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const files = itemsOf(value);
  const items = useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    () => store?.items(target) ?? NO_ITEMS,
  );
  const host = useMemo(
    () => ({
      attach: (file: CellFile) => {
        update((current) => [
          ...itemsOf(current),
          { id: file.id, name: file.name, size: file.size } satisfies InputItem,
        ]);
      },
    }),
    [update],
  );
  const accept = inputAccept(options.accept);
  const types =
    options.accept === null || options.accept.length === 0
      ? null
      : acceptLabels(options.accept)
          .map((label) =>
            'name' in label
              ? label.name
              : t(`fill.files.families.${label.family}`, { defaultValue: `${label.family}/*` }),
          )
          .join(', ');
  const helper = [
    ...(types === null ? [] : [types]),
    t('fill.files.limit', { count: options.max_files }),
    t('fill.files.perFile', {
      size: formatBytes(DEFAULT_ATTACHMENT_MAX_FILE_BYTES, language),
    }),
    ...(maxTotalBytes === undefined
      ? []
      : [t('fill.files.total', { size: formatBytes(maxTotalBytes, language) })]),
  ].join(' · ');
  const issueText = (item: UploadItem): string => {
    const issue = item.issue;
    const limit = issue?.params?.['limit'];
    switch (issue?.code) {
      case 'FILE_TOO_LARGE':
      case 'UPLOAD_LIMIT_EXCEEDED':
        return t(`fill.files.issue.${issue.code}`, {
          limit: formatBytes(
            typeof limit === 'number'
              ? limit
              : issue.code === 'FILE_TOO_LARGE'
                ? DEFAULT_ATTACHMENT_MAX_FILE_BYTES
                : (maxTotalBytes ?? 0),
            language,
          ),
        });
      case 'MIME_NOT_ACCEPTED':
        return types === null
          ? t('fill.files.issue.MIME_NOT_ACCEPTED_any')
          : t('fill.files.issue.MIME_NOT_ACCEPTED', { types });
      case 'BLOCKED_FILE_TYPE': {
        const extension = issue.params?.['extension'];
        return t('fill.files.issue.BLOCKED_FILE_TYPE', {
          extension:
            typeof extension === 'string' && extension !== ''
              ? extension
              : fileExtensionOf(item.name),
        });
      }
      case 'TOO_MANY_VALUES': {
        const count = typeof limit === 'number' ? limit : options.max_files;
        return t('fill.files.issue.TOO_MANY_VALUES', { count });
      }
      case undefined:
        return t('fill.files.issue.FAILED');
      default:
        return t(`fill.files.issue.${issue?.code ?? 'FAILED'}`, {
          defaultValue: t('fill.files.issue.FAILED'),
        });
    }
  };
  const full = files.length + items.filter((item) => item.status !== 'failed').length;

  return (
    <div
      id={control.id}
      role="group"
      aria-labelledby={labelId}
      aria-describedby={[control.describedBy, helperId].filter(Boolean).join(' ') || undefined}
      data-testid="form-file-question"
      className="flex flex-col gap-2"
    >
      {files.length === 0 && items.length === 0 ? null : (
        <ul className="flex flex-col gap-1" aria-label={t('fill.files.list')}>
          {files.map((file) => (
            <li
              key={file.id}
              data-testid="form-file"
              className="flex min-h-9 items-center gap-2 rounded-md border border-line px-2 text-body"
            >
              <Paperclip aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
              <span className="min-w-0 flex-1 truncate">{file.name}</span>
              {file.size === undefined ? null : (
                <span className="shrink-0 text-label font-normal text-fg-muted tabular-nums">
                  {formatBytes(file.size, i18n.language)}
                </span>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="size-8 sm:size-7"
                disabled={control.disabled}
                aria-label={t('fill.files.remove', { name: file.name })}
                onClick={() => {
                  update((current) => itemsOf(current).filter((entry) => entry.id !== file.id));
                }}
              >
                <X aria-hidden="true" />
              </Button>
            </li>
          ))}
          {items.map((item) => (
            <li
              key={item.key}
              data-testid="form-upload"
              data-status={item.status}
              className="flex min-h-9 flex-wrap items-center gap-x-2 rounded-md border border-dashed border-line px-2 py-1 text-body"
            >
              <Paperclip aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              {item.status === 'failed' ? (
                <span
                  role="alert"
                  className="basis-full text-label font-normal text-danger"
                  data-testid="form-upload-issue"
                >
                  {issueText(item)}
                </span>
              ) : (
                <span
                  role="status"
                  className="shrink-0 text-label font-normal text-fg-muted tabular-nums"
                >
                  {item.status === 'queued'
                    ? t('fill.files.queued')
                    : formatProgress(item.loaded, item.size, i18n.language)}
                </span>
              )}
              {item.status === 'failed' && item.retryable ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 sm:size-7"
                  aria-label={t('fill.files.retry', { name: item.name })}
                  onClick={() => {
                    store?.retry(target, item.key);
                  }}
                >
                  <RotateCw aria-hidden="true" />
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                className="size-8 sm:size-7"
                aria-label={t(
                  item.status === 'failed' ? 'fill.files.dismiss' : 'fill.files.cancel',
                  {
                    name: item.name,
                  },
                )}
                onClick={() => {
                  store?.cancel(target, item.key);
                }}
              >
                <X aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          multiple={options.max_files > 1}
          {...(accept === undefined ? {} : { accept })}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          disabled={store === null || control.disabled}
          onChange={(event) => {
            const picked = [...(event.target.files ?? [])];
            event.target.value = '';
            if (store !== null && picked.length > 0) {
              store.add(target, picked, options, files.length, host);
            }
          }}
        />
        <Button
          variant="secondary"
          disabled={store === null || control.disabled || full >= options.max_files}
          aria-invalid={control.invalid}
          onClick={() => {
            inputRef.current?.click();
          }}
        >
          <Paperclip aria-hidden="true" />
          {t('fill.files.add')}
        </Button>
        <span id={helperId} className="text-label font-normal text-fg-muted">
          {store === null ? t('fill.files.previewOnly') : helper}
        </span>
      </div>
    </div>
  );
}

function noSubscribe(): () => void {
  return () => undefined;
}
