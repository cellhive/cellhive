/**
 * Opt-in bench (BACKLOG T406, S4 open question #13): `T406_BENCH=1 pnpm
 * --filter @cellhive/api test:int test/int/files.bench`. For the local driver
 * and a real Garage, uploads 50 MB and 100 MB files as a stream over real
 * HTTP (`PUT` to the signed URL), then measures `complete` (HEAD + streamed
 * SHA-256 + sniffing; target < 2 s), the RSS growth of the process during a
 * local upload (target < 50 MB: the API streams to disk) and `GET
 * /files/:id` up to the `302` (target p95 < 100 ms). The deterministic
 * checks live in `files.int.test.ts` / `files-garage.int.test.ts`.
 */
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { createUploadResponseSchema, type Id } from '@cellhive/contracts';
import {
  orgScope,
  SchemaService,
  systemAuditContext,
  type Db,
  type FieldRow,
} from '@cellhive/server-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { garageEnv, startGarage, type StartedGarage } from './garage-support.js';
import { buildRecordFixture, type RecordFixture } from './record-fixture.js';
import { startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { AddressInfo } from 'node:net';

const MB = 1024 * 1024;
const SIZES = [50 * MB, 100 * MB];
const CHUNK = Buffer.alloc(MB, 0x5a);

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

/** `size` bytes generated on the fly (never held in memory). */
function body(size: number): Readable {
  let left = size;
  return new Readable({
    read() {
      if (left <= 0) {
        this.push(null);
        return;
      }
      const part = CHUNK.subarray(0, Math.min(CHUNK.length, left));
      left -= part.length;
      this.push(part);
    },
  });
}

/** Streams a PUT with an explicit `Content-Length` (what browsers send). */
async function streamPut(url: URL, headers: Record<string, string>, size: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      url,
      { method: 'PUT', headers: { ...headers, 'content-length': String(size) } },
      (res) => {
        res.resume();
        res.on('end', () => {
          resolve(res.statusCode ?? 0);
        });
      },
    );
    req.on('error', reject);
    pipeline(body(size), req).catch(reject);
  });
}

describe.skipIf(process.env['T406_BENCH'] !== '1')('attachment upload/download bench', () => {
  let garage: StartedGarage;
  const report: string[] = [];

  beforeAll(async () => {
    garage = await startGarage();
  }, 240_000);

  afterAll(async () => {
    await garage.stop();
    process.stdout.write(`\nT406 bench\n${report.join('\n')}\n`);
  });

  for (const driver of ['local', 's3'] as const) {
    describe(driver, () => {
      let database: TestDatabase;
      let db: Db;
      let t: TestApp;
      let fx: RecordFixture;
      let files: FieldRow;
      let recordId: Id<'rec'>;
      let origin: string;

      beforeAll(async () => {
        database = await createMigratedDatabase();
        db = createTestDb(database.url);
        t = await startTestApp({
          DATABASE_URL: database.url,
          LOG_LEVEL: 'warn',
          ...(driver === 's3' ? garageEnv(garage) : {}),
        });
        await t.app.listen(0, '127.0.0.1');
        origin = `http://127.0.0.1:${String((t.app.getHttpServer().address() as AddressInfo).port)}`;
        fx = await buildRecordFixture(t, db);
        files = await t.app
          .get(SchemaService)
          .addField(
            orgScope(fx.orgId),
            fx.orders.id,
            { name: 'files', type: 'attachment', options: {} },
            systemAuditContext(),
          );
        const created = await fx.call('owner', 'POST', `/tables/${fx.orders.id}/records`, {
          records: [{ fields: { title: 'bench' } }],
        });
        recordId = created.json<{ records: { id: Id<'rec'> }[] }>().records[0]?.id as Id<'rec'>;
        // Warm-up (JIT, socket and stream buffers, allocator arenas: a one-off ~50 MB of RSS
        // with client and server in one process) so that RSS reflects the upload itself.
        const warm = await fx.call('owner', 'POST', '/files/uploads', {
          table_id: fx.orders.id,
          field_id: files.id,
          filename: 'warm.bin',
          size: 50 * MB,
          mime: 'application/octet-stream',
        });
        const { upload } = createUploadResponseSchema.parse(warm.json());
        await streamPut(
          new URL(upload.url.replace(TEST_PUBLIC_URL, origin)),
          upload.headers,
          50 * MB,
        );
      }, 240_000);

      afterAll(async () => {
        await t.close();
        await db.destroy();
        await database.drop();
      });

      for (const size of SIZES) {
        it(`${String(size / MB)} MB: complete < 2 s after the PUT`, async () => {
          const started = await fx.call('owner', 'POST', '/files/uploads', {
            table_id: fx.orders.id,
            field_id: files.id,
            filename: 'bench.bin',
            size,
            mime: 'application/octet-stream',
          });
          const { id, upload } = createUploadResponseSchema.parse(started.json());
          // Local URLs point at PUBLIC_URL: send them to the listening test server.
          const url = new URL(upload.url.replace(TEST_PUBLIC_URL, origin));
          if (typeof globalThis.gc === 'function') globalThis.gc();
          const baseline = process.memoryUsage().rss;
          let peak = baseline;
          const sampler = setInterval(() => {
            peak = Math.max(peak, process.memoryUsage().rss);
          }, 10);
          const putStarted = performance.now();
          const status = await streamPut(url, upload.headers, size);
          const putMs = performance.now() - putStarted;
          clearInterval(sampler);
          expect(status).toBe(200);
          const completeStarted = performance.now();
          const done = await fx.call('owner', 'POST', `/files/uploads/${id}/complete`);
          const completeMs = performance.now() - completeStarted;
          expect(done.statusCode, done.body).toBe(200);
          const rssMb = (peak - baseline) / MB;
          report.push(
            `${driver} ${String(size / MB)} MB: PUT ${putMs.toFixed(0)} ms, complete ` +
              `${completeMs.toFixed(0)} ms, RSS +${rssMb.toFixed(1)} MB`,
          );
          expect(completeMs).toBeLessThan(2000);
          if (driver === 'local') expect(rssMb).toBeLessThan(50);

          const written = await fx.call(
            'owner',
            'PATCH',
            `/tables/${fx.orders.id}/records?field_key_type=id`,
            { records: [{ id: recordId, fields: { [files.id]: [{ id }] } }] },
          );
          expect(written.statusCode).toBe(200);
        }, 120_000);
      }

      it('GET /files/:id p95 < 100 ms (to the 302)', async () => {
        const record = await fx.call(
          'owner',
          'GET',
          `/tables/${fx.orders.id}/records/${recordId}?field_key_type=id`,
        );
        const id = record.json<{ fields: Record<string, { id: string }[]> }>().fields[files.id]?.[0]
          ?.id;
        const samples: number[] = [];
        for (let run = 0; run < 100; run += 1) {
          const begin = performance.now();
          const response = await fx.call('owner', 'GET', `/files/${String(id)}`);
          samples.push(performance.now() - begin);
          expect(response.statusCode).toBe(302);
        }
        const p95 = percentile(samples, 95);
        report.push(
          `${driver} GET /files/:id p50 ${percentile(samples, 50).toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`,
        );
        expect(p95).toBeLessThan(100);
      });
    });
  }
});
