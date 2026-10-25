import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import {
  endPreferenceSession,
  lastViewPreferenceKey,
  setPreferenceUser,
  viewDraftPreferenceKey,
} from '../../preferences';
import { keys } from '../../query/keys';
import { resetOwnChanges } from '../../realtime/own-changes';
import { unreadableKeys } from '../config';
import { AUTOSAVE_DELAY_MS, ViewSessions, viewSessions } from '../session';

import type { ViewDto, ViewList } from '@cellhive/contracts';

const update = vi.hoisted(() => vi.fn());
vi.mock('../../api', () => ({ api: { views: { update } } }));
const toast = vi.hoisted(() => vi.fn());
vi.mock('../../toast/toast', () => ({ showErrorToast: toast }));

const TABLE = 'tbl_Tickets000000001';
const VIEW = 'viw_Tickets000000001';
const A = 'fld_A000000000000001';
const B = 'fld_B000000000000001';
const EDITOR = 'usr_Editor0000000001';
const READER = 'usr_Reader0000000001';
const DRAFT_KEY = viewDraftPreferenceKey(EDITOR, VIEW);

function view(config: Partial<ViewDto['config']> = {}): ViewDto {
  return {
    id: VIEW,
    table_id: TABLE,
    type: 'grid',
    name: 'Grid view',
    is_personal: false,
    owner_id: null,
    position: 0,
    locked: false,
    config: {
      filter: null,
      sort: [],
      group: [],
      hidden_fields: [],
      field_order: [],
      column_widths: {},
      frozen_count: 1,
      row_height: 'short',
      tree: { enabled: false, show_ancestors: true },
      ...config,
    },
    created_at: '2026-09-24T00:00:00.000Z',
    updated_at: '2026-09-24T00:00:00.000Z',
  };
}

let sessions: ViewSessions;
let queryClient: QueryClient;
const target = () => ({ queryClient, tableId: TABLE });

beforeEach(() => {
  vi.useFakeTimers();
  sessions = new ViewSessions();
  // `runAllTimersAsync` would otherwise garbage-collect the unobserved list.
  queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  queryClient.setQueryData<ViewList>(keys.views(TABLE), {
    items: [view()],
    total: 1,
    offset: 0,
    limit: 1000,
  });
  update.mockReset();
  toast.mockReset();
  resetOwnChanges();
  setPreferenceUser(EDITOR);
});

afterEach(() => {
  vi.useRealTimers();
  setPreferenceUser(null);
  window.localStorage.clear();
});

describe('ViewSessions (T310 view config state)', () => {
  it('debounces autosaved changes into one PATCH and updates the cached view', async () => {
    update.mockImplementation((_id: string, body: { config: object }) =>
      Promise.resolve(view(body.config)),
    );
    sessions.autosave(VIEW, { column_widths: { [A]: 200 } }, target());
    sessions.autosave(VIEW, { frozen_count: 2 }, target());
    expect(sessions.get(VIEW).pending).toEqual({ column_widths: { [A]: 200 }, frozen_count: 2 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1);
    expect(update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(VIEW, {
      config: { column_widths: { [A]: 200 }, frozen_count: 2 },
    });
    await vi.runAllTimersAsync();
    expect(sessions.get(VIEW)).toEqual({ draft: {}, pending: {}, saving: false });
    const cached = queryClient.getQueryData<ViewList>(keys.views(TABLE));
    expect(cached?.items[0]?.config.frozen_count).toBe(2);
  });

  it('sends a change made during a save in the next PATCH', async () => {
    let resolve: (value: ViewDto) => void = () => undefined;
    update.mockImplementationOnce(
      () =>
        new Promise<ViewDto>((done) => {
          resolve = done;
        }),
    );
    update.mockImplementationOnce((_id: string, body: { config: object }) =>
      Promise.resolve(view(body.config)),
    );
    sessions.autosave(VIEW, { frozen_count: 2 }, target());
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    sessions.autosave(VIEW, { frozen_count: 3 }, target());
    resolve(view({ frozen_count: 2 }));
    await vi.runAllTimersAsync();
    expect(update).toHaveBeenLastCalledWith(VIEW, { config: { frozen_count: 3 } });
    expect(sessions.get(VIEW).pending).toEqual({});
  });

  it('rolls back and explains when the server refuses', async () => {
    update.mockRejectedValue(new ApiError({ status: 422, code: 'VALIDATION_FAILED' }));
    sessions.autosave(VIEW, { hidden_fields: [A] }, target());
    await vi.runAllTimersAsync();
    expect(sessions.get(VIEW)).toEqual({ draft: {}, pending: {}, saving: false });
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('keeps the change on this device when saving is no longer allowed (403, locked)', async () => {
    update.mockRejectedValue(
      new ApiError({
        status: 422,
        code: 'VALIDATION_FAILED',
        errors: [{ path: 'config', code: 'VIEW_LOCKED', message: 'locked' }],
      }),
    );
    sessions.autosave(VIEW, { hidden_fields: [A] }, target());
    await vi.runAllTimersAsync();
    expect(sessions.get(VIEW).draft).toEqual({ hidden_fields: [A] });
    expect(sessions.get(VIEW).pending).toEqual({});
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('keeps temporary changes on this device across page loads', () => {
    sessions.setTemporary(VIEW, { hidden_fields: [A] });
    sessions.setTemporary(VIEW, { column_widths: { [B]: 90 } });
    expect(JSON.parse(window.localStorage.getItem(DRAFT_KEY) ?? '')).toEqual({
      hidden_fields: [A],
      column_widths: { [B]: 90 },
    });
    // A new tab reads them back.
    expect(new ViewSessions().get(VIEW).draft).toEqual({
      hidden_fields: [A],
      column_widths: { [B]: 90 },
    });
    sessions.discard(VIEW);
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('an autosaved change replaces the temporary change of the same key', () => {
    update.mockReturnValue(new Promise(() => undefined));
    sessions.setTemporary(VIEW, { hidden_fields: [A], frozen_count: 3 });
    sessions.autosave(VIEW, { hidden_fields: [B] }, target());
    expect(sessions.get(VIEW).draft).toEqual({ frozen_count: 3 });
  });

  it('saves temporary changes on request and ends those equal to the saved config', async () => {
    update.mockImplementation((_id: string, body: { config: object }) =>
      Promise.resolve(view(body.config)),
    );
    sessions.setTemporary(VIEW, { hidden_fields: [A] });
    await expect(sessions.save(VIEW, target())).resolves.toBe(true);
    expect(update).toHaveBeenCalledWith(VIEW, { config: { hidden_fields: [A] } });
    expect(sessions.get(VIEW).draft).toEqual({});
    sessions.setTemporary(VIEW, { frozen_count: 1, row_height: 'tall' });
    sessions.settle(VIEW, view().config);
    expect(sessions.get(VIEW).draft).toEqual({ row_height: 'tall' });
  });

  it('forgets a deleted view entirely', () => {
    sessions.setTemporary(VIEW, { hidden_fields: [A] });
    sessions.forget(VIEW);
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(sessions.get(VIEW).draft).toEqual({});
  });

  it('keeps temporary changes per user: another user of the browser does not see them', () => {
    sessions.setTemporary(VIEW, { sort: [{ field: A, direction: 'desc' }] });
    expect(window.localStorage.getItem(DRAFT_KEY)).not.toBeNull();
    setPreferenceUser(READER);
    expect(new ViewSessions().get(VIEW).draft).toEqual({});
    setPreferenceUser(EDITOR);
    expect(new ViewSessions().get(VIEW).draft).toEqual({ sort: [{ field: A, direction: 'desc' }] });
  });

  it('keeps temporary changes in memory only while the user is unknown', () => {
    setPreferenceUser(null);
    sessions.setTemporary(VIEW, { row_height: 'tall' });
    expect(sessions.get(VIEW).draft).toEqual({ row_height: 'tall' });
    expect(window.localStorage.length).toBe(0);
  });

  it('forgets the drafts held in memory when another user signs in', () => {
    viewSessions.setTemporary(VIEW, { row_height: 'tall' });
    setPreferenceUser(READER);
    expect(viewSessions.get(VIEW).draft).toEqual({});
    setPreferenceUser(EDITOR);
    expect(viewSessions.get(VIEW).draft).toEqual({ row_height: 'tall' });
    viewSessions.discard(VIEW);
  });

  it('deletes the drafts of a user whose session ends, not those of others', () => {
    const readerKey = viewDraftPreferenceKey(READER, VIEW);
    window.localStorage.setItem(readerKey, JSON.stringify({ row_height: 'tall' }));
    viewSessions.setTemporary(VIEW, { row_height: 'medium' });
    window.localStorage.setItem(lastViewPreferenceKey(EDITOR, TABLE), VIEW);
    endPreferenceSession();
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(viewSessions.get(VIEW).draft).toEqual({});
    expect(window.localStorage.getItem(readerKey)).not.toBeNull();
    // Not a draft: the last view of the user stays.
    expect(window.localStorage.getItem(lastViewPreferenceKey(EDITOR, TABLE))).toBe(VIEW);
  });

  it('deletes the keys from before drafts and last views were per user', () => {
    setPreferenceUser(null);
    window.localStorage.setItem(
      `cellhive.viewDraft.${VIEW}`,
      JSON.stringify({ row_height: 'tall' }),
    );
    window.localStorage.setItem(`cellhive.lastView.${TABLE}`, VIEW);
    window.localStorage.setItem('cellhive.language', 'vi');
    setPreferenceUser(READER);
    expect(window.localStorage.getItem(`cellhive.viewDraft.${VIEW}`)).toBeNull();
    expect(window.localStorage.getItem(`cellhive.lastView.${TABLE}`)).toBeNull();
    expect(new ViewSessions().get(VIEW).draft).toEqual({});
    expect(window.localStorage.getItem('cellhive.language')).toBe('vi');
  });

  it('drops temporary changes naming fields the user cannot read', () => {
    sessions.setTemporary(VIEW, {
      sort: [{ field: B, direction: 'asc' }],
      filter: { op: 'and', items: [{ field: A, op: 'is_not_empty' }] },
      column_widths: { [B]: 120 },
      row_height: 'tall',
    });
    sessions.dropUnreadable(VIEW, new Set([A]));
    expect(sessions.get(VIEW).draft).toEqual({
      filter: { op: 'and', items: [{ field: A, op: 'is_not_empty' }] },
      row_height: 'tall',
    });
    expect(JSON.parse(window.localStorage.getItem(DRAFT_KEY) ?? '')).toEqual(
      sessions.get(VIEW).draft,
    );
  });
});

describe('unreadableKeys', () => {
  const readable = new Set([A]);
  it.each([
    ['sort', { sort: [{ field: B, direction: 'asc' as const }] }, ['sort']],
    ['group', { group: [{ field: A, direction: 'asc' as const }] }, []],
    [
      'filter deep inside',
      { filter: { op: 'or', items: [{ op: 'and', items: [{ field: B }] }] } },
      ['filter'],
    ],
    ['list', { hidden_fields: [A, B] }, ['hidden_fields']],
    ['record keys', { column_widths: { [B]: 100 } }, ['column_widths']],
    ['no field', { row_height: 'tall' as const, frozen_count: 2 }, []],
    [
      'kanban',
      { kanban: { group_field: B, card_fields: [], cover_field: null, hide_empty_columns: false } },
      ['kanban'],
    ],
  ])('%s', (_name, patch, expected) => {
    expect(unreadableKeys(patch, readable)).toEqual(expected);
  });
});
