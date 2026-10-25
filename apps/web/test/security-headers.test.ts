// @vitest-environment node
import { readFileSync } from 'node:fs';

import { SHARE_EMBED_PAGE_PATH, webContentSecurityPolicy } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  CONTENT_SECURITY_POLICY,
  contentSecurityPolicy,
  isSharePagePath,
  SECURITY_HEADERS,
  SHARE_EMBED_LINK_HEADERS,
  SHARE_EMBED_PAGE_HEADERS,
  SHARE_PAGE_HEADERS,
  shareEmbedTokenOf,
  STORAGE_ORIGIN_VARIABLE,
} from '../security-headers';

const nginxHeaders = readFileSync(
  new URL('../../../infra/docker/web/security-headers.conf.template', import.meta.url),
  'utf8',
);

const nginxShareHeaders = readFileSync(
  new URL('../../../infra/docker/web/share-page-headers.conf.template', import.meta.url),
  'utf8',
);

/**
 * What nginx sends once the image's `envsubst` rendered the template with
 * `STORAGE_PUBLIC_ORIGIN` (T418; empty for the `local` driver).
 */
const nginxEmbedHeaders = readFileSync(
  new URL('../../../infra/docker/web/share-embed-headers.conf.template', import.meta.url),
  'utf8',
);

const nginxSite = readFileSync(
  new URL('../../../infra/docker/web/default.conf.template', import.meta.url),
  'utf8',
);

const TOKEN = 'a'.repeat(40) + '_-1';

function rendered(config: string, storageOrigin = ''): string {
  return config
    .replaceAll(`\${${STORAGE_ORIGIN_VARIABLE}}`, storageOrigin)
    .replaceAll(/ +;/gu, ';');
}

function nginxHeader(name: string, config: string = nginxHeaders): string | undefined {
  const pattern = new RegExp(`^add_header ${name} "([^"]*)" always;$`, 'gmu');
  const values = [...rendered(config).matchAll(pattern)].map((match) => match[1]);
  expect(values.length, `${name} is sent once`).toBeLessThanOrEqual(1);
  return values[0];
}

function nginxHeaderNames(config: string): string[] {
  return [...config.matchAll(/^add_header ([A-Za-z-]+) /gmu)].map((match) => match[1] ?? '');
}

describe('security headers', () => {
  it.each(Object.entries(SECURITY_HEADERS))(
    'nginx sends the same %s as vite preview',
    (name, value) => {
      expect(nginxHeader(name)).toBe(value);
    },
  );

  it.each(Object.entries(SHARE_PAGE_HEADERS))(
    'nginx sends the same %s on share pages (/s/*) as vite preview',
    (name, value) => {
      expect(nginxHeader(name, nginxShareHeaders)).toBe(value);
    },
  );

  it('share pages are not indexed and send no referrer (SPEC §15A.3)', () => {
    expect(SHARE_PAGE_HEADERS['X-Robots-Tag']).toBe('noindex, nofollow');
    expect(SHARE_PAGE_HEADERS['Referrer-Policy']).toBe('no-referrer');
    expect(nginxHeaderNames(nginxShareHeaders).sort()).toEqual(
      Object.keys(SHARE_PAGE_HEADERS).sort(),
    );
  });

  it('nginx serves /s/ with the share page headers', () => {
    const template = readFileSync(
      new URL('../../../infra/docker/web/default.conf.template', import.meta.url),
      'utf8',
    );
    const location = /location \/s\/ \{([^}]*)\}/u.exec(template)?.[1] ?? '';
    expect(location).toContain('include /etc/nginx/conf.d/snippets/share-page-headers.conf;');
    expect(location).not.toContain('security-headers.conf');
  });

  it('nginx serves /verify-sender from the share entry with the share page headers (T533)', () => {
    const template = readFileSync(
      new URL('../../../infra/docker/web/default.conf.template', import.meta.url),
      'utf8',
    );
    const location = /location = \/verify-sender \{([^}]*)\}/u.exec(template)?.[1] ?? '';
    expect(location).toContain('try_files /share.html =404;');
    expect(location).toContain('include /etc/nginx/conf.d/snippets/share-page-headers.conf;');
    expect(location).not.toContain('security-headers.conf');
  });

  it.each([
    ['/s/abc', true],
    ['/verify-sender', true],
    ['/verify-sender?token=org_x.y', true],
    ['/verify-sender/x', false],
    ['/verify-senders', false],
    ['/o/acme', false],
  ])('isSharePagePath(%s) = %s', (url, expected) => {
    expect(isSharePagePath(url)).toBe(expected);
  });

  it('allows no inline script, inline style element or foreign origin', () => {
    const directives = new Map(
      CONTENT_SECURITY_POLICY.split('; ').map((directive) => {
        const [name = '', ...values] = directive.split(' ');
        return [name, values];
      }),
    );
    expect(directives.get('script-src')).toEqual(["'self'"]);
    expect(directives.get('style-src')).toEqual(["'self'"]);
    expect(directives.get('default-src')).toEqual(["'self'"]);
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-(inline|eval)|https?:/u);
  });

  it('allows the object storage host for uploads, images and media only (T418)', () => {
    const origin = 'https://files.example.com';
    const policy = contentSecurityPolicy(origin);
    const directives = new Map(
      policy.split('; ').map((directive) => {
        const [name = '', ...values] = directive.split(' ');
        return [name, values];
      }),
    );
    expect(directives.get('img-src')).toEqual(["'self'", 'data:', 'blob:', origin]);
    expect(directives.get('media-src')).toEqual(["'self'", 'blob:', origin]);
    expect(directives.get('connect-src')).toEqual(["'self'", origin]);
    // Never framed, never scripted.
    expect(directives.get('script-src')).toEqual(["'self'"]);
    expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
    expect(directives.has('frame-src')).toBe(false);
    // nginx renders the same policy from STORAGE_PUBLIC_ORIGIN.
    const line = rendered(nginxHeaders, origin)
      .split('\n')
      .find((text) => text.startsWith('add_header Content-Security-Policy'));
    expect(line).toBe(`add_header Content-Security-Policy "${policy}" always;`);
  });

  it.each(Object.entries(SHARE_EMBED_PAGE_HEADERS))(
    'nginx sends the same %s on embedded share pages as vite preview (T809)',
    (name, value) => {
      expect(nginxHeader(name, nginxEmbedHeaders)).toBe(value);
    },
  );

  it('embedded share pages take only CSP and X-Frame-Options from the API (T809)', () => {
    expect(nginxHeaderNames(nginxEmbedHeaders).sort()).toEqual(
      Object.keys(SHARE_EMBED_PAGE_HEADERS).sort(),
    );
    expect([...Object.keys(SHARE_EMBED_PAGE_HEADERS), ...SHARE_EMBED_LINK_HEADERS].sort()).toEqual(
      Object.keys(SHARE_PAGE_HEADERS).sort(),
    );
    const location =
      new RegExp(`location = ${SHARE_EMBED_PAGE_PATH} \\{([^}]*)\\}`, 'u').exec(nginxSite)?.[1] ??
      '';
    expect(location).toContain('internal;');
    expect(location).toContain('try_files /share.html =404;');
    expect(location).toContain('include /etc/nginx/conf.d/snippets/share-embed-headers.conf;');
    expect(location).toContain(
      'add_header Content-Security-Policy $upstream_http_content_security_policy always;',
    );
    expect(location).toContain('add_header X-Frame-Options $upstream_http_x_frame_options always;');
    expect(location).not.toContain('security-headers.conf');
    expect(location).not.toContain('share-page-headers.conf');
  });

  it('nginx asks the API for the headers of /s/{token}?embed=1 only (T809)', () => {
    expect(nginxSite).toMatch(/map \$arg_embed \$share_page_embed \{\s+default 0;\s+1\s+1;\s+\}/u);
    expect(nginxSite).toContain(
      'rewrite "^/s/([A-Za-z0-9_-]{43})/?$" /api/v1/shares/$1/page last;',
    );
  });

  it.each([
    [`/s/${TOKEN}?embed=1`, TOKEN],
    [`/s/${TOKEN}/?embed=1`, TOKEN],
    [`/s/${TOKEN}?x=2&embed=1#top`, TOKEN],
    [`/s/${TOKEN}`, null],
    [`/s/${TOKEN}?embed=0`, null],
    [`/s/${TOKEN}?embed=true`, null],
    [`/s/${TOKEN}x?embed=1`, null],
    [`/s/${TOKEN}/files?embed=1`, null],
    ['/s/short?embed=1', null],
    [`/o/${TOKEN}?embed=1`, null],
  ])('shareEmbedTokenOf(%s) = %s', (url, expected) => {
    expect(shareEmbedTokenOf(url)).toBe(expected);
  });

  it.each([
    ['', []],
    ['https://files.example.com', []],
    ['', ['https://intranet.example.com']],
    ['https://files.example.com', ['https://a.example.com', 'http://localhost:8080']],
  ])('the API sends the same policy (storage %s, ancestors %j)', (storage, ancestors) => {
    expect(webContentSecurityPolicy(storage, ancestors)).toBe(
      contentSecurityPolicy(storage, ancestors),
    );
  });

  it('frame-ancestors lists the origins of an embeddable link', () => {
    expect(contentSecurityPolicy('', ['https://a.example.com', 'https://b.example.com'])).toMatch(
      /; frame-ancestors https:\/\/a\.example\.com https:\/\/b\.example\.com$/u,
    );
  });

  it('the web image renders the header snippets as templates', () => {
    const dockerfile = readFileSync(
      new URL('../../../infra/docker/web.Dockerfile', import.meta.url),
      'utf8',
    );
    expect(dockerfile).toContain('STORAGE_PUBLIC_ORIGIN=""');
    expect(dockerfile).toContain('/etc/nginx/templates/snippets/security-headers.conf.template');
    expect(dockerfile).toContain('/etc/nginx/templates/snippets/share-page-headers.conf.template');
    expect(dockerfile).toContain('/etc/nginx/templates/snippets/share-embed-headers.conf.template');
  });
});
