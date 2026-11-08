// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Code adapted from Lucian UX/UI Prompt (MIT, BACKLOG S9 decisions #4–#5,
 * FRONTEND §9.3 "Lucian UX/UI") is copied source, not a package: the
 * dependency license check cannot see it. Every adapted file starts with the
 * license line of its element, is listed below (and in THIRD_PARTY_NOTICES.md),
 * and its CSS takes every color from the Cellhive tokens.
 */
const PORTED: Readonly<Record<string, string>> = {
  'src/styles/lucian.css': 'theme tokens',
  'src/features/import/components/FieldMapper.tsx': '#130',
  'src/features/import/components/FieldMapper.css': '#130',
  'src/features/grid/bulk/SelectionDock.tsx': '#178',
  'src/features/grid/bulk/SelectionDock.css': '#178',
  'src/features/automation/builder/components/conditions/ConditionBranchBuilder.tsx': '#132',
  'src/features/automation/builder/components/conditions/ConditionBranchBuilder.css': '#132',
};

const WEB = fileURLToPath(new URL('..', import.meta.url));
const ROOT = join(WEB, '../..');

function licenseLine(element: string): string {
  const anchor = element.startsWith('#') ? element : '';
  return `/*! Lucian UX/UI Prompt ${element} · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/${anchor} */`;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : filesUnder(path);
    return /\.(?:tsx?|css)$/u.test(name) ? [path] : [];
  });
}

/** CSS without its comments (a license line or a note may name a color). */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//gu, '');
}

const HARD_CODED_COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/iu;

describe('Lucian UX/UI Prompt: license and tokens of the adapted code', () => {
  it.each(Object.entries(PORTED))('%s starts with the license line of %s', (file, element) => {
    const firstLine = readFileSync(join(WEB, file), 'utf8').split('\n')[0];
    expect(firstLine).toBe(licenseLine(element));
  });

  it('lists every file that names Lucian, uses its --ux-* tokens or renders a `ux uNNN` root', () => {
    const found = filesUnder(join(WEB, 'src'))
      .filter((path) => /Lucian UX\/UI Prompt|--ux-|"ux u\d{3}\b/u.test(readFileSync(path, 'utf8')))
      .map((path) => relative(WEB, path).split('\\').join('/'));
    // A screen that only uses a ported component (MappingStep) has none of these.
    expect(found.sort()).toEqual(Object.keys(PORTED).sort());
  });

  it.each(Object.keys(PORTED).filter((file) => file.endsWith('.css')))(
    '%s has no hard-coded color',
    (file) => {
      const css = withoutComments(readFileSync(join(WEB, file), 'utf8'));
      expect(css.match(HARD_CODED_COLOR)?.[0]).toBeUndefined();
    },
  );

  it('ships the MIT text and names every element in THIRD_PARTY_NOTICES.md', () => {
    const license = readFileSync(join(WEB, 'licenses/lucian-uxui-prompt-MIT.txt'), 'utf8');
    expect(license).toContain('Copyright (c) 2026 Seokwoooo');
    expect(license).toContain('Permission is hereby granted, free of charge');
    const dockerfile = readFileSync(join(ROOT, 'infra/docker/web.Dockerfile'), 'utf8');
    expect(dockerfile).toContain(
      'cp apps/web/licenses/lucian-uxui-prompt-MIT.txt apps/web/dist/licenses/lucian-uxui-prompt-MIT.txt',
    );
    const notices = readFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    for (const [file, element] of Object.entries(PORTED)) {
      if (element.startsWith('#')) expect(notices).toContain(`| ${element} |`);
      expect(notices).toContain(file.split('/').pop() ?? file);
    }
  });
});
