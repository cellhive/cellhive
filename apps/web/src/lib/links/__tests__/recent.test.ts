import { afterEach, describe, expect, it } from 'vitest';

import {
  endPreferenceSession,
  linkRecentPreferenceKey,
  setPreferenceUser,
} from '../../preferences';
import {
  forgetLinkRecents,
  LINK_RECENT_LIMIT,
  mergeLinkRecents,
  readLinkRecents,
  rememberLinkRecents,
} from '../recent';

const SCOPE = { userId: 'usr_AAAAAAAAAAAAAAAA', orgId: 'org_AAAAAAAAAAAAAAAA', fieldId: 'fld_A' };
const rec = (n: number) => `rec_${String(n).padStart(16, '0')}`;

afterEach(() => {
  window.localStorage.clear();
  setPreferenceUser(null);
});

describe('"Recent" of the link picker (BACKLOG S4 design decision #2)', () => {
  it('keys by user, organization and field, and stores record ids only', () => {
    rememberLinkRecents(SCOPE, [rec(1), rec(2)]);
    expect(linkRecentPreferenceKey(SCOPE.userId, SCOPE.orgId, SCOPE.fieldId)).toBe(
      'cellhive.linkRecent.usr_AAAAAAAAAAAAAAAA.org_AAAAAAAAAAAAAAAA.fld_A',
    );
    const raw = window.localStorage.getItem(
      'cellhive.linkRecent.usr_AAAAAAAAAAAAAAAA.org_AAAAAAAAAAAAAAAA.fld_A',
    );
    expect(JSON.parse(raw ?? 'null')).toEqual([rec(1), rec(2)]);
    expect(readLinkRecents({ ...SCOPE, fieldId: 'fld_B' })).toEqual([]);
  });

  it('puts the newest first, without repeats, keeps the last ten', () => {
    expect(mergeLinkRecents([rec(1), rec(2)], [rec(2), rec(3)])).toEqual([rec(2), rec(3), rec(1)]);
    const many = Array.from({ length: 15 }, (_, index) => rec(index));
    expect(mergeLinkRecents([], many)).toHaveLength(LINK_RECENT_LIMIT);
  });

  it('ignores stored content that is not a list of record ids', () => {
    const key = linkRecentPreferenceKey(SCOPE.userId, SCOPE.orgId, SCOPE.fieldId);
    window.localStorage.setItem(key, '{"title":"An Phát"}');
    expect(readLinkRecents(SCOPE)).toEqual([]);
    window.localStorage.setItem(key, JSON.stringify(['An Phát', rec(4), 5]));
    expect(readLinkRecents(SCOPE)).toEqual([rec(4)]);
  });

  it('forgets records the API no longer returns', () => {
    rememberLinkRecents(SCOPE, [rec(1), rec(2)]);
    forgetLinkRecents(SCOPE, [rec(1)]);
    expect(readLinkRecents(SCOPE)).toEqual([rec(2)]);
    forgetLinkRecents(SCOPE, [rec(2)]);
    expect(
      window.localStorage.getItem(
        linkRecentPreferenceKey(SCOPE.userId, SCOPE.orgId, SCOPE.fieldId),
      ),
    ).toBeNull();
  });

  it('is deleted when the session ends (sign-out)', () => {
    setPreferenceUser(SCOPE.userId);
    rememberLinkRecents(SCOPE, [rec(1)]);
    rememberLinkRecents({ ...SCOPE, userId: 'usr_BBBBBBBBBBBBBBBB' }, [rec(2)]);
    endPreferenceSession();
    expect(readLinkRecents(SCOPE)).toEqual([]);
    expect(readLinkRecents({ ...SCOPE, userId: 'usr_BBBBBBBBBBBBBBBB' })).toEqual([rec(2)]);
  });
});
