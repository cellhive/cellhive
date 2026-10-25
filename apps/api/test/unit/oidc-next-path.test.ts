import { OIDC_NEXT_MAX_LENGTH } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import { oidcNextPath } from '../../src/common/auth/oidc/next-path.js';

describe('oidcNextPath (no open redirect after OIDC sign-in, T707)', () => {
  it.each([
    ['/o/acme', '/o/acme'],
    ['/b/bse_1?record=rec_1#x', '/b/bse_1?record=rec_1#x'],
    ['/o/../b/x', '/b/x'],
    ['/./o/acme', '/o/acme'],
    ['/./%2fevil.test', '/%2fevil.test'],
    ['/', '/'],
  ])('accepts %j → %s', (input, expected) => {
    expect(oidcNextPath(input)).toBe(expected);
  });

  it.each([
    [undefined],
    [''],
    ['https://evil.test'],
    ['//evil.test/x'],
    ['/\\evil.test'],
    ['javascript:alert(1)'],
    ['/\t/evil.test'],
    ['o/acme'],
    ['/login'],
    ['/login?next=/x'],
    ['/api/v1/me'],
    ['/./api/v1/me'],
    [`/${'a'.repeat(OIDC_NEXT_MAX_LENGTH)}`],
    // Dot segments that normalise into a protocol-relative path.
    ['/.//evil.test'],
    ['/a/..//evil.test'],
    ['/..//evil.test'],
    ['/a/b/../..//evil.test'],
    ['/%2e//evil.test'],
    ['/%2E//evil.test'],
    ['/.%2e//evil.test'],
    ['/a/%2e%2E//evil.test'],
    ['/./\\evil.test'],
    ['/.\\/evil.test'],
    ['/%2e/\\evil.test'],
    ['/.///evil.test'],
    ['/./\\/evil.test'],
    ['/.//evil.test?x=1#y'],
  ])('%j → /', (input) => {
    expect(oidcNextPath(input)).toBe('/');
  });
});
