import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every manifest of the workspace (`pnpm-workspace.yaml`: apps/*, packages/*, tools/*) and the
 * root one carry the release version and point at the public repository (BACKLOG T1023). The
 * release workflow refuses a tag whose `X.Y.Z` differs from the root `version`.
 */
const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const REPOSITORY_URL = 'git+https://github.com/cellhive/cellhive.git';

interface Manifest {
  readonly name?: string;
  readonly version?: string;
  readonly repository?: {
    readonly type?: string;
    readonly url?: string;
    readonly directory?: string;
  };
  readonly homepage?: string;
  readonly bugs?: { readonly url?: string };
}

function manifests(): { directory: string; manifest: Manifest }[] {
  const found = [{ directory: '', manifest: read('package.json') }];
  for (const group of ['apps', 'packages', 'tools']) {
    for (const entry of readdirSync(join(ROOT, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = `${group}/${entry.name}`;
      try {
        found.push({ directory, manifest: read(`${directory}/package.json`) });
      } catch {
        // A directory without a manifest is not a workspace package.
      }
    }
  }
  return found;
}

function read(path: string): Manifest {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as Manifest;
}

describe('package.json metadata (T1023)', () => {
  const all = manifests();
  const rootVersion = all[0]?.manifest.version;

  it('finds the root manifest and every workspace package', () => {
    expect(all.map((entry) => entry.manifest.name)).toEqual(
      expect.arrayContaining(['cellhive', '@cellhive/api', '@cellhive/web', '@cellhive/ci-tools']),
    );
    expect(rootVersion).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  it.each(
    all.map(({ directory, manifest }) => ({
      name: manifest.name ?? directory,
      directory,
      manifest,
    })),
  )('$name has the root version, the repository, homepage and bugs', ({ directory, manifest }) => {
    expect(manifest.version).toBe(rootVersion);
    expect(manifest.repository).toEqual({
      type: 'git',
      url: REPOSITORY_URL,
      ...(directory === '' ? {} : { directory }),
    });
    expect(manifest.homepage).toBe('https://github.com/cellhive/cellhive#readme');
    expect(manifest.bugs).toEqual({ url: 'https://github.com/cellhive/cellhive/issues' });
  });
});
