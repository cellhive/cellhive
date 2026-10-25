import { createServer, type AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';

import { problemOf, startTestApp } from './support.js';

const TOKEN = 'metrics-token-0123456789abcdef-0123456789';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  return port;
}

describe('/metrics', () => {
  it('does not exist when neither METRICS_TOKEN nor METRICS_PORT is set', async () => {
    const t = await startTestApp();
    try {
      const response = await t.app.inject({ method: 'GET', url: '/metrics' });
      expect(response.statusCode).toBe(404);
      expect(problemOf(response.body).code).toBe('NOT_FOUND');
    } finally {
      await t.close();
    }
  });

  it('requires Authorization: Bearer <METRICS_TOKEN> on the main port', async () => {
    const t = await startTestApp({ METRICS_TOKEN: TOKEN });
    try {
      const missing = await t.app.inject({ method: 'GET', url: '/metrics' });
      expect(missing.statusCode).toBe(401);
      expect(problemOf(missing.body).code).toBe('UNAUTHENTICATED');

      const wrong = await t.app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: `Bearer ${TOKEN}x` },
      });
      expect(wrong.statusCode).toBe(401);

      const basic = await t.app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: `Basic ${TOKEN}` },
      });
      expect(basic.statusCode).toBe(401);

      await t.app.inject({ method: 'GET', url: '/healthz' });
      await t.app.inject({ method: 'GET', url: '/api/v1/unknown-route-12345' });
      const ok = await t.app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['content-type']).toMatch(/^text\/plain; version=0\.0\.4/);
      expect(ok.body).toContain('process_cpu_user_seconds_total');
      expect(ok.body).toMatch(
        /http_request_duration_seconds_count\{method="GET",route="\/healthz",status_code="200"\} \d+/,
      );
      // Unmatched paths share one label value; no ids or paths leak into labels.
      expect(ok.body).toContain('route="<unmatched>"');
      expect(ok.body).not.toContain('unknown-route-12345');
      expect(ok.body).not.toMatch(/req_[0-9A-Za-z]{16}/);
    } finally {
      await t.close();
    }
  });

  it('with METRICS_PORT is served only on that port (plus the token when both are set)', async () => {
    const port = await freePort();
    const t = await startTestApp({ METRICS_PORT: String(port), METRICS_TOKEN: TOKEN });
    try {
      const main = await t.app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(main.statusCode).toBe(404);

      const url = `http://127.0.0.1:${String(port)}/metrics`;
      const unauthorized = await fetch(url);
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get('content-type')).toContain('application/problem+json');
      await unauthorized.arrayBuffer();

      const ok = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(ok.status).toBe(200);
      expect(await ok.text()).toContain('http_request_duration_seconds');

      const other = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
      expect(other.status).toBe(404);
      await other.arrayBuffer();
    } finally {
      await t.close();
    }
    // The internal server is closed with the app.
    await expect(fetch(`http://127.0.0.1:${String(port)}/metrics`)).rejects.toThrow();
  });

  it('with only METRICS_PORT needs no token on the internal port', async () => {
    const port = await freePort();
    const t = await startTestApp({ METRICS_PORT: String(port) });
    try {
      const ok = await fetch(`http://127.0.0.1:${String(port)}/metrics`);
      expect(ok.status).toBe(200);
      await ok.arrayBuffer();
      expect((await t.app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });
});
