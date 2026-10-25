import { request as httpRequest } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

import { contentDisposition, type StorageDriver } from '@cellhive/server-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { STORAGE_DRIVER } from '../../src/common/tokens.js';

import { problemOf, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { AddressInfo } from 'node:net';

const KEY = 'org_A1b2C3d4E5f6G7h8/att_A1b2C3d4E5f6G7h8';

/** Path + query of a presigned URL, for `app.inject`. */
function pathOf(url: string): string {
  const parsed = new URL(url);
  expect(parsed.origin).toBe(TEST_PUBLIC_URL);
  return parsed.pathname + parsed.search;
}

function withParam(url: string, name: string, value: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set(name, value);
  return parsed.toString();
}

describe('local storage signed URLs (STORAGE_DRIVER=local)', () => {
  let t: TestApp;
  let driver: StorageDriver;

  beforeAll(async () => {
    t = await startTestApp();
    driver = t.app.get<StorageDriver>(STORAGE_DRIVER);
    expect(driver.kind).toBe('local');
  });

  afterAll(async () => {
    await t.close();
  });

  it('uploads with a signed PUT and downloads with a signed GET', async () => {
    const body = '{"not":"parsed as JSON by the API"}';
    const put = await driver.presignPut(KEY, {
      contentType: 'application/json',
      maxBytes: 1024,
      expiresIn: 600,
    });
    const uploaded = await t.app.inject({
      method: 'PUT',
      url: pathOf(put.url),
      headers: put.headers,
      payload: body,
    });
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.headers.etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(await driver.head(KEY)).toMatchObject({
      size: body.length,
      contentType: 'application/json',
    });

    const filename = 'Báo cáo tháng 9.json';
    const get = await driver.presignGet(KEY, { filename, expiresIn: 60 });
    const downloaded = await t.app.inject({ method: 'GET', url: pathOf(get.url) });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.body).toBe(body);
    expect(downloaded.headers['content-type']).toBe('application/json');
    expect(downloaded.headers['content-disposition']).toBe(contentDisposition(filename));
    expect(downloaded.headers['x-content-type-options']).toBe('nosniff');

    const head = await t.app.inject({ method: 'HEAD', url: pathOf(get.url) });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe(String(body.length));
  });

  it('streams binary uploads unchanged', async () => {
    const key = 'org_A1b2C3d4E5f6G7h8/binary';
    const bytes = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 256));
    const put = await driver.presignPut(key, {
      contentType: 'application/octet-stream',
      maxBytes: bytes.length,
      expiresIn: 600,
    });
    const uploaded = await t.app.inject({
      method: 'PUT',
      url: pathOf(put.url),
      headers: put.headers,
      payload: bytes,
    });
    expect(uploaded.statusCode).toBe(200);
    const get = await driver.presignGet(key, { filename: 'b.bin', expiresIn: 60 });
    const downloaded = await t.app.inject({ method: 'GET', url: pathOf(get.url) });
    expect(downloaded.rawPayload.equals(bytes)).toBe(true);
  });

  it('accepts an empty upload', async () => {
    const key = 'org_A1b2C3d4E5f6G7h8/empty';
    const put = await driver.presignPut(key, {
      contentType: 'text/plain',
      maxBytes: 10,
      expiresIn: 600,
    });
    for (const headers of [put.headers, { ...put.headers, 'content-length': '0' }]) {
      const response = await t.app.inject({ method: 'PUT', url: pathOf(put.url), headers });
      expect(response.statusCode).toBe(200);
      expect(await driver.head(key)).toMatchObject({ size: 0 });
    }
  });

  it('rejects a tampered signature with 403 PERMISSION_DENIED', async () => {
    const get = await driver.presignGet(KEY, { filename: 'a.txt', expiresIn: 60 });
    const sig = new URL(get.url).searchParams.get('sig') ?? '';
    const flipped = `${sig.startsWith('A') ? 'B' : 'A'}${sig.slice(1)}`;
    for (const url of [
      withParam(get.url, 'sig', flipped),
      withParam(get.url, 'fn', 'evil.html'),
      withParam(get.url, 'exp', String(Math.floor(Date.now() / 1000) + 86_400)),
    ]) {
      const response = await t.app.inject({ method: 'GET', url: pathOf(url) });
      expect(response.statusCode).toBe(403);
      expect(problemOf(response.body)).toMatchObject({
        code: 'PERMISSION_DENIED',
        detail: 'The signed URL is invalid.',
      });
    }
    // A download URL cannot be used to upload.
    const response = await t.app.inject({
      method: 'PUT',
      url: pathOf(get.url),
      headers: { 'content-type': 'text/plain' },
      payload: 'overwrite',
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects an expired URL with 403 PERMISSION_DENIED', async () => {
    const get = await driver.presignGet(KEY, { filename: 'a.txt', expiresIn: 1 });
    await sleep(2_100);
    const response = await t.app.inject({ method: 'GET', url: pathOf(get.url) });
    expect(response.statusCode).toBe(403);
    expect(problemOf(response.body)).toMatchObject({
      code: 'PERMISSION_DENIED',
      detail: 'The signed URL has expired.',
    });
  });

  it('rejects an upload with another Content-Type (403) or over the size limit (413)', async () => {
    const key = 'org_A1b2C3d4E5f6G7h8/limited';
    const put = await driver.presignPut(key, {
      contentType: 'image/png',
      maxBytes: 8,
      expiresIn: 600,
    });
    const wrongType = await t.app.inject({
      method: 'PUT',
      url: pathOf(put.url),
      headers: { 'content-type': 'text/html' },
      payload: '<script>',
    });
    expect(wrongType.statusCode).toBe(403);

    const tooLarge = await t.app.inject({
      method: 'PUT',
      url: pathOf(put.url),
      headers: put.headers,
      payload: Buffer.alloc(9),
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(problemOf(tooLarge.body).code).toBe('PAYLOAD_TOO_LARGE');
    expect(await driver.head(key)).toBeNull();
  });

  it('rejects keys outside the pattern (path traversal) with 422 before checking the signature', async () => {
    const get = await driver.presignGet(KEY, { filename: 'a.txt', expiresIn: 60 });
    const query = new URL(get.url).search;
    for (const path of [
      '/api/v1/storage/local/..%2F..%2Fetc/passwd',
      '/api/v1/storage/local/org_x/..',
      '/api/v1/storage/local/org_x/a%00b',
      '/api/v1/storage/local/only-one-segment',
    ]) {
      const response = await t.app.inject({ method: 'GET', url: `${path}${query}` });
      expect(response.statusCode, path).toBe(422);
      expect(problemOf(response.body).code).toBe('VALIDATION_FAILED');
    }
  });

  it('rejects unnormalised dot segments sent over the wire with 422', async () => {
    // HTTP clients (and app.inject) resolve `..` before sending; a raw request does not.
    await t.app.listen(0, '127.0.0.1');
    const { port } = t.app.getHttpServer().address() as AddressInfo;
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'GET',
          path: '/api/v1/storage/local/org_x/../../../etc/passwd?exp=1&sig=x',
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on('error', reject);
      request.end();
    });
    expect(status).toBe(422);
  });

  it('logs a cancelled upload (client abort, ECONNRESET) at info, never as INTERNAL', async () => {
    const key = 'org_A1b2C3d4E5f6G7h8/cancelled';
    const size = 4 * 1024 * 1024;
    const put = await driver.presignPut(key, {
      contentType: 'application/octet-stream',
      maxBytes: size,
      expiresIn: 600,
    });
    if (!t.app.getHttpServer().listening) await t.app.listen(0, '127.0.0.1');
    const { port } = t.app.getHttpServer().address() as AddressInfo;
    const target = new URL(put.url);
    const before = t.logs.lines.length;
    await new Promise<void>((resolve) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port,
        method: 'PUT',
        path: target.pathname + target.search,
        headers: { ...put.headers, 'content-length': String(size) },
      });
      request.on('error', () => {
        resolve();
      });
      // Half the body, then the browser's XHR abort: the socket is destroyed.
      request.write(Buffer.alloc(size / 2, 1), () => {
        setTimeout(() => {
          request.destroy();
          resolve();
        }, 50);
      });
    });
    // The server notices the reset on its side.
    let lines: Record<string, unknown>[] = [];
    for (let waited = 0; waited < 3_000; waited += 50) {
      lines = t.logs.lines.slice(before);
      if (lines.some((line) => line.msg === 'request aborted by the client')) break;
      await sleep(50);
    }
    const aborted = lines.find((line) => line.msg === 'request aborted by the client');
    expect(aborted).toMatchObject({ level: 'info' });
    expect(lines.some((line) => line.level === 'error')).toBe(false);
    expect(lines.some((line) => line.code === 'INTERNAL')).toBe(false);
    // Nothing is stored and the temporary file is gone.
    expect(await driver.head(key)).toBeNull();
  });

  it('answers 404 for a validly signed URL of a missing object', async () => {
    const get = await driver.presignGet('org_A1b2C3d4E5f6G7h8/missing', {
      filename: 'a.txt',
      expiresIn: 60,
    });
    const response = await t.app.inject({ method: 'GET', url: pathOf(get.url) });
    expect(response.statusCode).toBe(404);
  });
});

describe('local storage routes with STORAGE_DRIVER=s3', () => {
  it('do not exist', async () => {
    const t = await startTestApp({
      STORAGE_DRIVER: 's3',
      S3_ENDPOINT: 'http://127.0.0.1:1',
      S3_REGION: 'garage',
      S3_BUCKET: 'cellhive',
      S3_ACCESS_KEY_ID: 'GK0123456789abcdef01234567',
      S3_SECRET_ACCESS_KEY: 'secret',
    });
    try {
      const response = await t.app.inject({
        method: 'GET',
        url: `/api/v1/storage/local/${KEY}?exp=1&fn=a&disp=attachment&sig=x`,
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });
});
