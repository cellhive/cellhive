import { describe, expect, it } from 'vitest';

import {
  demoAiAllowlistFor,
  demoAiProviderOf,
  looksInternal,
  type DemoAiProvider,
} from '../../src/seed/demo-ai.js';
import { SeedError } from '../../src/seed/seed-error.js';

/** Obviously fake: never a real provider key. */
const FAKE_KEY = 'sk-test-FAKE-0000000000000000';

const provider = (baseUrl: string, apiKey: string | null = null): DemoAiProvider => {
  const parsed = demoAiProviderOf({
    DEMO_AI_BASE_URL: baseUrl,
    DEMO_AI_MODEL: 'fake-model',
    ...(apiKey === null ? {} : { DEMO_AI_API_KEY: apiKey }),
  });
  if (parsed === null) throw new Error('no provider');
  return parsed;
};

const answering =
  (...addresses: string[]) =>
  (): Promise<readonly string[]> =>
    Promise.resolve(addresses);
const failing = (): Promise<readonly string[]> => Promise.reject(new Error('ENOTFOUND'));

/** BACKLOG T917 (CONTRACTS §9): the development-only `DEMO_AI_*` of `pnpm seed:demo`. */
describe('DEMO_AI_* of the demo seed (T917)', () => {
  it('is nothing when unset or blank: no AI, nothing resolved', () => {
    expect(demoAiProviderOf({})).toBeNull();
    expect(
      demoAiProviderOf({ DEMO_AI_BASE_URL: ' ', DEMO_AI_MODEL: '', DEMO_AI_API_KEY: '' }),
    ).toBeNull();
  });

  it.each([
    ['a model without a URL', { DEMO_AI_MODEL: 'fake-model' }, /go together/u],
    ['a URL without a model', { DEMO_AI_BASE_URL: 'http://localhost:11434/v1' }, /go together/u],
    ['a key alone', { DEMO_AI_API_KEY: FAKE_KEY }, /go together/u],
    [
      'another scheme',
      { DEMO_AI_BASE_URL: 'ftp://ollama/v1', DEMO_AI_MODEL: 'm' },
      /http\(s\) base URL/u,
    ],
    [
      'user info',
      { DEMO_AI_BASE_URL: 'http://u:p@ollama:11434/v1', DEMO_AI_MODEL: 'm' },
      /http\(s\) base URL/u,
    ],
    [
      'a query',
      { DEMO_AI_BASE_URL: 'http://ollama:11434/v1?key=x', DEMO_AI_MODEL: 'm' },
      /http\(s\) base URL/u,
    ],
    [
      'a model over 200 characters',
      { DEMO_AI_BASE_URL: 'http://ollama:11434/v1', DEMO_AI_MODEL: 'm'.repeat(201) },
      /at most 200/u,
    ],
    [
      'a key with a line break',
      {
        DEMO_AI_BASE_URL: 'https://ai.example.com/v1',
        DEMO_AI_MODEL: 'm',
        DEMO_AI_API_KEY: 'a\nb',
      },
      /printable ASCII/u,
    ],
    [
      'a loopback IP address',
      { DEMO_AI_BASE_URL: 'http://127.0.0.1:11434/v1', DEMO_AI_MODEL: 'm' },
      /host name/u,
    ],
    [
      'a private IP address',
      { DEMO_AI_BASE_URL: 'http://192.168.1.20/v1', DEMO_AI_MODEL: 'm' },
      /host name/u,
    ],
    [
      'a public IP address with a key',
      { DEMO_AI_BASE_URL: 'https://1.1.1.1/v1', DEMO_AI_MODEL: 'm', DEMO_AI_API_KEY: FAKE_KEY },
      /host name/u,
    ],
  ])('refuses %s before anything is created', (_name, env, message) => {
    expect(() => demoAiProviderOf(env)).toThrow(SeedError);
    expect(() => demoAiProviderOf(env)).toThrow(message);
  });

  it('never echoes the URL or the key in its errors', () => {
    const errors: string[] = [];
    for (const env of [
      { DEMO_AI_BASE_URL: 'http://user:secret-pass@ollama/v1', DEMO_AI_MODEL: 'm' },
      { DEMO_AI_BASE_URL: 'http://10.0.0.5/v1', DEMO_AI_MODEL: 'm', DEMO_AI_API_KEY: FAKE_KEY },
    ]) {
      try {
        demoAiProviderOf(env);
      } catch (error) {
        errors.push((error as Error).message);
      }
    }
    expect(errors).toHaveLength(2);
    expect(errors.join('\n')).not.toMatch(/secret-pass|10\.0\.0\.5|sk-test/u);
  });

  it('keeps the URL, the model and the key as given (trimmed)', () => {
    const parsed = provider(' http://localhost:11434/v1 ', FAKE_KEY);
    expect(parsed).toMatchObject({
      baseUrl: 'http://localhost:11434/v1',
      model: 'fake-model',
      apiKey: FAKE_KEY,
      url: { host: 'localhost', port: 11434 },
    });
  });

  it.each([
    'localhost',
    'app.localhost',
    'ollama',
    'macmini.local',
    'host.docker.internal',
    'nas.lan',
    'pi.home.arpa',
  ])('%s looks internal', (host) => {
    expect(looksInternal(host)).toBe(true);
  });

  it.each(['api.openai.com', 'openrouter.ai', 'llm.example.com'])('%s does not', (host) => {
    expect(looksInternal(host)).toBe(false);
  });

  it.each([
    // [URL, what DNS answers (null: no answer), entry expected]
    ['http://localhost:11434/v1', ['127.0.0.1', '::1'], 'localhost:11434'],
    ['http://ollama:11434/v1', ['172.18.0.4'], 'ollama:11434'],
    ['http://gpu.example.com/v1', ['10.1.2.3'], 'gpu.example.com:80'],
    ['https://gpu.tailnet.example.com/v1', ['100.101.102.103'], 'gpu.tailnet.example.com:443'],
    ['https://api.openai.com/v1', ['162.159.140.245'], null],
    ['https://llm.example.com:8443/v1', ['93.184.216.34'], 'llm.example.com:8443'],
    ['http://macmini.local:20128/v1', null, 'macmini.local:20128'],
    ['https://llm.example.com/v1', null, null],
    ['https://1.1.1.1/v1', null, null],
  ] as const)('%s with DNS %j → entry %s', async (url, addresses, entry) => {
    const result = await demoAiAllowlistFor(provider(url), {
      privateAllowlist: 'org',
      lookup: addresses === null ? failing : answering(...addresses),
    });
    expect(result.pattern).toBe(entry);
  });

  it('warns when the host does not resolve and gets no entry, or HTTP_PRIVATE_ALLOWLIST=off', async () => {
    const unresolved = await demoAiAllowlistFor(provider('https://llm.example.com/v1'), {
      privateAllowlist: 'org',
      lookup: failing,
    });
    expect(unresolved.warnings).toEqual([expect.stringContaining('did not resolve')]);
    const off = await demoAiAllowlistFor(provider('http://localhost:11434/v1'), {
      privateAllowlist: 'off',
      lookup: answering('127.0.0.1'),
    });
    expect(off.pattern).toBe('localhost:11434');
    expect(off.warnings).toEqual([expect.stringContaining('HTTP_PRIVATE_ALLOWLIST=off')]);
    const metadata = await demoAiAllowlistFor(provider('http://metadata.example.com/v1'), {
      privateAllowlist: 'org',
      lookup: answering('169.254.169.254'),
    });
    expect(metadata.warnings).toEqual([expect.stringContaining('never reachable')]);
  });
});
