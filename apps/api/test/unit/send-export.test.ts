import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { sendExport } from '../../src/modules/export/send-export.js';

import type { ExportFile } from '../../src/modules/export/export.service.js';
import type { FastifyReply } from 'fastify';

/** A Fastify reply over a fake `ServerResponse` that records what is sent. */
function fakeReply() {
  const raw = Object.assign(new EventEmitter(), { writableFinished: false, destroyed: false });
  const headers: Record<string, string> = {};
  const sent: unknown[] = [];
  const reply = {
    raw,
    header(name: string, value: string) {
      headers[name] = value;
      return reply;
    },
    send(body: unknown) {
      sent.push(body);
      return Promise.resolve(reply);
    },
  };
  return { reply: reply as unknown as FastifyReply, raw, headers, sent };
}

function fakeFile(): ExportFile & { finished: () => number } {
  let finished = 0;
  return {
    body: Readable.from((async function* () {})()),
    contentType: 'text/csv; charset=utf-8',
    disposition: 'attachment; filename="x.csv"',
    finish: vi.fn(() => {
      finished += 1;
      return Promise.resolve();
    }),
    finished: () => finished,
  };
}

describe('sendExport (T819)', () => {
  it('streams the file and frees the slots when the response closes', async () => {
    const { reply, raw, headers, sent } = fakeReply();
    const file = fakeFile();
    await sendExport(reply, () => Promise.resolve(file), { 'cache-control': 'private, no-store' });
    expect(sent).toEqual([file.body]);
    expect(headers).toEqual({
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="x.csv"',
      'cache-control': 'private, no-store',
    });
    expect(file.finished()).toBe(0);
    raw.emit('close');
    expect(file.finished()).toBe(1);
  });

  it('a client that left while the export was opening: aborted, slots freed, nothing sent', async () => {
    const { reply, raw, sent } = fakeReply();
    const file = fakeFile();
    let signal: AbortSignal | null = null;
    await sendExport(reply, (given) => {
      signal = given;
      // The client goes away during the count, before `open` resolves.
      raw.emit('close');
      return Promise.resolve(file);
    });
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    expect(file.finished()).toBeGreaterThanOrEqual(1);
    expect(file.body.destroyed).toBe(true);
    expect(sent).toEqual([]);
  });

  it('an export that fails to open sends nothing (the service frees its own slots)', async () => {
    const { reply, sent } = fakeReply();
    await expect(sendExport(reply, () => Promise.reject(new Error('busy')))).rejects.toThrow(
      'busy',
    );
    expect(sent).toEqual([]);
  });
});
