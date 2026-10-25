import { isApiError } from '../api/client';

import { attachmentsApi } from './api';
import { checkFiles, type UploadCheckIssue } from './checks';
import { isPreviewImage } from './kinds';
import { localPreviews, type LocalPreviews } from './previews';
import { putFile, TransferError, type XhrFactory } from './transfer';
import { cellFileOf, type CellFile } from './value';

import type { CreateUploadRequest } from '@cellhive/contracts';
import type { AttachmentOptions } from '@cellhive/field-types';

/**
 * Uploads of attachment cells (T418, CONTRACTS §20): each file is checked,
 * then presigned, sent to storage with progress (cancellable), completed,
 * and written into its cell by the screen that started it (`host.attach`,
 * the edit flow of FRONTEND §4.1: optimistic, one undo step per file). At
 * most {@link MAX_PARALLEL_UPLOADS} files travel at once; the others wait.
 * The store outlives the popover or panel that started an upload: closing
 * them does not stop it, and reopening shows its progress again.
 */

/** Files sent at the same time (BACKLOG T418: "parallel, bounded"). */
export const MAX_PARALLEL_UPLOADS = 3;

/** A cell: uploads are listed per cell. */
export interface UploadTarget {
  readonly tableId: string;
  readonly recordId: string;
  readonly fieldId: string;
}

/** Writes a finished upload into its cell (appended after the files it holds now). */
export interface UploadHost {
  readonly attach: (file: CellFile) => void;
}

/**
 * Why an upload stopped: a detail code of CONTRACTS §6 (the client's own
 * checks and the server's), or `NETWORK` (connection lost: `loaded` bytes
 * had gone), `DENIED` (no longer allowed to write the field), `RATE_LIMITED`,
 * `FAILED` (anything else).
 */
export interface UploadIssue {
  readonly code:
    | UploadCheckIssue['code']
    | 'SIZE_MISMATCH'
    | 'CONTENT_MISMATCH'
    | 'UPLOAD_INCOMPLETE'
    | 'INVALID_FORMAT'
    /** Form links (CONTRACTS §17, T410): the files of one submission together are too large. */
    | 'UPLOAD_LIMIT_EXCEEDED'
    /** Form links: the submit token the files are bound to expired or was used (T410). */
    | 'SUBMIT_TOKEN_INVALID'
    | 'NETWORK'
    | 'DENIED'
    | 'RATE_LIMITED'
    | 'FAILED';
  readonly params?: Readonly<Record<string, unknown>>;
}

export type UploadStatus = 'queued' | 'uploading' | 'completing' | 'failed';

export interface UploadItem {
  /** Stable key (React lists, cancel / retry). */
  readonly key: string;
  readonly name: string;
  readonly size: number;
  readonly mime: string;
  readonly status: UploadStatus;
  /** Bytes sent so far. */
  readonly loaded: number;
  readonly issue: UploadIssue | null;
  /** "Retry" starts again from the presign (connection lost, expired URL…); else only dismiss. */
  readonly retryable: boolean;
  /** A local preview of an image (`blob:` URL, revoked when the item goes). */
  readonly preview: string | null;
}

interface Entry {
  item: UploadItem;
  readonly file: File;
  readonly target: UploadTarget;
  readonly host: UploadHost;
  controller: AbortController | null;
}

const RETRYABLE_SERVER = new Set(['UPLOAD_INCOMPLETE', 'SIZE_MISMATCH']);
const SERVER_DETAILS = new Set([
  'FILE_TOO_LARGE',
  'MIME_NOT_ACCEPTED',
  'BLOCKED_FILE_TYPE',
  'SIZE_MISMATCH',
  'CONTENT_MISMATCH',
  'UPLOAD_INCOMPLETE',
  'INVALID_FORMAT',
  'TOO_MANY_VALUES',
  'UPLOAD_LIMIT_EXCEEDED',
  'SUBMIT_TOKEN_INVALID',
]);

/** A failed step as an issue, and whether trying again may work. */
export function issueOfError(
  error: unknown,
  loaded: number,
  size: number,
): { issue: UploadIssue; retryable: boolean } {
  if (error instanceof TransferError) {
    const failure = error.failure;
    if (failure.kind === 'network') {
      return { issue: { code: 'NETWORK', params: { loaded, size } }, retryable: true };
    }
    if (failure.kind === 'status' && failure.status === 413) {
      return { issue: { code: 'FILE_TOO_LARGE' }, retryable: false };
    }
    // An expired or refused signature: a new presign may pass.
    return { issue: { code: 'FAILED' }, retryable: true };
  }
  if (isApiError(error)) {
    if (error.code === 'NETWORK_ERROR') {
      return { issue: { code: 'NETWORK', params: { loaded, size } }, retryable: true };
    }
    if (error.status === 403 || error.status === 404) {
      return { issue: { code: 'DENIED' }, retryable: false };
    }
    if (error.status === 429) return { issue: { code: 'RATE_LIMITED' }, retryable: true };
    const detail = error.errors.find((item) => SERVER_DETAILS.has(item.code));
    if (detail !== undefined) {
      return {
        issue: {
          code: detail.code as UploadIssue['code'],
          ...(detail.params === undefined ? {} : { params: detail.params }),
        },
        retryable: RETRYABLE_SERVER.has(detail.code),
      };
    }
  }
  return { issue: { code: 'FAILED' }, retryable: true };
}

export function uploadCellKey(target: UploadTarget): string {
  return `${target.tableId}:${target.recordId}:${target.fieldId}`;
}

const NO_ITEMS: readonly UploadItem[] = [];

export interface UploadStoreOptions {
  readonly api?: Pick<typeof attachmentsApi, 'createUpload' | 'complete'>;
  readonly xhr?: XhrFactory;
  readonly parallel?: number;
  /** `URL.createObjectURL` (absent in jsdom). */
  readonly previewOf?: ((file: File) => string | null) | undefined;
  /** Where the preview of a finished upload goes (T421b): the tab's local previews. */
  readonly previews?: LocalPreviews | undefined;
}

function defaultPreview(file: File): string | null {
  if (typeof URL.createObjectURL !== 'function' || !isPreviewImage(file.type)) return null;
  return URL.createObjectURL(file);
}

export class UploadStore {
  readonly #api: Pick<typeof attachmentsApi, 'createUpload' | 'complete'>;
  readonly #xhr: XhrFactory | undefined;
  readonly #parallel: number;
  readonly #previewOf: (file: File) => string | null;
  readonly #previews: LocalPreviews;
  /** Entries per cell, in the order they were added. */
  readonly #cells = new Map<string, Entry[]>();
  /** Snapshots per cell (stable arrays for `useSyncExternalStore`). */
  readonly #snapshots = new Map<string, readonly UploadItem[]>();
  readonly #listeners = new Set<() => void>();
  #queue: Entry[] = [];
  #running = 0;
  #sequence = 0;

  constructor(options: UploadStoreOptions = {}) {
    this.#api = options.api ?? attachmentsApi;
    this.#xhr = options.xhr;
    this.#parallel = options.parallel ?? MAX_PARALLEL_UPLOADS;
    this.#previewOf = options.previewOf ?? defaultPreview;
    this.#previews = options.previews ?? localPreviews;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Uploads of a cell, finished ones gone (they are files of the cell now). */
  items(target: UploadTarget): readonly UploadItem[] {
    return this.#snapshots.get(uploadCellKey(target)) ?? NO_ITEMS;
  }

  /** Uploads of the cell still counting against `max_files` (not failed). */
  active(target: UploadTarget): number {
    return this.items(target).filter((item) => item.status !== 'failed').length;
  }

  /**
   * Adds files to a cell: each is checked against the field (the files
   * the cell holds and the uploads on their way count against
   * `max_files`); those that fail stay listed with their reason, the others
   * are queued.
   */
  add(
    target: UploadTarget,
    files: readonly File[],
    options: AttachmentOptions,
    cellCount: number,
    host: UploadHost,
  ): void {
    if (files.length === 0) return;
    const key = uploadCellKey(target);
    const checked = checkFiles(files, options, { used: cellCount + this.active(target) });
    const entries = this.#cells.get(key) ?? [];
    for (const { file, mime, issue } of checked) {
      this.#sequence += 1;
      const entry: Entry = {
        file,
        target,
        host,
        controller: null,
        item: {
          key: `upload-${String(this.#sequence)}`,
          name: file.name,
          size: file.size,
          mime,
          status: issue === null ? 'queued' : 'failed',
          loaded: 0,
          issue,
          retryable: false,
          preview: issue === null ? this.#previewOf(file) : null,
        },
      };
      entries.push(entry);
      if (issue === null) this.#queue.push(entry);
    }
    this.#cells.set(key, entries);
    this.#publish(key);
    this.#pump();
  }

  /** Stops an upload (nothing is attached); a failed one is dismissed. */
  cancel(target: UploadTarget, itemKey: string): void {
    const entry = this.#find(target, itemKey);
    if (entry === undefined) return;
    entry.controller?.abort();
    this.#queue = this.#queue.filter((queued) => queued !== entry);
    this.#remove(entry);
  }

  /** Starts a failed upload again from the presign. */
  retry(target: UploadTarget, itemKey: string): void {
    const entry = this.#find(target, itemKey);
    if (entry?.item.status !== 'failed' || !entry.item.retryable) return;
    this.#update(entry, { status: 'queued', loaded: 0, issue: null, retryable: false });
    this.#queue.push(entry);
    this.#pump();
  }

  #find(target: UploadTarget, itemKey: string): Entry | undefined {
    return this.#cells.get(uploadCellKey(target))?.find((entry) => entry.item.key === itemKey);
  }

  #publish(key: string): void {
    const entries = this.#cells.get(key) ?? [];
    if (entries.length === 0) {
      this.#cells.delete(key);
      this.#snapshots.delete(key);
    } else {
      this.#snapshots.set(
        key,
        entries.map((entry) => entry.item),
      );
    }
    for (const listener of this.#listeners) listener();
  }

  #update(entry: Entry, patch: Partial<UploadItem>): void {
    entry.item = { ...entry.item, ...patch };
    this.#publish(uploadCellKey(entry.target));
  }

  /** Drops an entry; its preview is revoked unless it was handed over (`keepPreview`). */
  #remove(entry: Entry, keepPreview = false): void {
    const key = uploadCellKey(entry.target);
    const entries = this.#cells.get(key);
    if (entries === undefined) return;
    const index = entries.indexOf(entry);
    if (index === -1) return;
    entries.splice(index, 1);
    if (!keepPreview && entry.item.preview !== null && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(entry.item.preview);
    }
    this.#publish(key);
  }

  #pump(): void {
    while (this.#running < this.#parallel && this.#queue.length > 0) {
      const entry = this.#queue.shift();
      if (entry === undefined) break;
      this.#running += 1;
      void this.#run(entry).finally(() => {
        this.#running -= 1;
        this.#pump();
      });
    }
  }

  async #run(entry: Entry): Promise<void> {
    const controller = new AbortController();
    entry.controller = controller;
    const { target, file } = entry;
    this.#update(entry, { status: 'uploading', loaded: 0 });
    try {
      const created = await this.#api.createUpload(
        {
          table_id: target.tableId as CreateUploadRequest['table_id'],
          field_id: target.fieldId as CreateUploadRequest['field_id'],
          filename: file.name,
          size: file.size,
          mime: entry.item.mime,
        },
        controller.signal,
      );
      await putFile(
        created.upload.url,
        created.upload.headers,
        file,
        {
          signal: controller.signal,
          onProgress: (loaded) => {
            if (!controller.signal.aborted) this.#update(entry, { loaded });
          },
        },
        this.#xhr,
      );
      this.#update(entry, { status: 'completing', loaded: file.size });
      const completed = await this.#api.complete(created.id, controller.signal);
      if (controller.signal.aborted) return;
      const cellFile = cellFileOf(completed);
      // The local copy keeps showing the image (T421b): the cell write and the
      // thumbnail job are still on their way.
      const preview = entry.item.preview;
      if (cellFile !== null && preview !== null) this.#previews.remember(cellFile.id, preview);
      this.#remove(entry, cellFile !== null && preview !== null);
      if (cellFile !== null) entry.host.attach(cellFile);
    } catch (error) {
      if (controller.signal.aborted) return;
      const { issue, retryable } = issueOfError(error, entry.item.loaded, file.size);
      this.#update(entry, { status: 'failed', issue, retryable });
    } finally {
      entry.controller = null;
    }
  }
}

/** The uploads of this tab. */
export const uploads = new UploadStore();
