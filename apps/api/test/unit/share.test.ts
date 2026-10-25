import { describe, expect, it, vi } from 'vitest';

import { ShareAccessStats } from '../../src/modules/share/share-access-stats.js';
import { viewerLocale } from '../../src/modules/share/share-export.service.js';
import { ShareUnlockCookies } from '../../src/modules/share/share-unlock-cookies.js';
import { COMPUTED_ATTACHMENTS, COMPUTED_RECORDS } from '../../src/modules/share/share-values.js';
import { redactSharedRecord } from '../../src/modules/share/share.service.js';

import type { AppLogger } from '../../src/common/logging/app-logger.js';
import type { Id } from '@cellhive/contracts';
import type { RecordOutput, ShareLinksRepository } from '@cellhive/server-core';

const LINK = { id: 'shl_UnitTestLinkAAAA' as Id<'shl'>, password_hash: '$argon2id$v=19$m=1$a$b' };
const NOW = new Date('2026-09-24T10:00:00.000Z');

describe('ShareUnlockCookies', () => {
  const cookies = new ShareUnlockCookies('unit-test-session-secret-0123456789');

  it.each([
    ['the issued value', (value: string) => value, LINK, NOW, true],
    ['after 24 h', (value: string) => value, LINK, new Date(NOW.getTime() + 86_400_000), false],
    ['another link', (value: string) => value, { ...LINK, id: 'shl_UnitTestLinkBBBB' }, NOW, false],
    [
      'a changed password',
      (value: string) => value,
      { ...LINK, password_hash: 'other' },
      NOW,
      false,
    ],
    [
      'a link without password',
      (value: string) => value,
      { ...LINK, password_hash: null },
      NOW,
      false,
    ],
    [
      'a tampered expiry',
      (value: string) => value.replace(/^[0-9a-z]+/u, 'zzzzzzz'),
      LINK,
      NOW,
      false,
    ],
    ['garbage', () => 'x.y', LINK, NOW, false],
  ] as const)('verifies %s → %s', (_name, mutate, link, at, expected) => {
    const issued = cookies.issue(LINK, NOW);
    expect(cookies.verify(link as typeof LINK, mutate(issued.value), at)).toBe(expected);
  });

  it('expires 24 h after issue and binds the CSRF token to the cookie value', () => {
    const issued = cookies.issue(LINK, NOW);
    expect(issued.expiresAt.getTime() - NOW.getTime()).toBe(86_400_000);
    expect(cookies.csrfValid(issued.value, issued.csrfToken)).toBe(true);
    expect(cookies.csrfValid(issued.value, undefined)).toBe(false);
    const other = cookies.issue(LINK, new Date(NOW.getTime() + 5_000));
    expect(cookies.csrfValid(issued.value, other.csrfToken)).toBe(false);
    // Another secret signs differently.
    expect(
      new ShareUnlockCookies('another-secret-0123456789abcdef').verify(LINK, issued.value, NOW),
    ).toBe(false);
  });

  it('serializes an HttpOnly, SameSite=Strict cookie scoped to the share API', () => {
    expect(cookies.serialize(LINK.id, 'v', { secure: true, maxAgeSeconds: 86_400 })).toBe(
      'ob_share_shl_UnitTestLinkAAAA=v; Path=/api/v1/shares/; Max-Age=86400; SameSite=Strict; HttpOnly; Secure',
    );
  });
});

describe('ShareAccessStats', () => {
  function statsWith(recordAccess = vi.fn(() => Promise.resolve())) {
    const repository = { recordAccess } as unknown as ShareLinksRepository;
    const warn = vi.fn();
    const logger = { warn } as unknown as AppLogger;
    return { stats: new ShareAccessStats(repository, logger), recordAccess, warn };
  }
  const org = 'org_UnitTestOrgAAAAA' as Id<'org'>;
  const other = 'shl_UnitTestLinkCCCC' as Id<'shl'>;

  it('writes one row per link per flush: page opens counted, latest access kept', async () => {
    const { stats, recordAccess } = statsWith();
    stats.record(org, LINK.id, true, new Date('2026-09-24T10:00:00.000Z'));
    stats.record(org, LINK.id, false, new Date('2026-09-24T10:00:05.000Z'));
    stats.record(org, LINK.id, true, new Date('2026-09-24T10:00:01.000Z'));
    stats.record(org, other, false, NOW);
    expect(recordAccess).not.toHaveBeenCalled();
    await stats.flush();
    expect(recordAccess.mock.calls).toEqual([
      [{ organizationId: org }, LINK.id, { count: 2, at: new Date('2026-09-24T10:00:05.000Z') }],
      [{ organizationId: org }, other, { count: 0, at: NOW }],
    ]);
    await stats.flush();
    expect(recordAccess).toHaveBeenCalledTimes(2);
    expect(stats.pendingLinks).toBe(0);
  });

  it('logs a failed write and goes on', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('db down')));
    const { stats, warn } = statsWith(failing);
    stats.record(org, LINK.id, true, NOW);
    stats.record(org, other, true, NOW);
    await stats.flush();
    expect(failing).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('redactSharedRecord', () => {
  it('drops the email of user values, nothing else', () => {
    const record = {
      id: 'rec_UnitTestRecAAAA',
      created_at: '2026-09-24T10:00:00.000Z',
      updated_at: '2026-09-24T10:00:00.000Z',
      version: 1,
      fields: {
        owner: [{ id: 'usr_UnitTestUserAAAA', name: 'A', email: 'a@example.test' }],
        created_by: { id: 'usr_UnitTestUserBBBB', name: 'B', email: 'b@example.test' },
        former: [{ id: 'usr_UnitTestUserCCCC' }],
        text: 'mail me: a@example.test',
        other: { email: 'kept@example.test' },
        tags: ['x'],
      },
    } as unknown as RecordOutput;
    expect(redactSharedRecord(record).fields).toEqual({
      owner: [{ id: 'usr_UnitTestUserAAAA', name: 'A' }],
      created_by: { id: 'usr_UnitTestUserBBBB', name: 'B' },
      former: [{ id: 'usr_UnitTestUserCCCC' }],
      text: 'mail me: a@example.test',
      other: { email: 'kept@example.test' },
      tags: ['x'],
    });
  });

  it('with a link context (T409): locks unreadable linked records, rewrites file URLs', () => {
    const record = {
      id: 'rec_UnitTestRecAAAA',
      created_at: '2026-09-24T10:00:00.000Z',
      updated_at: '2026-09-24T10:00:00.000Z',
      version: 1,
      fields: {
        fld_Customer0000001: [
          { id: 'rec_UnitTestRecBBBB', title: 'An Phát' },
          { id: 'rec_UnitTestRecCCCC', title: null },
        ],
        Parent: { id: 'rec_UnitTestRecDDDD', title: null },
        files: [
          {
            id: 'att_UnitTestFileAAAA',
            name: 'a.png',
            size: 1,
            mime: 'image/png',
            url: '/api/v1/files/att_UnitTestFileAAAA',
            thumbnail_url: '/api/v1/files/att_UnitTestFileAAAA/thumbnail',
          },
          {
            id: 'att_UnitTestFileBBBB',
            name: 'a.pdf',
            size: 1,
            mime: 'application/pdf',
            url: '/api/v1/files/att_UnitTestFileBBBB',
            thumbnail_url: null,
          },
        ],
        text: 'An Phát, rec_UnitTestRecCCCC',
        owner: [{ id: 'usr_UnitTestUserAAAA', name: 'A', email: 'a@example.test' }],
      },
    } as unknown as RecordOutput;
    const types = new Map([
      ['fld_Customer0000001', 'link'],
      ['Parent', 'parent'],
      ['files', 'attachment'],
      ['text', 'link'],
      ['owner', 'user'],
    ]);
    expect(redactSharedRecord(record, { token: 'tok', types }).fields).toEqual({
      fld_Customer0000001: [
        { id: 'rec_UnitTestRecBBBB', title: 'An Phát' },
        { id: null, title: null },
      ],
      Parent: { id: null, title: null },
      files: [
        expect.objectContaining({
          url: '/api/v1/shares/tok/files/att_UnitTestFileAAAA',
          thumbnail_url: '/api/v1/shares/tok/files/att_UnitTestFileAAAA/thumbnail',
        }),
        expect.objectContaining({
          url: '/api/v1/shares/tok/files/att_UnitTestFileBBBB',
          thumbnail_url: null,
        }),
      ],
      // `cell_format=text` of a link: readable titles only, left as is.
      text: 'An Phát, rec_UnitTestRecCCCC',
      owner: [{ id: 'usr_UnitTestUserAAAA', name: 'A' }],
    });
  });

  it('formula/lookup values (T462): records locked like links, files never, users without email', () => {
    const record = {
      id: 'rec_UnitTestRecAAAA',
      created_at: '2026-09-24T10:00:00.000Z',
      updated_at: '2026-09-24T10:00:00.000Z',
      version: 1,
      fields: {
        refs: [
          { id: 'rec_UnitTestRecBBBB', title: 'An Phát' },
          { id: 'rec_UnitTestRecCCCC', title: null },
        ],
        ref: { id: 'rec_UnitTestRecDDDD', title: null },
        photos: [{ id: 'att_UnitTestFileAAAA', name: 'a.png', size: 1, mime: 'image/png' }],
        photos_text: 'a.png',
        owners: [{ id: 'usr_UnitTestUserAAAA', name: 'A', email: 'a@example.test' }],
        total: 12,
      },
    } as unknown as RecordOutput;
    const types = new Map([
      ['refs', COMPUTED_RECORDS],
      ['ref', COMPUTED_RECORDS],
      ['photos', COMPUTED_ATTACHMENTS],
      ['photos_text', COMPUTED_ATTACHMENTS],
      ['owners', 'formula'],
      ['total', 'lookup'],
    ]);
    expect(redactSharedRecord(record, { token: 'tok', types }).fields).toEqual({
      refs: [
        { id: 'rec_UnitTestRecBBBB', title: 'An Phát' },
        { id: null, title: null },
      ],
      ref: { id: null, title: null },
      photos: null,
      photos_text: '',
      owners: [{ id: 'usr_UnitTestUserAAAA', name: 'A' }],
      total: 12,
    });
  });
});

describe('viewerLocale (T810)', () => {
  it.each([
    [undefined, 'vi'],
    ['', 'vi'],
    ['en-US', 'en-US'],
    ['fr-CH, fr;q=0.9, en;q=0.8, *;q=0.5', 'fr-CH'],
    ['en;q=0.5, vi-VN', 'vi-VN'],
    ['de;q=0.7, ja;q=0.7', 'de'],
    ['*', 'vi'],
    ['en;q=0', 'vi'],
    ['not a tag!!, en-gb', 'en-GB'],
    ['x;q=abc', 'vi'],
    [['ko', 'en'], 'ko'],
  ] as const)('%j → %s', (header, expected) => {
    expect(viewerLocale(header as string | string[] | undefined, 'vi')).toBe(expected);
  });
});
