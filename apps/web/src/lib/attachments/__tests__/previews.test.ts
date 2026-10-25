import { attachmentOptionsSchema } from '@cellhive/field-types';
import { describe, expect, it, vi } from 'vitest';

import { imageSourceOf } from '../kinds';
import {
  LocalPreviews,
  localPreviews,
  THUMBNAIL_RETRY_DELAYS_MS,
  thumbnailRetryDelay,
  thumbnailRetryUrl,
} from '../previews';
import { UploadStore } from '../uploads';

import type { XhrFactory } from '../transfer';
import type { CellFile } from '../value';

describe('local previews of uploaded images (T421b)', () => {
  it('keeps the newest previews and revokes the ones it drops', () => {
    const revoke = vi.fn();
    const previews = new LocalPreviews(2, revoke);
    previews.remember('att_1', 'blob:1');
    previews.remember('att_2', 'blob:2');
    previews.remember('att_3', 'blob:3');
    expect(previews.get('att_1')).toBeNull();
    expect(previews.get('att_2')).toBe('blob:2');
    expect(previews.get('att_3')).toBe('blob:3');
    expect(revoke).toHaveBeenCalledWith('blob:1');
  });

  it('draws a just uploaded image from its local copy, never from the network', () => {
    const file = {
      id: 'att_Local0000000001',
      mime: 'image/png',
      url: '/api/v1/files/att_Local0000000001',
      thumbnail_url: '/api/v1/files/att_Local0000000001/thumbnail',
    };
    expect(imageSourceOf(file, false)).toBe('/api/v1/files/att_Local0000000001/thumbnail');
    localPreviews.remember(file.id, 'blob:local');
    expect(imageSourceOf(file, false)).toBe('blob:local');
    expect(imageSourceOf(file, true)).toBe('blob:local');
    // Not an image the grid draws: never.
    expect(imageSourceOf({ ...file, mime: 'image/svg+xml' }, true)).toBeNull();
    localPreviews.clear();
  });

  it('asks again for a missing thumbnail with backoff, then gives up', () => {
    expect(thumbnailRetryUrl('/api/v1/files/att_1/thumbnail', 0)).toBe(
      '/api/v1/files/att_1/thumbnail',
    );
    expect(thumbnailRetryUrl('/api/v1/files/att_1/thumbnail', 2)).toBe(
      '/api/v1/files/att_1/thumbnail?retry=2',
    );
    expect(thumbnailRetryUrl('/api/v1/files/att_1/thumbnail?size=1280', 1)).toBe(
      '/api/v1/files/att_1/thumbnail?size=1280&retry=1',
    );
    // A local copy never fails for a missing thumbnail: no retry.
    expect(thumbnailRetryDelay('blob:x', 0)).toBeNull();
    expect(thumbnailRetryDelay('/api/v1/files/att_1/thumbnail', 0)).toBe(
      THUMBNAIL_RETRY_DELAYS_MS[0],
    );
    const delays = THUMBNAIL_RETRY_DELAYS_MS.map((_, attempt) =>
      thumbnailRetryDelay('/api/v1/files/att_1/thumbnail', attempt),
    );
    expect(delays).toEqual([...THUMBNAIL_RETRY_DELAYS_MS]);
    expect(
      delays.every((delay, index) => index === 0 || (delay ?? 0) > (delays[index - 1] ?? 0)),
    ).toBe(true);
    expect(
      thumbnailRetryDelay('/api/v1/files/att_1/thumbnail', THUMBNAIL_RETRY_DELAYS_MS.length),
    ).toBeNull();
  });

  it('hands the preview of a finished upload over instead of revoking it', async () => {
    const revoke = vi.fn();
    const previews = new LocalPreviews(10, revoke);
    const xhrs: { finish: () => void }[] = [];
    const xhr: XhrFactory = () => {
      const events = new EventTarget();
      const request = {
        status: 0,
        upload: new EventTarget(),
        open: () => undefined,
        setRequestHeader: () => undefined,
        addEventListener: (type: string, listener: EventListener) => {
          events.addEventListener(type, listener);
        },
        send: () => undefined,
        abort: () => undefined,
      };
      xhrs.push({
        finish: () => {
          request.status = 200;
          events.dispatchEvent(new Event('load'));
        },
      });
      return request as unknown as XMLHttpRequest;
    };
    const store = new UploadStore({
      api: {
        createUpload: () =>
          Promise.resolve({
            id: 'att_Upload0000000001' as const,
            upload: {
              method: 'PUT' as const,
              url: 'https://files.example.test/x',
              headers: {},
              expires_at: '2026-09-25T03:25:00.000Z',
            },
          }),
        complete: (id: string) =>
          Promise.resolve({
            id: id as `att_${string}`,
            name: 'anh.png',
            size: 3,
            mime: 'image/png',
            url: `/api/v1/files/${id}`,
            thumbnail_url: `/api/v1/files/${id}/thumbnail`,
          }),
      },
      xhr,
      previewOf: () => 'blob:anh',
      previews,
    });
    const attached: CellFile[] = [];
    store.add(
      { tableId: 'tbl_1', recordId: 'rec_1', fieldId: 'fld_1' },
      [new File([new Uint8Array(3)], 'anh.png', { type: 'image/png' })],
      attachmentOptionsSchema.parse({}),
      0,
      {
        attach: (file) => {
          attached.push(file);
        },
      },
    );
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    xhrs[0]?.finish();
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    expect(attached.map((file) => file.id)).toEqual(['att_Upload0000000001']);
    expect(previews.get('att_Upload0000000001')).toBe('blob:anh');
    expect(revoke).not.toHaveBeenCalled();
  });
});
