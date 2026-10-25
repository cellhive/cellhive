import { describe, expect, it } from 'vitest';

import { BEARER_CHALLENGE, bearerTokenOf } from '../../src/common/auth/api-token-auth.service.js';
import { principalKeyOf, type Principal } from '../../src/common/auth/principal.js';

import type { User } from '@cellhive/server-core';

describe('Authorization header parsing (T704, RFC 6750)', () => {
  it.each([
    ['Bearer cht_abc', 'cht_abc'],
    ['bearer cht_abc', 'cht_abc'],
    ['BEARER   cht_abc  ', 'cht_abc'],
    ['Bearer', undefined],
    ['Bearer ', undefined],
    ['Bearer a b', undefined],
    ['Basic dXNlcjpwYXNz', undefined],
    ['Token cht_abc', undefined],
    ['', undefined],
    ['Bearercht_abc', undefined],
  ])('%j → %j', (header, token) => {
    expect(bearerTokenOf(header)).toBe(token);
  });

  it('challenges with invalid_token', () => {
    expect(BEARER_CHALLENGE).toBe('Bearer error="invalid_token"');
  });
});

describe('principalKeyOf', () => {
  const user = { id: 'usr_PrincipalKey0001' } as unknown as User;
  it('keys tokens by token and sessions by user', () => {
    const token: Principal = {
      kind: 'api_token',
      userId: user.id,
      user,
      organizationId: 'org_PrincipalKey0001',
      tokenId: 'tok_PrincipalKey0001',
      scopes: ['records:read'],
      baseIds: null,
    };
    expect(principalKeyOf(token)).toBe('tok_PrincipalKey0001');
    expect(principalKeyOf({ kind: 'session', userId: user.id, user, session: {} as never })).toBe(
      'usr_PrincipalKey0001',
    );
  });
});
