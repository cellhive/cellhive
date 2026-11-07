import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * T902 (FRONTEND §8.2): a lazy chunk that fails to load is retried once and
 * then shows an error with "Try again", never a blank page — so every route
 * `lazy` goes through `lazyRoute` and every lazy component through
 * `lazyPanel` or `lazyOverlay` (`src/lib/lazy/`). A file that must keep a
 * plain one is listed here (path under `src/`, e.g. `app/router.tsx`) with
 * the reason.
 */
const ALLOWED: Record<string, string> = {};

const SRC = join(import.meta.dirname, '../src');

/** Source files of the app, without tests and the helpers themselves. */
const files = (readdirSync(SRC, { recursive: true }) as string[])
  .filter(
    (file) =>
      /\.tsx?$/u.test(file) &&
      !file.includes('__tests__') &&
      !/\.test\.tsx?$/u.test(file) &&
      !file.startsWith(join('lib', 'lazy')) &&
      !(file in ALLOWED),
  )
  .map((file) => ({ file, text: readFileSync(join(SRC, file), 'utf8') }));

function plain(pattern: RegExp): string[] {
  return files.flatMap(({ file, text }) =>
    [...text.matchAll(pattern)].map(
      (match) => `${file}:${String(text.slice(0, match.index).split('\n').length)}`,
    ),
  );
}

describe('lazy chunks (T902)', () => {
  it('finds the app sources', () => {
    expect(files.some(({ file }) => file === join('app', 'router.tsx'))).toBe(true);
  });

  it('loads every lazy component through lazyPanel, never a plain React.lazy', () => {
    expect(
      plain(/\blazy\(/gu),
      'use lazyPanel / lazyOverlay (src/lib/lazy/chunk-error.tsx), or list the file in ALLOWED',
    ).toEqual([]);
  });

  it('loads every route through lazyRoute', () => {
    expect(
      plain(/\blazy:(?!\s*lazyRoute\()/gu),
      'wrap the route `lazy` in lazyRoute (src/lib/lazy/lazy-route.ts), or list the file in ALLOWED',
    ).toEqual([]);
  });
});
