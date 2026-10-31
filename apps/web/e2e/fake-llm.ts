import { once } from 'node:events';
import { connect, createServer, type Server } from 'node:net';

/**
 * The fake AI provider of the E2E stack (BACKLOG T912, CONTRACTS §29.7):
 * `startFakeOpenAiServer` of `@cellhive/server-core/testing` (T905) — an
 * OpenAI-compatible server on a free loopback port answering
 * deterministically (`GET /v1/models` lists `fake-model`; a JSON answer is the
 * smallest value of the schema asked for). No request leaves the machine.
 *
 * The global setup starts one for the whole run and publishes its base URL
 * (`http://localhost:<port>/v1`) in {@link FAKE_LLM_ENV}; the worker fixture
 * points each worker organization at it (`useFakeLlm` of `fixtures.ts`). Scripted
 * replies (`POST /__script`) are one queue for every worker, so a spec that
 * needs exact answers starts a provider of its own (`startOwnFakeLlm`, in the
 * worker's process: `script`, `chatRequests`) and points its worker's
 * organization at it while it runs (T913, `t913-ai-formula-automation.spec.ts`).
 */

/** Name of the variable through which the global setup hands the base URL to the workers. */
export const FAKE_LLM_ENV = 'CELLHIVE_E2E_FAKE_LLM';
/** The one model the fake provider lists. */
export const FAKE_LLM_MODEL = 'fake-model';

/** What a spec drives on a fake provider of its own (`FakeOpenAiServer` of server-core). */
export interface FakeLlm {
  readonly port: number;
  readonly baseUrl: string;
  /** Answers of the next chat calls, in order (`FakeOpenAiReply`: `content`, `status`, `delayMs`…). */
  script(...replies: Record<string, unknown>[]): void;
  /** The `POST /v1/chat/completions` requests received so far. */
  chatRequests(): { readonly body: Record<string, unknown> | null }[];
  close(): Promise<void>;
}

/** The base URL of the fake provider (`http://localhost:<port>/v1`). */
export function fakeLlmBaseUrl(): string {
  const url = process.env[FAKE_LLM_ENV];
  if (url === undefined)
    throw new Error('The E2E global setup did not start the fake AI provider.');
  return url;
}

/** `localhost:<port>`: the allowlist entry that lets the API call it (a loopback host, exact port). */
export function fakeLlmHost(): string {
  return new URL(fakeLlmBaseUrl()).host;
}

async function listen(server: Server, port: number, host: string): Promise<void> {
  server.listen(port, host);
  await Promise.race([
    once(server, 'listening'),
    once(server, 'error').then(([error]) => Promise.reject(error as Error)),
  ]);
}

/**
 * Starts a fake provider. It listens on 127.0.0.1 while its URL says
 * `localhost`, and the API pins the first address `localhost` resolves to —
 * `::1` first on many machines (macOS) — so the same port on `::1` forwards
 * to it (T906 hand-off): the API reaches it whichever address it pins.
 */
export async function startOwnFakeLlm(): Promise<FakeLlm> {
  const testing = (await import(
    new URL('../../../packages/server-core/dist/ai/testing/fake-openai-server.js', import.meta.url)
      .href
  )) as { startFakeOpenAiServer: () => Promise<FakeLlm> };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const fake = await testing.startFakeOpenAiServer();
    const forward = createServer((socket) => {
      const upstream = connect(fake.port, '127.0.0.1');
      socket.pipe(upstream).pipe(socket);
      socket.on('error', () => upstream.destroy());
      upstream.on('error', () => socket.destroy());
    });
    try {
      await listen(forward, fake.port, '::1');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // The port is taken on ::1: another one.
      if (code === 'EADDRINUSE') {
        await fake.close();
        continue;
      }
      // No IPv6 loopback: `localhost` is 127.0.0.1 only.
      return fake;
    }
    return {
      port: fake.port,
      baseUrl: fake.baseUrl,
      script: (...replies) => {
        fake.script(...replies);
      },
      chatRequests: () => fake.chatRequests(),
      close: async () => {
        forward.close();
        await fake.close();
      },
    };
  }
  throw new Error('No loopback port free on both 127.0.0.1 and ::1 for the fake AI provider.');
}

/** Starts the fake provider of the whole run (global setup) and publishes its URL to the workers. */
export async function startFakeLlm(): Promise<() => Promise<void>> {
  const fake = await startOwnFakeLlm();
  process.env[FAKE_LLM_ENV] = fake.baseUrl;
  return () => fake.close();
}
