import { ATTACHMENT_THUMBNAIL_CACHE_SECONDS } from '@cellhive/contracts';

import type { FileRedirect } from './file.service.js';
import type { FastifyReply } from 'fastify';
import type { Readable } from 'node:stream';

/**
 * `302` to a signed storage URL (downloads, thumbnails not rendered yet):
 * never cached, no `Referer` to the storage host, not sniffed (CONTRACTS
 * §20). Shared by `/files/*` and `/shares/:token/files/*` (T409).
 */
export async function sendFileRedirect(reply: FastifyReply, target: FileRedirect): Promise<void> {
  await reply
    .status(302)
    .header('location', target.url)
    .header('cache-control', 'private, no-store')
    .header('referrer-policy', 'no-referrer')
    .header('x-content-type-options', 'nosniff')
    .send();
}

/**
 * A thumbnail (BACKLOG T407): the WebP streamed by the API itself (same
 * origin: never sniffed nor scripted), or a redirect to the original.
 */
export async function sendThumbnail(
  reply: FastifyReply,
  thumbnail: { readonly stream: Readable } | FileRedirect,
): Promise<void> {
  if ('url' in thumbnail) {
    await sendFileRedirect(reply, thumbnail);
    return;
  }
  await reply
    .status(200)
    .header('content-type', 'image/webp')
    .header('content-disposition', 'inline; filename="thumbnail.webp"')
    .header('cache-control', `private, max-age=${String(ATTACHMENT_THUMBNAIL_CACHE_SECONDS)}`)
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; sandbox")
    .header('cross-origin-resource-policy', 'same-origin')
    .header('referrer-policy', 'no-referrer')
    .send(thumbnail.stream);
}
