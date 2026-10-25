import { describe, expect, it } from 'vitest';

import { auditContextOf, requestMetaOf } from '../../src/common/auth/request-meta.js';

import type { Principal } from '../../src/common/auth/principal.js';
import type { Id } from '@cellhive/contracts';
import type { FastifyRequest } from 'fastify';

const USER = 'usr_editor000000000' as Id<'usr'>;
const OTHER = 'usr_other0000000000' as Id<'usr'>;
const TOKEN = 'tok_crm0000000000000' as Id<'tok'>;
const REQUEST_ID = 'req_0000000000000001';

function requestWith(principal: Partial<Principal> | undefined): FastifyRequest {
  return {
    id: REQUEST_ID,
    ip: '203.0.113.7',
    headers: { 'user-agent': 'curl/8' },
    principal,
  } as unknown as FastifyRequest;
}

const tokenPrincipal = { kind: 'api_token', userId: USER, tokenId: TOKEN } as const;

/** BACKLOG T705 (ADR-36 §1, S6 decision #5): the source of a change made through a token. */
describe('auditContextOf through an API token', () => {
  it('keeps the user as actor and adds via.api_token_id', () => {
    const context = auditContextOf(requestMetaOf(requestWith(tokenPrincipal)), {
      type: 'user',
      id: USER,
    });
    expect(context).toEqual({
      actor: { type: 'user', id: USER },
      via: { api_token_id: TOKEN },
      batch_id: null,
      request_id: REQUEST_ID,
      ip: '203.0.113.7',
      user_agent: 'curl/8',
    });
  });

  it.each([
    ['a session', { kind: 'session', userId: USER } as const, { type: 'user', id: USER } as const],
    ['anonymous', undefined, { type: 'user', id: USER } as const],
    ['another actor of a token request', tokenPrincipal, { type: 'user', id: OTHER } as const],
    ['the system', tokenPrincipal, { type: 'system', id: null } as const],
  ])('%s: no via', (_name, principal, actor) => {
    expect(auditContextOf(requestMetaOf(requestWith(principal)), actor).via).toBeNull();
  });
});
