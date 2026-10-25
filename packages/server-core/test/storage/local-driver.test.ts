import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '../../src/errors/index.js';
import { checkUploadedObject } from '../../src/records/attachments/index.js';
import {
  isValidStorageKey,
  LocalStorageDriver,
  STORAGE_KEY_PATTERN,
  uploadStagingKey,
} from '../../src/storage/index.js';

const KEY = 'org_A1b2C3d4E5f6G7h8/att_A1b2C3d4E5f6G7h8';

describe('storage keys', () => {
  const valid = [KEY, 'org_x/file.v2-final_1', 'a/b'];
  const invalid = [
    '',
    'nokey',
    'a/b/c',
    '../etc/passwd',
    'a/..',
    'a/.',
    '/a/b',
    'a/b/',
    'a\\b/c',
    'a/b c',
    'a/b%2F',
    'org.x/y',
    `a/${'x'.repeat(600)}`,
  ];
  it.each(valid)('accepts %s', (key) => {
    expect(isValidStorageKey(key)).toBe(true);
  });
  it.each(invalid)('rejects %s', (key) => {
    expect(isValidStorageKey(key)).toBe(false);
  });
  it('exposes the pattern', () => {
    expect(STORAGE_KEY_PATTERN.test(KEY)).toBe(true);
  });
});

describe('LocalStorageDriver', () => {
  let root: string;
  let now = 1_800_000_000_000;
  let driver: LocalStorageDriver;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cellhive-local-'));
    driver = new LocalStorageDriver({
      root,
      publicUrl: 'https://cellhive.example.com/',
      sessionSecret: 'test-session-secret-0123456789abcdef',
      now: () => now,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function read(key: string): Promise<string | null> {
    const stream = await driver.getStream(key);
    return stream === null ? null : text(stream);
  }

  it('presigns URLs under /api/v1/storage/local on PUBLIC_URL', async () => {
    const put = await driver.presignPut(KEY, {
      contentType: 'text/plain',
      maxBytes: 10,
      expiresIn: 600,
    });
    const url = new URL(put.url);
    expect(url.origin + url.pathname).toBe(
      `https://cellhive.example.com/api/v1/storage/local/${KEY}`,
    );
    expect([...url.searchParams.keys()]).toEqual(['exp', 'ct', 'max', 'sig']);
    expect(put.headers).toEqual({ 'content-type': 'text/plain' });
    expect(put.expiresAt.getTime()).toBe(now + 600_000);

    const verified = driver.verify('PUT', KEY, Object.fromEntries(url.searchParams));
    expect(verified.ok).toBe(true);
    now += 601_000;
    expect(driver.verify('PUT', KEY, Object.fromEntries(url.searchParams))).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('writes, heads, reads and deletes an object', async () => {
    expect(await driver.head(KEY)).toBeNull();
    const info = await driver.write(KEY, Readable.from([Buffer.from('hello')]), {
      contentType: 'text/plain',
      maxBytes: 5,
    });
    expect(info).toMatchObject({ size: 5, etag: '"5d41402abc4b2a76b9719d911017c592"' });
    expect(await driver.head(KEY)).toMatchObject({
      size: 5,
      contentType: 'text/plain',
      etag: '"5d41402abc4b2a76b9719d911017c592"',
    });
    const opened = await driver.openRead(KEY);
    if (opened === null) throw new Error('expected the object to exist');
    expect(await text(opened.stream)).toBe('hello');
    await driver.delete(KEY);
    await driver.delete(KEY);
    expect(await driver.head(KEY)).toBeNull();
  });

  it('rejects uploads over maxBytes with 413 and leaves nothing behind', async () => {
    const error: unknown = await driver
      .write(KEY, Readable.from([Buffer.from('hello'), Buffer.from('world')]), {
        contentType: 'text/plain',
        maxBytes: 7,
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('PAYLOAD_TOO_LARGE');
    expect(await driver.head(KEY)).toBeNull();
    expect(await readdir(join(root, 'tmp'))).toEqual([]);
  });

  it('rejects invalid keys with VALIDATION_FAILED', async () => {
    await expect(driver.head('../../etc/passwd')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(driver.presignGet('a/..', { filename: 'x', expiresIn: 60 })).rejects.toMatchObject(
      { code: 'VALIDATION_FAILED' },
    );
    await expect(driver.presignGet(KEY, { filename: 'x', expiresIn: 0 })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('reports healthy when the root is writable', async () => {
    await expect(driver.health()).resolves.toBeUndefined();
  });

  it('moves an object with its metadata, and reports a missing source', async () => {
    await driver.put(uploadStagingKey(KEY), Buffer.from('%PDF-1.7'), {
      contentType: 'application/pdf',
    });
    expect(await driver.move(uploadStagingKey(KEY), KEY)).toBe(true);
    expect(await driver.head(uploadStagingKey(KEY))).toBeNull();
    expect(await driver.head(KEY)).toMatchObject({ size: 8, contentType: 'application/pdf' });
    expect(await read(KEY)).toBe('%PDF-1.7');
    expect(await driver.move(uploadStagingKey(KEY), KEY)).toBe(false);
  });

  it('a presigned PUT replayed after the upload was checked cannot replace the object', async () => {
    const pdf = Buffer.from('%PDF-1.7');
    const expected = { size: pdf.length, mime: 'application/pdf', blockNativeExecutables: true };
    // The signed PUT writes the staging key (LocalStorageService.upload → write).
    const write = (bytes: Buffer) =>
      driver.write(uploadStagingKey(KEY), Readable.from([bytes]), {
        contentType: 'application/pdf',
        maxBytes: bytes.length,
      });
    await write(pdf);
    expect(await checkUploadedObject(driver, KEY, expected)).toMatchObject({ ok: true });
    // Same URL, same size, a Windows executable this time.
    await write(Buffer.from('MZ--evil'));
    expect(await read(KEY)).toBe('%PDF-1.7');
    // A repeated check keeps the checked object and drops the replayed bytes.
    expect(await checkUploadedObject(driver, KEY, expected)).toMatchObject({ ok: true });
    expect(await read(KEY)).toBe('%PDF-1.7');
    expect(await driver.head(uploadStagingKey(KEY))).toBeNull();
  });
});
