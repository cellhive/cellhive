import { describe, expect, it } from 'vitest';

import { loginPathFor, safeNextPath } from '../safe-next';

describe('safeNextPath (no open redirect, FRONTEND §2)', () => {
  it.each([
    ['/o/acme', '/o/acme'],
    ['/b/bse_1?record=rec_1#x', '/b/bse_1?record=rec_1#x'],
    ['/invite/abc', '/invite/abc'],
    ['/o/../b/x', '/b/x'],
    ['/./o/acme', '/o/acme'],
    ['/./%2fevil.example', '/%2fevil.example'],
    ['/', '/'],
  ])('accepts internal path %j', (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });

  it.each([
    [null],
    [undefined],
    [''],
    ['https://evil.example/'],
    ['//evil.example/path'],
    ['/\\evil.example'],
    ['\\\\evil.example'],
    ['javascript:alert(1)'],
    ['/\t/evil.example'],
    ['/\n/evil.example'],
    ['o/acme'],
    ['/login'],
    ['/login?next=/o/acme'],
    // Dot segments that normalise into a protocol-relative path.
    ['/.//evil.example'],
    ['/a/..//evil.example'],
    ['/..//evil.example'],
    ['/a/b/../..//evil.example'],
    ['/%2e//evil.example'],
    ['/%2E//evil.example'],
    ['/.%2e//evil.example'],
    ['/a/%2e%2E//evil.example'],
    ['/./\\evil.example'],
    ['/.\\/evil.example'],
    ['/%2e/\\evil.example'],
    ['/.///evil.example'],
    ['/./\\/evil.example'],
    ['/.//evil.example?x=1#y'],
  ])('rejects %j', (input) => {
    expect(safeNextPath(input)).toBeNull();
  });
});

describe('loginPathFor', () => {
  it.each([
    [{ pathname: '/o/acme', search: '' }, '/login?next=%2Fo%2Facme'],
    [
      { pathname: '/b/bse_1', search: '?record=rec_1' },
      '/login?next=%2Fb%2Fbse_1%3Frecord%3Drec_1',
    ],
    [{ pathname: '/', search: '' }, '/login'],
  ])('%j → %s', (location, expected) => {
    expect(loginPathFor(location)).toBe(expected);
  });
});
