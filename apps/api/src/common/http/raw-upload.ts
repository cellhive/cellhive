import { RouteConfig } from '@nestjs/platform-fastify';

import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Routes marked `@RawUpload()` receive the request body as an unparsed
 * stream, whatever its Content-Type (file uploads). Fastify selects body
 * parsers by Content-Type for the whole app, so the `onRequest` hook swaps the
 * header of these routes for a private type that has a pass-through parser and
 * keeps the original value for the handler (`uploadContentType`).
 */
const RAW_UPLOAD_CONTENT_TYPE = 'application/x-cellhive-raw-upload';

declare module 'fastify' {
  interface FastifyContextConfig {
    rawUpload?: boolean;
  }
}

const originalContentTypes = new WeakMap<FastifyRequest, string | undefined>();

export const RawUpload = (): MethodDecorator => RouteConfig({ rawUpload: true });

/** The Content-Type the client sent to a `@RawUpload()` route. */
export function uploadContentType(request: FastifyRequest): string | undefined {
  return originalContentTypes.get(request);
}

export function registerRawUploadSupport(fastify: FastifyInstance): void {
  fastify.addContentTypeParser(RAW_UPLOAD_CONTENT_TYPE, (_request, payload, done) => {
    done(null, payload);
  });
  fastify.addHook('onRequest', (request, _reply, done) => {
    if (request.routeOptions.config.rawUpload === true) {
      originalContentTypes.set(request, request.headers['content-type']);
      request.raw.headers['content-type'] = RAW_UPLOAD_CONTENT_TYPE;
    }
    done();
  });
}
