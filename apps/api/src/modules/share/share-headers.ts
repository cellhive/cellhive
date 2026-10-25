import type { FastifyInstance } from 'fastify';

/** Prefix of the public share API (SPEC §15A.3). */
export const SHARE_API_PREFIX = '/api/v1/shares/';

/**
 * Headers of every `/api/v1/shares/*` response, errors included (SPEC
 * §15A.3): not indexed, no `Referer` leaking the token to other sites, not
 * stored by shared caches. The `/s/*` pages get the same from nginx
 * (`infra/docker/web/share-page-headers.conf.template`).
 */
export const SHARE_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

/** `onSend` hook: runs after helmet and the handlers, so these values win. */
export function registerShareResponseHeaders(fastify: FastifyInstance): void {
  fastify.addHook('onSend', (request, reply, payload, done) => {
    if (request.url.startsWith(SHARE_API_PREFIX)) {
      for (const [name, value] of Object.entries(SHARE_RESPONSE_HEADERS)) {
        void reply.header(name, value);
      }
    }
    done(null, payload);
  });
}
