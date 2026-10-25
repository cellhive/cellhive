import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { GRID_TOKENS, type GridTokens } from '../src/grid/theme';

// `import.meta.url` is not a file URL under jsdom; the directory is.
const tokensCss = readFileSync(resolve(import.meta.dirname, '../src/styles/tokens.css'), 'utf8');

/** Top-level rule blocks of `tokens.css` (not those inside `@media`): selector list and body. */
function topLevelBlocks(): { selectors: string[]; body: string }[] {
  const blocks: { selectors: string[]; body: string }[] = [];
  const css = tokensCss.replaceAll(/\/\*[\s\S]*?\*\//gu, '');
  let depth = 0;
  let start = 0;
  let open = 0;
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index];
    if (char === '{') {
      if (depth === 0) open = index;
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const prelude = css.slice(start, open).trim();
        if (!prelude.startsWith('@')) {
          blocks.push({
            selectors: prelude.split(',').map((selector) => selector.trim()),
            body: css.slice(open + 1, index),
          });
        }
        start = index + 1;
      }
    }
  }
  return blocks;
}

/**
 * Custom properties of the top-level blocks whose selector list names
 * `selector` (`:root` is split over several blocks, some shared with the
 * dashboard theme of T812), later blocks winning.
 */
function declarations(selector: string): Record<string, string> {
  const values: Record<string, string> = {};
  const blocks = topLevelBlocks().filter((block) => block.selectors.includes(selector));
  if (blocks.length === 0) throw new Error(`No ${selector} block in tokens.css`);
  for (const { body } of blocks) {
    for (const match of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/gu)) {
      const [, name = '', value = ''] = match;
      values[name] = value.trim();
    }
  }
  return values;
}

/**
 * The declarations (`name=value`, in order) of the explicit dark block and of
 * the system-preference dark block, which must stay copies of each other.
 */
export function darkBlocks(): { explicit: string[]; system: string[] } {
  const block = (marker: string) => {
    const start = tokensCss.indexOf(marker);
    const body = tokensCss.slice(tokensCss.indexOf('{', start) + 1, tokensCss.indexOf('}', start));
    return [...body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/gu)].map(
      (match) => `${match[1] ?? ''}=${(match[2] ?? '').trim()}`,
    );
  };
  return {
    explicit: block(":root[data-theme='dark']"),
    system: block(':root:not([data-theme])'),
  };
}

/** Every custom property of a theme (explicit `data-theme` blocks), by name without `--`. */
export function allThemeTokens(theme: 'light' | 'dark'): Record<string, string> {
  const light = declarations(':root');
  return theme === 'light' ? light : { ...light, ...declarations(":root[data-theme='dark']") };
}

/** The token values of a theme, as `readTokens` would read them from `<html>`. */
export function themeTokens(theme: 'light' | 'dark'): GridTokens {
  const light = declarations(':root');
  const values =
    theme === 'light' ? light : { ...light, ...declarations(":root[data-theme='dark']") };
  return Object.fromEntries(GRID_TOKENS.map((name) => [name, values[name] ?? ''])) as GridTokens;
}
