import { crc32, deflateSync } from 'node:zlib';

import { expect, type Page } from '@playwright/test';

import { retryWhileRateLimited } from './support';

/**
 * Test files and uploads for the attachment E2E (T418): a PNG of one color
 * (a real image the browser decodes), a minimal PDF, and the upload flow of
 * CONTRACTS §20 run from inside the page like the SPA (presign → PUT →
 * complete).
 */

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A `width` × `height` PNG filled with `rgb` (`[r, g, b]`, 0–255). */
export function pngBytes(rgb: readonly [number, number, number], width = 64, height = 48): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A PDF of `pages` blank pages (enough for the content check of `complete`,
 * `%PDF-`, and for PDF.js, which rebuilds the missing cross-reference table).
 */
export function pdfBytes(title = 'Cellhive', pages = 1): Buffer {
  const kids = Array.from({ length: pages }, (_, index) => `${String(index + 3)} 0 R`).join(' ');
  const pageObjects = Array.from(
    { length: pages },
    (_, index) =>
      `${String(index + 3)} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n`,
  ).join('');
  return Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n` +
      `2 0 obj<</Type/Pages/Kids[${kids}]/Count ${String(pages)}>>endobj\n` +
      `${pageObjects}% ${title}\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
    'latin1',
  );
}

/** Starts like a PDF (`complete` accepts it) but is not one: PDF.js cannot open it. */
export function brokenPdfBytes(): Buffer {
  return Buffer.from('%PDF-1.4\nthis is not a PDF document at all\n%%EOF\n', 'latin1');
}

export interface UploadedFile {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly mime: string;
}

/**
 * Uploads a file for a cell through the API from the page (session cookie,
 * CSRF like the SPA) and returns the attachment ready to be written
 * (`[{ id }]`). The page must be on the app origin.
 */
export async function uploadFile(
  page: Page,
  target: { tableId: string; fieldId: string },
  file: { name: string; mime: string; bytes: Buffer },
): Promise<UploadedFile> {
  const answer = await retryWhileRateLimited(() =>
    page.evaluate(
      async ({ tableId, fieldId, name, mime, base64 }) => {
        const csrf = document.cookie
          .split('; ')
          .find((cookie) => cookie.startsWith('ob_csrf='))
          ?.slice('ob_csrf='.length);
        const headers = {
          Accept: 'application/json',
          ...(csrf === undefined ? {} : { 'X-CSRF-Token': decodeURIComponent(csrf) }),
        };
        const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
        const created = await fetch('/api/v1/files/uploads', {
          method: 'POST',
          credentials: 'include',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            table_id: tableId,
            field_id: fieldId,
            filename: name,
            size: bytes.length,
            mime,
          }),
        });
        if (created.status !== 201) {
          return { status: created.status, body: await created.text(), retryAfter: null };
        }
        const upload = (await created.json()) as {
          id: string;
          upload: { url: string; headers: Record<string, string> };
        };
        const put = await fetch(upload.upload.url, {
          method: 'PUT',
          headers: upload.upload.headers,
          body: bytes,
        });
        if (!put.ok) return { status: put.status, body: await put.text(), retryAfter: null };
        const done = await fetch(`/api/v1/files/uploads/${upload.id}/complete`, {
          method: 'POST',
          credentials: 'include',
          headers,
        });
        return {
          status: done.status,
          body: await done.text(),
          retryAfter: done.headers.get('retry-after'),
        };
      },
      {
        tableId: target.tableId,
        fieldId: target.fieldId,
        name: file.name,
        mime: file.mime,
        base64: file.bytes.toString('base64'),
      },
    ),
  );
  expect(answer.status, `upload ${file.name}: ${answer.body}`).toBe(200);
  return JSON.parse(answer.body) as UploadedFile;
}
