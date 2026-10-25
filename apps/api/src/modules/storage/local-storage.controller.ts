import { Readable } from 'node:stream';

import { Controller, Get, Inject, Param, Put, Query, Req, Res } from '@nestjs/common';

import { Public } from '../../common/auth/principal.js';
import { RawUpload, uploadContentType } from '../../common/http/raw-upload.js';

import { LocalStorageService } from './local-storage.service.js';

import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * `GET|HEAD|PUT /api/v1/storage/local/<key>?…&sig=…`: signed URLs issued by
 * `LocalStorageDriver`. The wildcard captures keys containing `/`, `..` or
 * encoded separators so that they are rejected with 422 rather than routed.
 * The signature authorises the request; the session is never consulted.
 */
@Controller('storage/local')
@Public({ ignoreSession: true })
export class LocalStorageController {
  constructor(@Inject(LocalStorageService) private readonly service: LocalStorageService) {}

  @Put('*')
  @RawUpload()
  async upload(
    @Param('*') key: unknown,
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const info = await this.service.upload(keyOf(key), query, {
      contentType: uploadContentType(request),
      contentLength: request.headers['content-length'],
      // No body at all (Content-Length: 0 without a parser run) = empty file.
      body: request.body instanceof Readable ? request.body : Readable.from([]),
    });
    if (info.etag !== null) void reply.header('etag', info.etag);
  }

  @Get('*')
  async download(
    @Param('*') key: unknown,
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const range = request.headers.range;
    const file = await this.service.download(
      request.method,
      keyOf(key),
      query,
      typeof range === 'string' ? range : undefined,
    );
    if ('unsatisfiable' in file) {
      await reply
        .status(416)
        .header('content-range', `bytes */${String(file.size)}`)
        .header('accept-ranges', 'bytes')
        .send();
      return;
    }
    if (file.range !== null) {
      void reply
        .status(206)
        .header(
          'content-range',
          `bytes ${String(file.range.start)}-${String(file.range.end)}/${String(file.size)}`,
        );
    }
    const length = file.range === null ? file.size : file.range.end - file.range.start + 1;
    await reply
      .header('content-type', file.contentType)
      .header('content-length', String(length))
      .header('accept-ranges', 'bytes')
      .header('content-disposition', file.contentDisposition)
      .header('etag', file.etag)
      .header('cache-control', 'private, no-store')
      // Same origin as the app (T406): never sniffed, never scripted, even when inline.
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', 'sandbox')
      .header('referrer-policy', 'no-referrer')
      .send(file.stream);
  }
}

/** The Fastify wildcard parameter (`*`), already percent-decoded. */
function keyOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
