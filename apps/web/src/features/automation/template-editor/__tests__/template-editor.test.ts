import { describe, expect, it } from 'vitest';

import {
  commandOfShortcut,
  MARKDOWN_COMMANDS,
  sourceLength,
  TOOLBAR_GROUPS,
} from '../markdown-commands';
import { previewDocument, previewPolicy } from '../preview-document';

/** T522: toolbar commands of the Markdown template editor and the sandboxed preview document. */

describe('markdown commands', () => {
  it.each([
    ['b', 'bold'],
    ['B', 'bold'],
    ['i', 'italic'],
    ['k', 'link'],
    ['u', null],
  ])('Ctrl+%s → %s', (key, command) => {
    expect(commandOfShortcut(key)).toBe(command);
  });

  it('inserts narrow Markdown syntax only (no HTML)', () => {
    for (const command of Object.values(MARKDOWN_COMMANDS)) {
      const text = command.kind === 'wrap' ? `${command.before}${command.after}` : command.text;
      expect(text).not.toContain('<');
    }
    expect(TOOLBAR_GROUPS.flat()).toHaveLength(Object.keys(MARKDOWN_COMMANDS).length);
  });

  it('counts the stored source like the contract', () => {
    expect(sourceLength('Chào {{ [fld_A] }}')).toBe(18);
  });
});

const CSS = 'http://localhost/assets/email-preview-frame.css';

describe('preview document', () => {
  const html =
    '<!doctype html><html lang="vi"><head><meta charset="utf-8"><style>p{color:red}</style>' +
    '<script>parent.alert(1)</script><base href="https://evil.example/"></head>' +
    '<body style="margin:0"><table style="width:100%"><tr><td style="padding:24px">' +
    '<p style="margin:0">Xin chào &lt;script&gt;alert(1)&lt;/script&gt;</p>' +
    '<a href="https://example.com" onclick="steal()">link</a>' +
    '<p>a style=&quot;x&quot; style=y</p>' +
    '<img src="https://tracker.example/p.gif" onerror="x()">' +
    '<form action="https://evil.example"><input name="a"></form>' +
    '</td></tr></table></body></html>';
  const doc = previewDocument(html, { stylesheet: CSS });
  const parsed = new DOMParser().parseFromString(doc, 'text/html');

  it('drops scripts, style elements and attributes, base, forms and handlers', () => {
    expect(parsed.querySelectorAll('script, style, base, form, [style]')).toHaveLength(0);
    expect(parsed.querySelector('[onclick], [onerror]')).toBeNull();
  });

  it('keeps record values as text', () => {
    const texts = [...parsed.querySelectorAll('p')].map((item) => item.textContent);
    expect(texts).toEqual(['Xin chào <script>alert(1)</script>', 'a style="x" style=y']);
  });

  it('puts its own CSP and the app stylesheet first in the head', () => {
    const [policy, sheet] = [...parsed.head.children];
    expect(policy?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(policy?.getAttribute('content')).toBe(previewPolicy(CSS));
    expect(sheet?.getAttribute('href')).toBe(CSS);
    expect(previewPolicy(CSS)).toBe(
      `default-src 'none'; style-src ${CSS}; img-src 'none'; form-action 'none'; base-uri 'none'`,
    );
    expect(doc.startsWith('<!doctype html>')).toBe(true);
  });

  it('loads no image without a signed URL for its Content-ID', () => {
    expect(parsed.querySelector('img')?.hasAttribute('src')).toBe(false);
  });
});

describe('preview document with inline images (T534)', () => {
  const STORAGE = 'https://storage.example:9000';
  const signed = (key: string) => `${STORAGE}/bucket/${key}?X-Amz-Signature=abc&X-Amz-Expires=60`;
  const html =
    '<!doctype html><html><head></head><body>' +
    '<img src="cid:asset-att_1@cellhive" alt="Logo" width="120">' +
    '<img src="CID:field-1@cellhive" alt="Ảnh" srcset="https://tracker.example/a.png 2x">' +
    '<img src="cid:unknown@cellhive" alt="x">' +
    '<img src="https://tracker.example/p.gif" alt="t">' +
    '<img src="cid:evil@cellhive" alt="e">' +
    '</body></html>';
  const images = [
    { cid: 'asset-att_1@cellhive', url: signed('a') },
    { cid: 'field-1@cellhive', url: signed('b') },
    { cid: 'evil@cellhive', url: 'javascript:alert(1)' },
  ];

  it.each<[string, string | null]>([
    ['Logo', signed('a')],
    ['Ảnh', signed('b')],
    ['x', null],
    ['t', null],
    ['e', null],
  ])('%s → %s', (alt, src) => {
    const doc = previewDocument(html, { stylesheet: CSS, images });
    const parsed = new DOMParser().parseFromString(doc, 'text/html');
    const image = parsed.querySelector(`img[alt="${alt}"]`);
    expect(image?.getAttribute('src') ?? null).toBe(src);
    expect(image?.hasAttribute('srcset')).toBe(false);
  });

  it('allows exactly the storage origin of the signed URLs', () => {
    const doc = previewDocument(html, { stylesheet: CSS, images });
    const parsed = new DOMParser().parseFromString(doc, 'text/html');
    const policy = parsed.head.firstElementChild?.getAttribute('content') ?? '';
    expect(policy).toBe(previewPolicy(CSS, [STORAGE]));
    expect(policy).toContain(`img-src ${STORAGE};`);
    expect(policy).not.toContain('tracker.example');
    expect(policy).not.toContain('data:');
  });

  it('keeps the width and alt of the email', () => {
    const doc = previewDocument(html, { stylesheet: CSS, images });
    const parsed = new DOMParser().parseFromString(doc, 'text/html');
    expect(parsed.querySelector('img[alt="Logo"]')?.getAttribute('width')).toBe('120');
  });
});
