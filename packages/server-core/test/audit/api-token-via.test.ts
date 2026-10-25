import { describe, expect, it } from 'vitest';

import {
  shownViaOf,
  viaApiTokenIdsOf,
  type AuditApiTokenRef,
  type AuditViewer,
} from '../../src/audit/index.js';

import type { JsonValue } from '../../src/db/index.js';
import type { Id } from '@cellhive/contracts';

const EDITOR = 'usr_editor000000000' as Id<'usr'>;
const READER = 'usr_reader000000000' as Id<'usr'>;
const TOKEN = 'tok_crm0000000000000' as Id<'tok'>;
const GONE = 'tok_gone000000000000' as Id<'tok'>;

const tokens = new Map<string, AuditApiTokenRef>([
  [TOKEN, { id: TOKEN, name: 'CRM sync', user_id: EDITOR }],
]);

const row = (via: JsonValue | null, actorId: string | null = EDITOR) => ({
  via,
  actor_type: 'user' as const,
  actor_id: actorId,
});

const orgAdmin: AuditViewer = { userId: READER, isOrgAdmin: true };
const owner: AuditViewer = { userId: EDITOR, isOrgAdmin: false };
const other: AuditViewer = { userId: READER, isOrgAdmin: false };
const nobody: AuditViewer = { userId: null, isOrgAdmin: false };

const named = { api_token_id: TOKEN, api_token_name: 'CRM sync' };
const hidden = { api_token_id: null, api_token_name: null };

/** S6 decision #19, CONTRACTS §11.1: who sees which API token made a change. */
describe('shownViaOf', () => {
  it.each([
    [
      'org admin sees the token and its current name',
      row({ api_token_id: TOKEN }),
      orgAdmin,
      named,
    ],
    ['the token owner sees it', row({ api_token_id: TOKEN }), owner, named],
    ['another member sees "an API token" only', row({ api_token_id: TOKEN }), other, hidden],
    ['no particular viewer sees nothing', row({ api_token_id: TOKEN }), nobody, hidden],
    [
      'keeps the other sources (revert through a token)',
      row({ api_token_id: TOKEN, reverted_from: 'aud_x' }),
      other,
      { ...hidden, reverted_from: 'aud_x' },
    ],
    [
      'keeps the import of a token for its owner',
      row({ import_job_id: 'job_x', api_token_id: TOKEN }),
      owner,
      { import_job_id: 'job_x', ...named },
    ],
    [
      'a deleted token: the owner (the user actor) keeps the id, no name',
      row({ api_token_id: GONE }),
      owner,
      { api_token_id: GONE, api_token_name: null },
    ],
    [
      'a deleted token: org admin keeps the id, no name',
      row({ api_token_id: GONE }),
      orgAdmin,
      { api_token_id: GONE, api_token_name: null },
    ],
    ['a deleted token: anyone else sees nothing', row({ api_token_id: GONE }), other, hidden],
    [
      'the token row decides the owner, not the actor',
      row({ api_token_id: TOKEN }, READER),
      other,
      hidden,
    ],
    [
      'no token: unchanged',
      row({ automation_id: 'aut_x', run_id: 'run_x' }),
      other,
      {
        automation_id: 'aut_x',
        run_id: 'run_x',
      },
    ],
    ['null stays null', row(null), other, null],
  ] as const)('%s', (_name, entry, viewer, expected) => {
    expect(shownViaOf(entry, tokens, viewer)).toEqual(expected);
  });

  it('never returns the stored object itself', () => {
    const via = { api_token_id: TOKEN };
    const shown = shownViaOf(row(via), tokens, other);
    expect(via).toEqual({ api_token_id: TOKEN });
    expect(shown).not.toBe(via);
  });
});

describe('viaApiTokenIdsOf', () => {
  it('lists each token of the page once, ignoring other shapes', () => {
    expect(
      viaApiTokenIdsOf([
        row({ api_token_id: TOKEN }),
        row({ api_token_id: TOKEN, reverted_from: 'aud_x' }),
        row({ api_token_id: GONE }),
        row({ api_token_id: 5 }),
        row(['tok_x']),
        row(null),
      ]),
    ).toEqual([TOKEN, GONE]);
  });
});
