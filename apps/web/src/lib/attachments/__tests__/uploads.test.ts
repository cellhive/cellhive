import { attachmentOptionsSchema } from '@cellhive/field-types';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import { TransferError } from '../transfer';
import { issueOfError, UploadStore, type UploadHost } from '../uploads';

import type { CellFile } from '../value';

/** A fake `XMLHttpRequest` the test drives: progress, load, error, abort. */
class FakeXhr {
  static all: FakeXhr[] = [];
  status = 0;
  readonly upload = new EventTarget();
  readonly events = new EventTarget();
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown = null;
  aborted = false;

  constructor() {
    FakeXhr.all.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  addEventListener(type: string, listener: EventListener) {
    this.events.addEventListener(type, listener);
  }

  send(body: unknown) {
    this.body = body;
  }

  abort() {
    this.aborted = true;
    this.events.dispatchEvent(new Event('abort'));
  }

  progress(loaded: number, total: number) {
    const event = new Event('progress') as ProgressEvent;
    Object.assign(event, { lengthComputable: true, loaded, total });
    this.upload.dispatchEvent(event);
  }

  finish(status = 200) {
    this.status = status;
    this.events.dispatchEvent(new Event('load'));
  }

  fail() {
    this.events.dispatchEvent(new Event('error'));
  }
}

const TABLE = 'tbl_Products00000001';
const FIELD = 'fld_Photos0000000001';
const RECORD = 'rec_Printer000000001';
const target = { tableId: TABLE, recordId: RECORD, fieldId: FIELD };
const options = attachmentOptionsSchema.parse({ accept: ['image/*'], max_files: 3 });

function png(name: string, size = 3000): File {
  return new File([new Uint8Array(size)], name, { type: 'image/png' });
}

function attachment(id: string, name: string, size: number) {
  return {
    id,
    name,
    size,
    mime: 'image/png',
    url: `/api/v1/files/${id}`,
    thumbnail_url: null,
  };
}

async function settle() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function setup(parallel = 3) {
  FakeXhr.all = [];
  let sequence = 0;
  const api = {
    createUpload: vi.fn((body: { filename: string; size: number; mime: string }) => {
      sequence += 1;
      const id = `att_Upload${String(sequence).padStart(10, '0')}`;
      return Promise.resolve({
        id: id as `att_${string}`,
        upload: {
          method: 'PUT' as const,
          url: `https://files.example.test/${id}?sig=x`,
          headers: { 'content-type': body.mime },
          expires_at: '2026-09-25T03:25:00.000Z',
        },
      });
    }),
    complete: vi.fn((id: string) => Promise.resolve(attachment(id, `${id}.png`, 3000))),
  };
  const store = new UploadStore({
    api: api as never,
    xhr: () => new FakeXhr() as unknown as XMLHttpRequest,
    parallel,
    previewOf: () => null,
  });
  const attached: CellFile[] = [];
  const host: UploadHost = {
    attach: (file) => {
      attached.push(file);
    },
  };
  return { store, api, attached, host };
}

describe('upload store (T418, CONTRACTS §20)', () => {
  it('presigns, sends with progress, completes, then attaches the file to the cell', async () => {
    const { store, api, attached, host } = setup();
    store.add(target, [png('mat-truoc.png', 3000)], options, 0, host);
    await settle();
    expect(api.createUpload).toHaveBeenCalledWith(
      {
        table_id: TABLE,
        field_id: FIELD,
        filename: 'mat-truoc.png',
        size: 3000,
        mime: 'image/png',
      },
      expect.any(AbortSignal),
    );
    const xhr = FakeXhr.all[0];
    expect(xhr?.method).toBe('PUT');
    expect(xhr?.headers).toEqual({ 'content-type': 'image/png' });
    xhr?.progress(1200, 3000);
    expect(store.items(target)[0]).toMatchObject({ status: 'uploading', loaded: 1200 });
    xhr?.finish(200);
    await settle();
    expect(api.complete).toHaveBeenCalledWith('att_Upload0000000001', expect.any(AbortSignal));
    expect(attached.map((file) => file.id)).toEqual(['att_Upload0000000001']);
    // Done: the file is part of the cell now, no longer an upload.
    expect(store.items(target)).toEqual([]);
  });

  it('refuses before uploading: type, and max_files counting the cell and the uploads', async () => {
    const { store, api, host } = setup();
    store.add(
      target,
      [
        png('a.png'),
        new File(['x'], 'setup.exe', { type: 'application/x-msdownload' }),
        png('b.png'),
      ],
      options,
      2,
      host,
    );
    await settle();
    expect(store.items(target).map((item) => [item.name, item.status, item.issue?.code])).toEqual([
      ['a.png', 'uploading', undefined],
      ['setup.exe', 'failed', 'BLOCKED_FILE_TYPE'],
      ['b.png', 'failed', 'TOO_MANY_VALUES'],
    ]);
    expect(api.createUpload).toHaveBeenCalledTimes(1);
  });

  it('sends at most `parallel` files at once; the others wait in order', async () => {
    const { store, api, host } = setup(2);
    const many = attachmentOptionsSchema.parse({ max_files: 10 });
    store.add(target, [png('1.png'), png('2.png'), png('3.png')], many, 0, host);
    await settle();
    expect(api.createUpload).toHaveBeenCalledTimes(2);
    expect(store.items(target).map((item) => item.status)).toEqual([
      'uploading',
      'uploading',
      'queued',
    ]);
    FakeXhr.all[0]?.finish();
    await settle();
    await settle();
    expect(api.createUpload).toHaveBeenCalledTimes(3);
  });

  it('cancel aborts the transfer and attaches nothing', async () => {
    const { store, attached, host } = setup();
    store.add(target, [png('lon.png', 50_000)], options, 0, host);
    await settle();
    const [item] = store.items(target);
    store.cancel(target, item?.key ?? '');
    await settle();
    expect(FakeXhr.all[0]?.aborted).toBe(true);
    expect(store.items(target)).toEqual([]);
    expect(attached).toEqual([]);
  });

  it('a lost connection can be retried from a new presign', async () => {
    const { store, api, attached, host } = setup();
    store.add(target, [png('mat-sau.png', 3000)], options, 0, host);
    await settle();
    FakeXhr.all[0]?.progress(2100, 3000);
    FakeXhr.all[0]?.fail();
    await settle();
    const [failed] = store.items(target);
    expect(failed).toMatchObject({
      status: 'failed',
      retryable: true,
      issue: { code: 'NETWORK', params: { loaded: 2100, size: 3000 } },
    });
    store.retry(target, failed?.key ?? '');
    await settle();
    expect(api.createUpload).toHaveBeenCalledTimes(2);
    FakeXhr.all[1]?.finish();
    await settle();
    expect(attached).toHaveLength(1);
  });

  it('maps server refusals to their detail code; only some are worth a retry', () => {
    const refused = (code: string, status = 422) =>
      new ApiError({
        status,
        code: status === 422 ? 'VALIDATION_FAILED' : 'PERMISSION_DENIED',
        errors: [{ path: 'size', code, message: 'Refused', params: { limit: 10 } }],
      });
    expect(issueOfError(refused('FILE_TOO_LARGE'), 0, 20)).toEqual({
      issue: { code: 'FILE_TOO_LARGE', params: { limit: 10 } },
      retryable: false,
    });
    expect(issueOfError(refused('CONTENT_MISMATCH'), 0, 20).retryable).toBe(false);
    expect(issueOfError(refused('UPLOAD_INCOMPLETE'), 0, 20).retryable).toBe(true);
    expect(issueOfError(refused('SIZE_MISMATCH'), 0, 20).retryable).toBe(true);
    expect(issueOfError(refused('X', 403), 0, 20)).toEqual({
      issue: { code: 'DENIED' },
      retryable: false,
    });
    expect(issueOfError(new TransferError({ kind: 'status', status: 413 }), 0, 20).issue.code).toBe(
      'FILE_TOO_LARGE',
    );
    expect(issueOfError(new TransferError({ kind: 'status', status: 403 }), 0, 20)).toEqual({
      issue: { code: 'FAILED' },
      retryable: true,
    });
  });
});
