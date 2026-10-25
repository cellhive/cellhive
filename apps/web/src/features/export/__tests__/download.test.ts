import { afterEach, describe, expect, it, vi } from 'vitest';

import { errorOfFrameText, exportUrl, startFileDownload } from '../download';

import type { ApiError } from '../../../lib/api/client';

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function frame(): HTMLIFrameElement {
  const found = document.querySelector<HTMLIFrameElement>('iframe[data-download="export"]');
  if (found === null) throw new Error('no download frame');
  return found;
}

/** What the browser shows in the frame when the API answers problem+json. */
function showInFrame(text: string): void {
  const doc = frame().contentDocument;
  if (doc === null) throw new Error('no frame document');
  const pre = doc.createElement('pre');
  pre.textContent = text;
  // jsdom does not load the frame: give its empty document a body.
  const root = doc.documentElement as HTMLElement | null;
  const html = root ?? doc.appendChild(doc.createElement('html'));
  const body = (doc.body as HTMLElement | null) ?? html.appendChild(doc.createElement('body'));
  body.append(pre);
  frame().dispatchEvent(new Event('load'));
}

describe('exportUrl', () => {
  it.each([
    ['csv', '/api/v1/tables/tbl_Orders0000000001/export?view_id=viw_Sales00000000001&format=csv'],
    ['xlsx', '/api/v1/tables/tbl_Orders0000000001/export?view_id=viw_Sales00000000001&format=xlsx'],
  ] as const)('%s', (format, url) => {
    expect(exportUrl('tbl_Orders0000000001', 'viw_Sales00000000001', format)).toBe(url);
  });
});

describe('errorOfFrameText', () => {
  it.each([
    ['{"code":"PERMISSION_DENIED","status":403,"title":"Forbidden"}', 403, 'PERMISSION_DENIED'],
    ['{"code":"RATE_LIMITED","status":429}', 429, 'RATE_LIMITED'],
    [
      '{"code":"VALIDATION_FAILED","status":422,"errors":[{"path":"","code":"EXPORT_TOO_LARGE","params":{"limit":1000000}}]}',
      422,
      'VALIDATION_FAILED',
    ],
    ['<html>Bad gateway</html>', 0, 'UNEXPECTED_RESPONSE'],
    ['{"message":"no code"}', 0, 'UNEXPECTED_RESPONSE'],
  ])('%s', (text, status, code) => {
    const error = errorOfFrameText(text);
    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
  });

  it('keeps the detail codes of EXPORT_TOO_LARGE', () => {
    const error = errorOfFrameText(
      '{"code":"VALIDATION_FAILED","status":422,"errors":[{"path":"","code":"EXPORT_TOO_LARGE","params":{"limit":10}}]}',
    );
    expect(error.errors).toEqual([{ path: '', code: 'EXPORT_TOO_LARGE', params: { limit: 10 } }]);
  });
});

describe('startFileDownload', () => {
  it('opens the URL in a hidden frame and reports a problem+json answer', () => {
    const onError = vi.fn<(error: ApiError) => void>();
    startFileDownload('/api/v1/tables/tbl_x/export?format=csv', { title: 'Export', onError });
    expect(frame().hidden).toBe(true);
    expect(frame().title).toBe('Export');
    expect(frame().getAttribute('src')).toBe('/api/v1/tables/tbl_x/export?format=csv');

    showInFrame('{"code":"RATE_LIMITED","status":429}');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0].code).toBe('RATE_LIMITED');
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('ignores a load without a document (a download) and removes the frame later', () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    startFileDownload('/x', { title: 'Export', onError, frameTtlMs: 1000 });
    frame().dispatchEvent(new Event('load'));
    expect(onError).not.toHaveBeenCalled();
    expect(document.querySelector('iframe')).not.toBeNull();
    vi.advanceTimersByTime(1000);
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('can be forgotten before any answer', () => {
    const onError = vi.fn();
    const forget = startFileDownload('/x', { title: 'Export', onError });
    forget();
    expect(document.querySelector('iframe')).toBeNull();
  });
});
