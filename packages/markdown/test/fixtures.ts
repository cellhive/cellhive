/**
 * Shared inputs for the fuzz tests here and in `server-core` (the
 * `sanitize-html` second layer must leave the renderer's output unchanged).
 */

/** Deterministic PRNG (mulberry32), so a failing run can be replayed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Values a record could hold that try to become markup, links or headers. */
export const HOSTILE_VALUES: readonly string[] = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  'javascript:alert(1)',
  'data:text/html;base64,PHNjcmlwdD4=',
  '[click](javascript:alert(1))',
  '[x](https://evil.test)',
  '**bold** _it_ ~~del~~',
  '| a | b |\n| - | - |',
  '# heading\n- item\n> quote',
  'line1\r\nBcc: victim@evil.test',
  '"><svg onload=alert(1)>',
  "' onmouseover='alert(1)",
  '{{ [Secret] }}',
  '`code` ```fence```',
  '&lt;b&gt; &amp;',
  'Tiếng Việt có dấu — 😀🇻🇳',
  'https://ok.test/path?q=1',
  'mailto:a@b.test',
  '\u0000\u0007\u001b[31m',
  '\uD800 lone surrogate',
  '',
];

const PIECES: readonly string[] = [
  'a',
  'b',
  'Việt',
  '😀',
  ' ',
  ' ',
  '\n',
  '\n\n',
  '\r\n',
  '\t',
  '*',
  '**',
  '_',
  '~~',
  '`',
  '```',
  '#',
  '## ',
  '- ',
  '1. ',
  '> ',
  '---',
  '|',
  ' | ',
  '| - |',
  '[',
  ']',
  '(',
  ')',
  '[x](https://a.test)',
  '[y](javascript:alert(1))',
  '[z](mailto:a@b.test)',
  '](',
  'https://',
  'data:',
  '\\',
  '\\*',
  '\\|',
  '<',
  '>',
  '&',
  '"',
  "'",
  '<script>',
  '</p>',
  '<img src=x onerror=1>',
  '&amp;',
  '&#60;',
  '\u0000',
  '\u001b',
  '\uD800',
  '',
];

const TEMPLATE_PIECES: readonly string[] = [
  '{{ a }}',
  '{{[Name]}}',
  '{{ "}}" }}',
  '{{',
  '}}',
  '{',
  '}',
  '\\{{',
  '[t](https://a.test/{{ id }})',
  '[t]({{ url }})',
  '[t](https://{{ h }}/)',
  '[{{ n }}](mailto:{{ e }})',
];

/** A random string of Markdown-significant pieces, up to ~60 pieces long. */
export function randomSource(random: () => number, template = false): string {
  const pool = template ? [...PIECES, ...TEMPLATE_PIECES, ...TEMPLATE_PIECES] : PIECES;
  const length = Math.floor(random() * 60);
  let source = '';
  for (let index = 0; index < length; index += 1) {
    source += pool[Math.floor(random() * pool.length)] ?? '';
  }
  return source;
}
