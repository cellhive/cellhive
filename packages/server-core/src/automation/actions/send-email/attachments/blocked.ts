import { fileExtensionOf } from '@cellhive/field-types';

/**
 * Extensions an automation email never attaches (BACKLOG T532, Quyết định
 * S5 email #4): the list Gmail refuses (a message carrying one is bounced
 * whole — "File types blocked in Gmail"), plus HTML and SVG files, a common
 * phishing vector. Checked on top of the field's own `blocked_extensions`,
 * which only applied at upload time.
 */
export const EMAIL_BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  // Gmail
  'ade',
  'adp',
  'apk',
  'appx',
  'appxbundle',
  'bat',
  'cab',
  'chm',
  'cmd',
  'com',
  'cpl',
  'diagcab',
  'diagcfg',
  'diagpkg',
  'dll',
  'dmg',
  'ex',
  'ex_',
  'exe',
  'hta',
  'img',
  'ins',
  'iso',
  'isp',
  'jar',
  'jnlp',
  'js',
  'jse',
  'lib',
  'lnk',
  'mde',
  'mjs',
  'msc',
  'msi',
  'msix',
  'msixbundle',
  'msp',
  'mst',
  'nsh',
  'pif',
  'ps1',
  'scr',
  'sct',
  'shb',
  'sys',
  'vb',
  'vbe',
  'vbs',
  'vhd',
  'vxd',
  'wsc',
  'wsf',
  'wsh',
  'xll',
  // HTML and SVG
  'html',
  'htm',
  'xhtml',
  'svg',
]);

/** MIME types (sniffed at upload) refused whatever the file is called, with their short name. */
const BLOCKED_MIME_TYPES: ReadonlyMap<string, string> = new Map([
  ['text/html', 'html'],
  ['application/xhtml+xml', 'xhtml'],
  ['image/svg+xml', 'svg'],
]);

/**
 * The extension that keeps a file out of an automation email (`html`,
 * `exe`…), or `null` when it may be attached. A blocked MIME type reports
 * its short name (`html`, `xhtml`, `svg`).
 */
export function blockedEmailExtension(filename: string, mime: string): string | null {
  const extension = fileExtensionOf(filename);
  if (EMAIL_BLOCKED_EXTENSIONS.has(extension)) return extension;
  const type = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  return BLOCKED_MIME_TYPES.get(type) ?? null;
}
