import { setTimeout as sleep } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { contentDisposition, S3StorageDriver } from '../../src/storage/index.js';
import { GARAGE_TEST_CREDENTIALS, startGarage, type StartedGarage } from '../support/garage.js';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.js';

const KEY = 'org_A1b2C3d4E5f6G7h8/att_A1b2C3d4E5f6G7h8';

function driverFor(
  endpoint: string,
  publicEndpoint: string,
  bucket: string = GARAGE_TEST_CREDENTIALS.bucket,
): S3StorageDriver {
  return new S3StorageDriver({
    endpoint,
    publicEndpoint,
    region: GARAGE_TEST_CREDENTIALS.region,
    bucket,
    accessKeyId: GARAGE_TEST_CREDENTIALS.accessKeyId,
    secretAccessKey: GARAGE_TEST_CREDENTIALS.secretAccessKey,
    forcePathStyle: true,
    requestTimeoutMs: 5_000,
  });
}

describe('S3StorageDriver against Garage', () => {
  let garage: StartedGarage;
  let proxy: TcpProxy;
  let publicEndpoint: string;
  let driver: S3StorageDriver;

  beforeAll(async () => {
    garage = await startGarage();
    // Plays the reverse proxy browsers reach (S3_PUBLIC_ENDPOINT); another host
    // name and port than the endpoint the server uses.
    proxy = await startTcpProxy(garage.host, garage.s3Port);
    publicEndpoint = `http://127.0.0.1:${String(proxy.port)}`;
    driver = driverFor(garage.s3Endpoint, publicEndpoint);
  });

  afterAll(async () => {
    await driver.close();
    await proxy.close();
    await garage.stop();
  });

  it('is healthy, and unhealthy for a missing bucket', async () => {
    await expect(driver.health()).resolves.toBeUndefined();
    const missing = driverFor(garage.s3Endpoint, publicEndpoint, 'no-such-bucket');
    await expect(missing.health()).rejects.toBeDefined();
    await missing.close();
  });

  it('uploads with a presigned PUT and downloads with a presigned GET via the public endpoint', async () => {
    const body = 'hello from Cellhive – xin chào';
    const put = await driver.presignPut(KEY, {
      contentType: 'text/plain; charset=utf-8',
      maxBytes: 1024,
      expiresIn: 600,
    });
    expect(new URL(put.url).origin).toBe(publicEndpoint);
    const uploaded = await fetch(put.url, { method: 'PUT', headers: put.headers, body });
    expect(uploaded.status).toBe(200);

    expect(await driver.head(KEY)).toMatchObject({
      size: Buffer.byteLength(body),
      contentType: 'text/plain; charset=utf-8',
    });

    const filename = 'Báo cáo "cuối".txt';
    const get = await driver.presignGet(KEY, { filename, expiresIn: 60 });
    expect(new URL(get.url).origin).toBe(publicEndpoint);
    const downloaded = await fetch(get.url);
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe(body);
    expect(downloaded.headers.get('content-disposition')).toBe(contentDisposition(filename));
  });

  it('signs for the public host: the same URL sent to the internal endpoint is rejected', async () => {
    const get = await driver.presignGet(KEY, { filename: 'a.txt', expiresIn: 60 });
    const internal = new URL(get.url);
    internal.host = new URL(garage.s3Endpoint).host;
    expect(internal.host).not.toBe(new URL(publicEndpoint).host);
    const response = await fetch(internal);
    expect(response.status).toBe(403);
  });

  it('rejects an upload whose Content-Type differs from the signed one', async () => {
    const put = await driver.presignPut('org_A1b2C3d4E5f6G7h8/other', {
      contentType: 'image/png',
      maxBytes: 1024,
      expiresIn: 600,
    });
    const response = await fetch(put.url, {
      method: 'PUT',
      headers: { 'content-type': 'text/html' },
      body: '<script>alert(1)</script>',
    });
    expect(response.status).toBe(403);
    expect(await driver.head('org_A1b2C3d4E5f6G7h8/other')).toBeNull();
  });

  it('rejects an expired presigned URL', async () => {
    const get = await driver.presignGet(KEY, { filename: 'a.txt', expiresIn: 2 });
    const fresh = await fetch(get.url);
    expect(fresh.status).toBe(200);
    await fresh.arrayBuffer();
    await sleep(3_100);
    const response = await fetch(get.url);
    // Garage answers 400 "date is too old" (AWS S3: 403 "Request has expired").
    expect([400, 403]).toContain(response.status);
    expect(await response.text()).toMatch(/too old|expired/i);
  });

  it('moves an object server-side, and reports a missing source', async () => {
    const from = 'org_A1b2C3d4E5f6G7h8/moved.upload';
    const to = 'org_A1b2C3d4E5f6G7h8/moved';
    await driver.put(from, Buffer.from('%PDF-1.7'), { contentType: 'application/pdf' });
    expect(await driver.move(from, to)).toBe(true);
    expect(await driver.head(from)).toBeNull();
    expect(await driver.head(to)).toMatchObject({ size: 8, contentType: 'application/pdf' });
    expect(await driver.move(from, to)).toBe(false);
    await driver.delete(to);
  });

  it('deletes idempotently', async () => {
    await driver.delete(KEY);
    await driver.delete(KEY);
    expect(await driver.head(KEY)).toBeNull();
  });
});
