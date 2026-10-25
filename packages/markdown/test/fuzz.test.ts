import { describe, expect, it } from 'vitest';

import {
  cleanText,
  escapeHtml,
  HTML_ALLOWED_TAGS,
  parseMarkdown,
  parseTemplate,
  substitute,
  toHtml,
  toText,
  type TemplateBlock,
} from '../src/index.js';

import { HOSTILE_VALUES, randomSource, seededRandom } from './fixtures.js';

const RUNS = 10_000;
/** Generous: the machine running CI may be loaded (S4b-review §7.1). */
const TIMEOUT = 120_000;

const TAG = /<(\/?)([^\s/>]+)((?:\s+[a-z-]+="[^"<>]*")*)\s*(\/?)>/gu;
const ALLOWED_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ['href', 'rel', 'target', 'style'],
};

/** What is wrong with `html`: tags or attributes outside the allowlist, unsafe links. */
function problemsOf(html: string): string[] {
  const problems: string[] = [];
  let tags = 0;
  for (const match of html.matchAll(TAG)) {
    tags += 1;
    const name = match[2] ?? '';
    if (!(HTML_ALLOWED_TAGS as readonly string[]).includes(name)) problems.push(`tag ${name}`);
    for (const attribute of (match[3] ?? '').matchAll(/([a-z-]+)="/gu)) {
      const allowed = ALLOWED_ATTRIBUTES[name] ?? ['style'];
      if (!allowed.includes(attribute[1] ?? '')) problems.push(`${name}[${attribute[1] ?? ''}]`);
    }
  }
  // Every `<` of the output starts an allowlisted tag; anything else was escaped.
  if (html.split('<').length - 1 !== tags) problems.push('stray <');
  for (const href of html.matchAll(/href="([^"]*)"/gu)) {
    if (!/^(?:https?:\/\/|mailto:)/iu.test(href[1] ?? '')) problems.push(`href ${href[1] ?? ''}`);
  }
  return problems;
}

/** Indexes of placeholders that are the whole target of a link. */
function wholeTargets(blocks: readonly TemplateBlock[]): Set<number> {
  const found = new Set<number>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const record = node as { type?: string; href?: unknown };
    if (record.type === 'link_template' && Array.isArray(record.href)) {
      const [only] = record.href as unknown[];
      if (record.href.length === 1 && typeof only === 'object' && only !== null) {
        found.add((only as { index: number }).index);
      }
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(blocks);
  return found;
}

function encoded(value: string): string | null {
  try {
    return encodeURIComponent(value);
  } catch {
    return null;
  }
}

describe('fuzz', () => {
  it(
    'random sources render only allowlisted markup',
    () => {
      const random = seededRandom(529);
      const failures: { source: string; problems: string[] }[] = [];
      for (let run = 0; run < RUNS; run += 1) {
        const source = randomSource(random);
        const blocks = parseMarkdown(source);
        const problems = problemsOf(toHtml(blocks));
        toText(blocks);
        if (problems.length > 0) failures.push({ source, problems });
      }
      expect(failures.slice(0, 5)).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'random templates keep hostile values as text',
    () => {
      const random = seededRandom(5290);
      const failures: { source: string; values: string[]; problems: string[] }[] = [];
      for (let run = 0; run < RUNS; run += 1) {
        const source = randomSource(random, true);
        const template = parseTemplate(source);
        const byIndex = new Map(
          template.placeholders.map((placeholder) => [
            placeholder.index,
            HOSTILE_VALUES[Math.floor(random() * HOSTILE_VALUES.length)] ?? '',
          ]),
        );
        const values = [...byIndex.values()];
        const blocks = substitute(
          template.blocks,
          (placeholder) => byIndex.get(placeholder.index) ?? '',
        );
        const html = toHtml(blocks);
        const text = toText(blocks);
        const problems = problemsOf(html);
        // Each value appears whole: escaped text in the HTML (or encoded in a link), as is in
        // the text — except a whole link target, which is dropped unless it is a safe URL.
        const targets = wholeTargets(template.blocks);
        for (const [index, value] of byIndex) {
          if (targets.has(index)) continue;
          const line = value.split(/\r\n?|\n/u)[0] ?? '';
          // Values with controls or lone surrogates are cleaned, not kept whole.
          if (line === '' || cleanText(line) !== line) continue;
          const inLink = html.includes(encoded(line) ?? '\u0000');
          if (!inLink && !html.includes(escapeHtml(line))) problems.push(`html lost ${line}`);
          if (!inLink && !text.includes(line)) problems.push(`text lost ${line}`);
        }
        if (problems.length > 0) failures.push({ source, values, problems });
      }
      expect(failures.slice(0, 5)).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'parses the largest email body quickly',
    () => {
      const random = seededRandom(7);
      const hostile = [
        '['.repeat(20_000),
        `${'['.repeat(19_000)}](https://a.test)`,
        '*a'.repeat(10_000),
        '**'.repeat(10_000),
        '`'.repeat(20_000),
        '~~a'.repeat(6_666),
        '| a '.repeat(5_000),
        '| a |\n'.repeat(3_333),
        '> '.repeat(10_000),
        '>\n'.repeat(10_000),
        '{{ "'.repeat(5_000),
        '{{ a }}'.repeat(2_800),
        ''.repeat(20_000),
        '[a](https://'.repeat(1_600),
        '- a\n'.repeat(5_000),
        Array.from({ length: 20_000 }, () => randomSource(random).charAt(0)).join(''),
      ];
      for (const source of hostile) {
        const started = performance.now();
        const template = parseTemplate(source);
        const blocks = substitute(template.blocks, []);
        toHtml(blocks);
        toText(blocks);
        expect(performance.now() - started, source.slice(0, 20)).toBeLessThan(5_000);
      }
    },
    TIMEOUT,
  );
});
