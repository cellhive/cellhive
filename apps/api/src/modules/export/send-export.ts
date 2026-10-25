import type { ExportFile } from './export.service.js';
import type { FastifyReply } from 'fastify';

/**
 * Opens an export and streams it (`GET /tables/:id/export`, `GET
 * /shares/:token/export`). A client that goes away cancels the statement
 * in flight and frees the export slots — also when it leaves while the
 * export is still opening (T819: the `close` listener used to be attached
 * after `open`, so a client that left during the count missed it, the
 * unread stream never reached its `finally`, and the self-renewing slots of
 * the user, link and IP answered `429` until the process restarted).
 */
export async function sendExport(
  reply: FastifyReply,
  open: (signal: AbortSignal) => Promise<ExportFile>,
  headers: Readonly<Record<string, string>> = {},
): Promise<void> {
  const abort = new AbortController();
  // An object: the `close` listener sets it while `open` is awaited.
  const response = { closed: false };
  let file: ExportFile | null = null;
  reply.raw.once('close', () => {
    response.closed = true;
    if (!reply.raw.writableFinished) abort.abort();
    if (file !== null) void file.finish();
  });
  file = await open(abort.signal);
  if (response.closed || reply.raw.destroyed) {
    file.body.destroy();
    await file.finish();
    return;
  }
  let sending = reply
    .header('content-type', file.contentType)
    .header('content-disposition', file.disposition);
  for (const [name, value] of Object.entries(headers)) sending = sending.header(name, value);
  await sending.send(file.body);
}
