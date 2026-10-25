import { expect, test } from '@playwright/test';

/**
 * T305 (SPEC §15A.3): share pages and the share API are never indexed and
 * never send a `Referer` carrying the token. Checked through the E2E stack
 * (`vite preview` sends the headers nginx sends in production; the API
 * sets its own on `/api/v1/shares/*`). `/s/*` serves the share entry
 * `share.html` (T317).
 */
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ABCDE';

test('share page /s/:token: noindex, no referrer', async ({ request }) => {
  const response = await request.get(`/s/${TOKEN}`);
  expect(response.status()).toBe(200);
  const headers = response.headers();
  expect(headers['x-robots-tag']).toBe('noindex, nofollow');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(await response.text()).toContain('<meta name="robots" content="noindex, nofollow"');

  // Other pages keep the default policy and may be indexed.
  const home = (await request.get('/')).headers();
  expect(home['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(home['x-robots-tag']).toBeUndefined();
});

test('share API: noindex, no referrer, no-store, errors included', async ({ request }) => {
  const response = await request.get(`/api/v1/shares/${TOKEN}/meta`);
  expect(response.status()).toBe(404);
  expect(response.headers()).toMatchObject({
    'x-robots-tag': 'noindex, nofollow',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  });
});
