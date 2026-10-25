import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../lib/api/client';
import {
  DashboardEditorSession,
  liveConfig,
  MAX_HISTORY,
  type EditorApi,
} from '../edit/editor-session';

import type { DashboardDto, WidgetDto, WidgetLayout } from '@cellhive/contracts';

const DASHBOARD = 'dsh_Sales00000000001';
const NOW = '2026-10-25T00:00:00.000Z';

function widget(id: string, layout: WidgetLayout, overrides: Partial<WidgetDto> = {}): WidgetDto {
  return {
    id: id as WidgetDto['id'],
    dashboard_id: DASHBOARD,
    type: 'text',
    title: id,
    config: { markdown: id },
    layout,
    status: 'ok',
    broken_reason: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function dashboard(widgets: WidgetDto[], version = 1): DashboardDto {
  return {
    id: DASHBOARD,
    base_id: 'bse_Orders0000000001',
    name: 'Sales',
    icon: null,
    description: null,
    theme: {},
    global_filters: [],
    position: 0,
    version,
    created_by: null,
    widgets,
    created_at: NOW,
    updated_at: NOW,
  };
}

const A = 'wgt_A000000000000000';
const B = 'wgt_B000000000000000';

/** A fake API with the server's versioning (every write bumps the version). */
function fakeApi(initial: WidgetDto[]) {
  let version = 1;
  let created = 0;
  const widgets = new Map<string, WidgetDto>(initial.map((item) => [item.id, item]));
  const calls: string[] = [];
  const check = (expected: number) => {
    if (expected !== version) {
      throw new ApiError({ status: 409, code: 'VERSION_CONFLICT' });
    }
    version += 1;
  };
  const api: EditorApi = {
    putLayout: vi.fn<EditorApi['putLayout']>(async (_id, layout, expected) => {
      calls.push(`PUT layout v${String(expected)} ${JSON.stringify(layout)}`);
      check(expected);
      for (const [id, place] of Object.entries(layout)) {
        const item = widgets.get(id);
        if (item !== undefined) widgets.set(id, { ...item, layout: place });
      }
      return Promise.resolve(dashboard([...widgets.values()], version));
    }),
    createWidget: vi.fn<EditorApi['createWidget']>(async (_id, body, expected) => {
      calls.push(`POST widget v${String(expected)} ${body.title}`);
      check(expected);
      created += 1;
      const id = `wgt_New${String(created).padStart(13, '0')}`;
      const item = widget(id, body.layout, {
        type: body.type,
        title: body.title,
        config: body.config,
        updated_at: `2026-10-25T00:00:0${String(created)}.000Z`,
      });
      widgets.set(id, item);
      return Promise.resolve(item);
    }),
    updateWidget: vi.fn<EditorApi['updateWidget']>(async (id, body, expected) => {
      calls.push(`PATCH ${id} v${String(expected)} ${body.title}`);
      if (body.title === 'bad') {
        throw new ApiError({
          status: 422,
          code: 'VALIDATION_FAILED',
          errors: [{ path: 'title', code: 'TOO_BIG', message: 'Too long' }],
        });
      }
      check(expected);
      const item = widgets.get(id);
      if (item === undefined) throw new ApiError({ status: 404, code: 'NOT_FOUND' });
      const next = { ...item, title: body.title, config: body.config };
      widgets.set(id, next);
      return Promise.resolve(next);
    }),
    removeWidget: vi.fn<EditorApi['removeWidget']>(async (id, expected) => {
      calls.push(`DELETE ${id} v${String(expected)}`);
      check(expected);
      widgets.delete(id);
      return Promise.resolve();
    }),
    updateTheme: vi.fn<EditorApi['updateTheme']>(async (_id, theme, expected) => {
      calls.push(`PATCH theme v${String(expected)} ${JSON.stringify(theme)}`);
      check(expected);
      return Promise.resolve({ ...dashboard([...widgets.values()], version), theme });
    }),
    updateGlobalFilters: vi.fn<EditorApi['updateGlobalFilters']>(
      async (_id, globalFilters, expected) => {
        calls.push(`PATCH global_filters v${String(expected)} ${JSON.stringify(globalFilters)}`);
        check(expected);
        return Promise.resolve({
          ...dashboard([...widgets.values()], version),
          global_filters: [...globalFilters],
        });
      },
    ),
  };
  return {
    api,
    calls,
    widgets,
    bump: () => {
      version += 1;
    },
  };
}

function setup(
  initial: WidgetDto[] = [
    widget(A, { x: 0, y: 0, w: 6, h: 4 }),
    widget(B, { x: 0, y: 4, w: 6, h: 3 }),
  ],
) {
  const server = fakeApi(initial);
  const events = { onConflict: vi.fn(), onError: vi.fn() };
  const session = new DashboardEditorSession(DASHBOARD, dashboard(initial), server.api, events);
  return { session, server, events };
}

const places = (session: DashboardEditorSession) =>
  Object.fromEntries(
    session
      .getSnapshot()
      .widgets.map((item) => [item.key, `${String(item.layout.x)},${String(item.layout.y)}`]),
  );

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('DashboardEditorSession (T812)', () => {
  it('saves the layout once, 1 s after the last change, with If-Match', async () => {
    const { session, server } = setup();
    const start = session.layout();
    session.commitLayout(start, { ...start, [A]: { x: 6, y: 0, w: 6, h: 4 } });
    await vi.advanceTimersByTimeAsync(500);
    session.commitLayout(session.layout(), {
      ...session.layout(),
      [B]: { x: 0, y: 0, w: 6, h: 3 },
    });
    expect(session.getSnapshot().saving).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(server.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await session.flush();
    expect(server.calls).toEqual([
      `PUT layout v1 {"${A}":{"x":6,"y":0,"w":6,"h":4},"${B}":{"x":0,"y":0,"w":6,"h":3}}`,
    ]);
    expect(session.currentVersion).toBe(2);
    expect(session.getSnapshot().saving).toBe(false);
  });

  it('undoes and redoes layout steps', async () => {
    const { session, server } = setup();
    const start = session.layout();
    session.commitLayout(start, { ...start, [A]: { x: 6, y: 0, w: 6, h: 4 } });
    expect(session.getSnapshot().canUndo).toBe(true);
    session.undo();
    expect(places(session)).toEqual({ [A]: '0,0', [B]: '0,4' });
    expect(session.getSnapshot().canRedo).toBe(true);
    session.redo();
    expect(places(session)[A]).toBe('6,0');
    await vi.advanceTimersByTimeAsync(1000);
    await session.flush();
    // One save of the latest layout.
    expect(server.calls).toHaveLength(1);
  });

  it('keeps at most 50 steps', () => {
    const { session } = setup();
    for (let index = 0; index < MAX_HISTORY + 5; index += 1) {
      const before = session.layout();
      session.commitLayout(before, {
        ...before,
        [A]: { x: index % 2 === 0 ? 6 : 0, y: 0, w: 6, h: 4 },
      });
    }
    let undone = 0;
    while (session.getSnapshot().canUndo) {
      session.undo();
      undone += 1;
    }
    expect(undone).toBe(MAX_HISTORY);
  });

  it('adds, edits, removes and brings back widgets in order', async () => {
    const { session, server } = setup();
    const key = session.addWidget(
      'text',
      { title: 'Notes', config: { markdown: '' } },
      { w: 4, h: 4 },
    );
    if (key === null) throw new Error('not added');
    // Placed below every widget, at column 0.
    expect(places(session)[key]).toBe('0,7');
    const saved = session.saveContent(key, { title: 'Notes 2', config: { markdown: 'hi' } });
    expect(await saved).toEqual({ ok: true });
    const id = session.getSnapshot().widgets.find((item) => item.key === key)?.id;
    expect(id).toMatch(/^wgt_New/u);

    session.remove(A);
    // B moves up into A's space.
    expect(places(session)[B]).toBe('0,0');
    await vi.advanceTimersByTimeAsync(1000);
    await session.flush();

    session.undo(); // A comes back (a new id), B goes down again
    await session.flush();
    expect(places(session)).toMatchObject({ [A]: '0,0', [B]: '0,4' });
    session.undo(); // the edit
    await session.flush();
    expect(session.getSnapshot().widgets.find((item) => item.key === key)?.title).toBe('Notes');
    session.undo(); // the addition
    await session.flush();
    expect(session.getSnapshot().widgets.map((item) => item.key)).toEqual([B, A]);

    expect(server.calls).toEqual([
      'POST widget v1 Notes',
      `PATCH ${String(id)} v2 Notes 2`,
      `DELETE ${A} v3`,
      expect.stringMatching(/^PUT layout v4 /u),
      expect.stringMatching(/^PUT layout v5 .*"y":4/u),
      'POST widget v6 wgt_A000000000000000',
      `PATCH ${String(id)} v7 Notes`,
      `DELETE ${String(id)} v8`,
    ]);
  });

  it('returns field errors of a 422 without an undo step', async () => {
    const { session, events } = setup();
    const result = await session.saveContent(A, { title: 'bad', config: { markdown: '' } });
    expect(result.ok).toBe(false);
    expect(session.getSnapshot().canUndo).toBe(false);
    expect(events.onError).not.toHaveBeenCalled();
  });

  it('stops on a version conflict and starts over on reset', async () => {
    const { session, server, events } = setup();
    server.bump(); // someone else saved
    const start = session.layout();
    session.commitLayout(start, { ...start, [A]: { x: 6, y: 0, w: 6, h: 4 } });
    await vi.advanceTimersByTimeAsync(1000);
    await session.flush();
    expect(events.onConflict).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().canUndo).toBe(false);

    session.reset(dashboard([widget(A, { x: 0, y: 0, w: 12, h: 4 })], 3));
    expect(session.currentVersion).toBe(3);
    expect(places(session)).toEqual({ [A]: '0,0' });
    expect(session.getSnapshot().canUndo).toBe(false);
  });

  it('saves the theme and undoes it', async () => {
    const { session, server } = setup();
    session.setTheme({ mode: 'dark', density: 'compact' });
    expect(session.getSnapshot().theme).toEqual({ mode: 'dark', density: 'compact' });
    session.undo();
    await session.flush();
    expect(session.getSnapshot().theme).toEqual({});
    expect(server.calls).toEqual([
      'PATCH theme v1 {"mode":"dark","density":"compact"}',
      'PATCH theme v2 {}',
    ]);
  });

  it('is not left saving when writes queued behind a conflict are dropped', async () => {
    const { session, server, events } = setup();
    server.bump(); // someone else saved
    session.setTheme({ mode: 'dark' });
    session.setGlobalFilters([]);
    await session.flush();
    expect(events.onConflict).toHaveBeenCalledTimes(1);
    expect(server.calls).toEqual(['PATCH theme v1 {"mode":"dark"}']);
    expect(session.getSnapshot().saving).toBe(false);
    expect(session.idle).toBe(true);
  });

  it('neither adds nor duplicates widgets once stopped', async () => {
    const { session, server } = setup();
    server.bump();
    session.setTheme({ mode: 'dark' });
    await session.flush();
    const before = session.getSnapshot().widgets;
    expect(session.addWidget('text', { title: 'Late', config: {} }, { w: 4, h: 4 })).toBeNull();
    expect(session.duplicate(A)).toBeNull();
    await session.flush();
    expect(session.getSnapshot().widgets).toBe(before);
    expect(server.calls).toEqual(['PATCH theme v1 {"mode":"dark"}']);
    expect(session.getSnapshot().canUndo).toBe(false);
  });

  it('brings back the bindings of a removed filter control on undo, drops them on redo', async () => {
    const C = 'wgt_C000000000000000';
    const D = 'wgt_D000000000000000';
    const { session, server } = setup([
      widget(C, { x: 0, y: 0, w: 4, h: 2 }, { type: 'filter_control', config: {} }),
      widget(B, { x: 0, y: 2, w: 6, h: 3 }, { type: 'bar', config: { filter_bindings: [C] } }),
      widget(
        D,
        { x: 6, y: 2, w: 4, h: 2 },
        { type: 'filter_control', config: { parent_control_id: C } },
      ),
      widget(A, { x: 0, y: 5, w: 6, h: 3 }, { config: { markdown: 'a' } }),
    ]);
    const configOf = (key: string) =>
      session.getSnapshot().widgets.find((item) => item.key === key)?.config;

    session.remove(C);
    expect(configOf(B)).toEqual({ filter_bindings: [] });
    expect(configOf(D)).toEqual({ parent_control_id: null });
    await vi.advanceTimersByTimeAsync(1000);
    await session.flush();

    session.undo();
    await session.flush();
    const restored = session.getSnapshot().widgets.find((item) => item.key === C)?.id;
    expect(restored).toMatch(/^wgt_New/u);
    expect(configOf(B)).toEqual({ filter_bindings: [restored] });
    expect(configOf(D)).toEqual({ parent_control_id: restored });
    expect(server.widgets.get(B)?.config).toEqual({ filter_bindings: [restored] });
    expect(server.widgets.get(D)?.config).toEqual({ parent_control_id: restored });
    expect(configOf(A)).toEqual({ markdown: 'a' });
    expect(session.getSnapshot().saving).toBe(false);

    session.redo();
    expect(configOf(B)).toEqual({ filter_bindings: [] });
    expect(configOf(D)).toEqual({ parent_control_id: null });
    await vi.advanceTimersByTimeAsync(1000);
    await session.flush();

    session.undo(); // a second time: bound again to the control created anew
    await session.flush();
    const again = session.getSnapshot().widgets.find((item) => item.key === C)?.id;
    expect(again).not.toBe(restored);
    expect(configOf(B)).toEqual({ filter_bindings: [again] });
    expect(server.widgets.get(D)?.config).toEqual({ parent_control_id: again });
  });
});

describe('liveConfig', () => {
  it('drops filter controls that are gone', () => {
    const live = new Set(['wgt_C1']);
    expect(liveConfig('bar', { filter_bindings: ['wgt_C1', 'wgt_C2'] }, live)).toEqual({
      filter_bindings: ['wgt_C1'],
    });
    expect(liveConfig('filter_control', { parent_control_id: 'wgt_C2' }, live)).toEqual({
      parent_control_id: null,
    });
  });
});
