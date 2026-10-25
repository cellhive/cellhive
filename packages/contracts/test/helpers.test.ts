import { describe, expect, it } from 'vitest';

import {
  ATTACHMENT_THUMBNAIL_MAX_INPUT_BYTES,
  attachmentHasThumbnail,
  attachmentThumbnailUrl,
  thumbnailQuerySchema,
  thumbnailSizeOf,
} from '../src/attachments.js';
import { automationEmailAssetUrl, orgEmailAssetUrl } from '../src/email-assets.js';
import { formCoverUrl, sharedFormCoverUrl } from '../src/form-covers.js';
import { isTemporaryHttpStatus } from '../src/http-deliveries.js';
import { isSensitiveWebhookHeader } from '../src/incoming-webhooks.js';
import { canonicalAllowedHosts } from '../src/secrets.js';

const FILE = 'att_A1b2C3d4E5f6G7h8';

describe('attachment thumbnails (CONTRACTS §2)', () => {
  it.each([
    ['image/png', 1, true],
    ['IMAGE/JPEG', 1024, true],
    ['image/gif', ATTACHMENT_THUMBNAIL_MAX_INPUT_BYTES, true],
    ['image/webp', ATTACHMENT_THUMBNAIL_MAX_INPUT_BYTES + 1, false],
    ['image/png', 0, false],
    ['image/svg+xml', 1024, false],
    ['application/pdf', 1024, false],
  ])('%s of %i bytes → thumbnail %s', (mime, size, expected) => {
    expect(attachmentHasThumbnail(mime, size)).toBe(expected);
    expect(attachmentThumbnailUrl(FILE, mime, size)).toBe(
      expected ? `/api/v1/files/${FILE}/thumbnail` : null,
    );
  });

  it.each([
    [{}, 256],
    [{ size: '256' }, 256],
    [{ size: '1280' }, 1280],
  ])('query %j → %i px', (query, expected) => {
    expect(thumbnailSizeOf(thumbnailQuerySchema.parse(query))).toBe(expected);
  });

  it('refuses other sizes', () => {
    expect(thumbnailQuerySchema.safeParse({ size: '512' }).success).toBe(false);
  });
});

describe('asset URLs', () => {
  it.each([
    [
      orgEmailAssetUrl('org_A1b2C3d4E5f6G7h8', 'eas_A1b2C3d4E5f6G7h8'),
      '/api/v1/orgs/org_A1b2C3d4E5f6G7h8/email-assets/eas_A1b2C3d4E5f6G7h8',
    ],
    [
      automationEmailAssetUrl('aut_A1b2C3d4E5f6G7h8', 'eas_A1b2C3d4E5f6G7h8'),
      '/api/v1/automations/aut_A1b2C3d4E5f6G7h8/email-assets/eas_A1b2C3d4E5f6G7h8',
    ],
    [
      formCoverUrl('viw_A1b2C3d4E5f6G7h8', FILE),
      `/api/v1/views/viw_A1b2C3d4E5f6G7h8/form-cover/${FILE}`,
    ],
    [sharedFormCoverUrl('tok-en_1', FILE), `/api/v1/shares/tok-en_1/form-cover/${FILE}`],
    // Path segments are percent-encoded, so an input can never add a segment.
    [orgEmailAssetUrl('a/b', '../c'), '/api/v1/orgs/a%2Fb/email-assets/..%2Fc'],
    [automationEmailAssetUrl('a?b', 'c#d'), '/api/v1/automations/a%3Fb/email-assets/c%23d'],
    [formCoverUrl('a/b', 'c d'), '/api/v1/views/a%2Fb/form-cover/c%20d'],
    [sharedFormCoverUrl('../x', 'y/z'), '/api/v1/shares/..%2Fx/form-cover/y%2Fz'],
  ])('%s', (actual, expected) => {
    expect(actual).toBe(expected);
  });
});

describe('isTemporaryHttpStatus (CONTRACTS §21)', () => {
  it.each([
    [200, false],
    [301, false],
    [400, false],
    [404, false],
    [408, true],
    [425, true],
    [429, true],
    [500, true],
    [501, false],
    [502, true],
    [503, true],
    [599, true],
    [600, false],
  ])('%i → %s', (status, expected) => {
    expect(isTemporaryHttpStatus(status)).toBe(expected);
  });
});

describe('isSensitiveWebhookHeader', () => {
  it.each([
    ['webhook-signature', true],
    ['Webhook-Signature', true],
    ['X-Telegram-Bot-Api-Secret-Token', true],
    ['x-cellhive-causation', true],
    ['content-type', false],
    ['x-request-id', false],
  ])('%s → %s', (name, expected) => {
    expect(isSensitiveWebhookHeader(name)).toBe(expected);
  });
});

describe('canonicalAllowedHosts (T701)', () => {
  it.each([
    [[], []],
    [['API.Example.com'], ['api.example.com']],
    [['api.example.com.', 'api.example.com'], ['api.example.com']],
    [
      ['b.example.com', 'a.example.com'],
      ['b.example.com', 'a.example.com'],
    ],
    [['*.Example.com', '*.example.com'], ['*.example.com']],
    [['bücher.example'], ['xn--bcher-kva.example']],
    [['not a host', 'ok.example.com'], ['ok.example.com']],
  ])('%j → %j', (hosts, expected) => {
    expect(canonicalAllowedHosts(hosts)).toEqual(expected);
  });
});
