import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ENV_KEYS, loadConfig } from '../../src/config/index.js';

const ENV_EXAMPLE = new URL('../../../../.env.example', import.meta.url);

/** Minimal dotenv reader: `KEY=value` lines; blank lines and `#` comments ignored. */
function parseEnvFile(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(trimmed);
    if (match === null) {
      throw new Error(`.env.example line ${String(index + 1)} is not KEY=value`);
    }
    const [, key = '', value = ''] = match;
    if (entries.has(key)) {
      throw new Error(`.env.example defines ${key} twice`);
    }
    entries.set(key, value);
  }
  return entries;
}

describe('.env.example', () => {
  const entries = parseEnvFile(readFileSync(ENV_EXAMPLE, 'utf8'));

  it('lists exactly the variables of the zod schema (SPEC §20)', () => {
    expect([...entries.keys()].sort()).toEqual([...ENV_KEYS].sort());
  });

  it('is a valid development configuration', () => {
    const config = loadConfig(Object.fromEntries(entries));
    expect(config.nodeEnv).toBe('development');
    expect(config.storage.driver).toBe('s3');
  });
});
