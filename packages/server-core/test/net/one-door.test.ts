import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

/**
 * Folders whose outbound calls go to user-configured URLs: they must go
 * through `net/**` (BACKLOG S5c "Một cửa cho mạng ra", ADR-35 §3).
 */
const GUARDED_FOLDERS = ['automation', 'http-out', 'webhooks'];

/**
 * Files allowed to open connections themselves, with the reason. The
 * Telegram Bot API client talks to one fixed host (`api.telegram.org` or
 * the configured `TELEGRAM_API_URL`), never to a user URL.
 */
const ALLOWED = new Set(['automation/actions/send-telegram/telegram-client.ts']);

const FORBIDDEN = [/from ['"]node:https?['"]/u, /\bfetch\(/u, /from ['"]node:net['"]/u];

function filesUnder(folder: string): string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder).flatMap((name) => {
    const full = path.join(folder, name);
    if (statSync(full).isDirectory()) return filesUnder(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

describe('one door for outbound HTTP (S5c conventions)', () => {
  it('no module of automation/, http-out/, webhooks/ opens connections outside net/', () => {
    const offenders = GUARDED_FOLDERS.flatMap((folder) => filesUnder(path.join(SRC, folder)))
      .map((file) => path.relative(SRC, file).split(path.sep).join('/'))
      .filter((file) => !ALLOWED.has(file))
      .filter((file) => {
        const text = readFileSync(path.join(SRC, file), 'utf8');
        return FORBIDDEN.some((pattern) => pattern.test(text));
      });
    expect(offenders).toEqual([]);
  });

  it('still sees the allowed Telegram client (the scan is not vacuous)', () => {
    const text = readFileSync(path.join(SRC, [...ALLOWED][0] ?? ''), 'utf8');
    expect(FORBIDDEN.some((pattern) => pattern.test(text))).toBe(true);
  });
});
