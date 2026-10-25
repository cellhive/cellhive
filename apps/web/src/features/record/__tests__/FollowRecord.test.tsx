import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, problem, renderApp, stubApi } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import {
  BASE_ID,
  baseDetail,
  fieldList,
  record,
  recordId,
  TABLE,
  TABLE_ID,
  type AccessKind,
} from '../../../../test/records';
import { clearToasts } from '../../../lib/toast/toast';

import type { GridViewProps } from '../../../grid';
import type { RecordFollowDto } from '@cellhive/contracts';

// The canvas grid needs a real browser (E2E); here it is a list with the hooks the panel uses.
vi.mock('../../../grid/GridView', () => ({
  GridView: ({ rowCount, getRecord, onViewportChange, label, fields, hooks }: GridViewProps) => {
    useEffect(() => {
      onViewportChange({ firstRow: 0, lastRow: Math.min(rowCount, 20) - 1, dragging: false });
    }, [onViewportChange, rowCount]);
    const first = getRecord(0);
    return (
      <section aria-label={label} data-testid="grid" data-rows={rowCount}>
        <button
          type="button"
          onClick={() => {
            const field = fields[1];
            if (first !== undefined && field !== undefined) {
              hooks?.recordDetail?.onCellMenu?.(
                { recordId: first.id, fieldId: field.field.id },
                { x: 10, y: 10, width: 100, height: 30 },
              );
            }
          }}
        >
          cell menu row 1
        </button>
      </section>
    );
  },
}));

const GRID_PATH = `/b/${BASE_ID}/t/${TABLE_ID}`;
const RECORDS = [record(1), record(2), record(3)];
const followPath = (id: string) => `/tables/${TABLE_ID}/records/${id}/follow`;

interface Server {
  readonly kind?: AccessKind;
  /** State answered by `GET …/follow` (every record). */
  readonly follow?: RecordFollowDto;
  /** Answer of `PUT …/follow` (default `204`). */
  readonly put?: () => Response;
  /** Answer of `DELETE …/follow` (default `204`). */
  readonly remove?: () => Response;
}

const noContent = () => new Response(null, { status: 204 });

function serve(server: Server = {}) {
  const calls: string[] = [];
  const state = { follow: server.follow ?? { following: false, source: null } };
  const fetchMock = stubApi({
    signedIn: true,
    routes: {
      [`GET /bases/${BASE_ID}`]: () => json(baseDetail(server.kind ?? 'admin')),
      [`GET /bases/${BASE_ID}/tables`]: () =>
        json({ items: [TABLE], total: 1, offset: 0, limit: 1000 }),
      [`GET /tables/${TABLE_ID}`]: () => json(TABLE),
      [`GET /tables/${TABLE_ID}/fields`]: () => json(fieldList()),
      [`POST /tables/${TABLE_ID}/records/query`]: () =>
        json({ records: RECORDS, total: RECORDS.length, offset: 0, limit: 200 }),
      ...Object.fromEntries(
        RECORDS.flatMap((item) => [
          [`GET /tables/${TABLE_ID}/records/${item.id}`, () => json(item)],
          [
            `GET /tables/${TABLE_ID}/records/${item.id}/history`,
            () => json({ items: [], next_cursor: null }),
          ],
          [
            `GET ${followPath(item.id)}`,
            () => {
              calls.push(`GET ${item.id}`);
              return json(state.follow);
            },
          ],
          [
            `PUT ${followPath(item.id)}`,
            () => {
              calls.push(`PUT ${item.id}`);
              const answer = server.put?.() ?? noContent();
              if (answer.status === 204 && !state.follow.following) {
                state.follow = { following: true, source: 'manual' };
              }
              return answer;
            },
          ],
          [
            `DELETE ${followPath(item.id)}`,
            () => {
              calls.push(`DELETE ${item.id}`);
              const answer = server.remove?.() ?? noContent();
              if (answer.status === 204) state.follow = { following: false, source: null };
              return answer;
            },
          ],
        ]),
      ),
    },
  });
  return { fetchMock, calls };
}

function panel() {
  // The first test loads every lazy route chunk: more than the 1 s default.
  return screen.findByRole('dialog', { name: /Order/u }, { timeout: 12_000 });
}

function stubScreen(query: string) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((media: string) => ({
      matches: media.includes(query),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
}

/** The follow button once its state is read. */
async function followButton(dialog: HTMLElement, name: 'Follow' | 'Following') {
  const button = within(dialog).getByTestId('record-follow');
  await waitFor(() => {
    expect(button).toHaveAccessibleName(name);
  });
  return button;
}

beforeEach(() => {
  stubScreen('min-width: 1920px');
  window.localStorage.clear();
});

afterEach(() => {
  clearToasts();
});

describe('Follow a record (T553)', () => {
  it('the panel header has a "Follow" toggle button with a bell; no axe violations', async () => {
    const { calls } = serve();
    await renderApp(`${GRID_PATH}?record=${recordId(1)}`);
    const dialog = await panel();
    const button = await followButton(dialog, 'Follow');
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(button).toHaveAccessibleDescription(
      'Get notified when someone else changes this record.',
    );
    expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(calls).toEqual([`GET ${recordId(1)}`]);
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it.each([
    ['created', 'You follow this record because you created it. Select to unfollow.'],
    ['assigned', 'You follow this record because you were assigned to it. Select to unfollow.'],
    ['manual', 'You follow this record. Select to unfollow.'],
  ] as const)('a follow from %s says so in the description', async (source, description) => {
    serve({ follow: { following: true, source } });
    await renderApp(`${GRID_PATH}?record=${recordId(1)}`);
    const button = await followButton(await panel(), 'Following');
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toHaveAccessibleDescription(description);
    expect(button).toHaveClass('bg-accent-soft', 'text-accent');
  });

  it('toggles optimistically: follow then unfollow, by mouse and keyboard', async () => {
    const { calls } = serve();
    await renderApp(`${GRID_PATH}?record=${recordId(1)}`);
    const dialog = await panel();
    const user = userEvent.setup();
    const button = await followButton(dialog, 'Follow');
    await user.click(button);
    // At once, before the answer.
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toHaveAccessibleName('Following');
    await waitFor(() => {
      expect(calls).toContain(`PUT ${recordId(1)}`);
    });
    expect(button).toHaveAccessibleDescription('You follow this record. Select to unfollow.');

    // Keyboard: focus stays on the button, Space toggles it back.
    button.focus();
    await user.keyboard(' ');
    expect(button).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => {
      expect(calls).toContain(`DELETE ${recordId(1)}`);
    });
    expect(button).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(button).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => {
      expect(calls.filter((call) => call.startsWith('PUT'))).toHaveLength(2);
    });
  });

  it('TOO_MANY_FOLLOWS (422): back to "Follow" with a translated error toast', async () => {
    serve({
      put: () =>
        new Response(
          JSON.stringify({
            type: 'https://cellhive.io/errors/VALIDATION_FAILED',
            title: 'VALIDATION_FAILED',
            status: 422,
            code: 'VALIDATION_FAILED',
            request_id: 'req_0123456789ABCDEF',
            errors: [{ path: 'record_id', code: 'TOO_MANY_FOLLOWS', params: { maximum: 10_000 } }],
          }),
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
    });
    await renderApp(`${GRID_PATH}?record=${recordId(1)}`);
    const dialog = await panel();
    const button = await followButton(dialog, 'Follow');
    await userEvent.setup().click(button);
    expect(
      await screen.findByText(
        'You already follow 10,000 records, the most allowed. Unfollow some records first.',
      ),
    ).toBeVisible();
    await waitFor(() => {
      expect(button).toHaveAttribute('aria-pressed', 'false');
    });
    expect(button).toHaveAccessibleName('Follow');
  });

  it('a failed unfollow (500) puts "Following" back', async () => {
    serve({
      follow: { following: true, source: 'assigned' },
      remove: () => problem('INTERNAL', 500),
    });
    await renderApp(`${GRID_PATH}?record=${recordId(1)}`);
    const button = await followButton(await panel(), 'Following');
    await userEvent.setup().click(button);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await waitFor(() => {
      expect(button).toHaveAttribute('aria-pressed', 'true');
    });
    expect(button).toHaveAccessibleDescription(
      'You follow this record because you were assigned to it. Select to unfollow.',
    );
  });

  it('404 on a toggle: the record is gone — the panel closes with a toast', async () => {
    serve({ put: () => problem('NOT_FOUND', 404) });
    const { router } = await renderApp(`${GRID_PATH}?record=${recordId(1)}`);
    const dialog = await panel();
    await userEvent.setup().click(await followButton(dialog, 'Follow'));
    expect(
      await screen.findByText('This record was deleted or is no longer available to you.'),
    ).toBeVisible();
    await waitFor(() => {
      expect(router.state.location.search).toBe('');
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('readers follow records they can read', async () => {
    const { calls } = serve({ kind: 'reader' });
    await renderApp(`${GRID_PATH}?record=${recordId(2)}`);
    const button = await followButton(await panel(), 'Follow');
    await userEvent.setup().click(button);
    await waitFor(() => {
      expect(calls).toContain(`PUT ${recordId(2)}`);
    });
    expect(button).toHaveAttribute('aria-pressed', 'true');
  });

  it('below 640 px: only the bell shows, the label stays the name (44 px target)', async () => {
    stubScreen('max-width');
    serve({ follow: { following: true, source: 'created' } });
    await renderApp(`${GRID_PATH}?record=${recordId(1)}`);
    const dialog = await panel();
    const button = await followButton(dialog, 'Following');
    // `size="toolbar"`: `h-control min-w-control` (44 px below 1024 px); the label is sr-only there.
    expect(button).toHaveClass('h-control', 'min-w-control');
    expect(button.querySelector('span.grid')).toHaveClass('max-sm:sr-only');
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('the grid cell menu follows and unfollows, with a toast and "Undo"', async () => {
    const { calls } = serve();
    await renderApp(GRID_PATH);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'cell menu row 1' }));
    const item = await screen.findByRole('menuitem', { name: 'Follow record' });
    await waitFor(() => {
      expect(item).not.toHaveAttribute('data-disabled');
    });
    expect(await axeViolations(screen.getByRole('menu'))).toEqual([]);
    await user.click(item);
    expect(await screen.findByText(/You follow “Order 1”\./u)).toBeVisible();
    expect(calls).toContain(`PUT ${recordId(1)}`);

    // Undo from the toast.
    const toasts = screen.getByRole('region', { name: 'Notifications' });
    await user.click(within(toasts).getByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(calls).toContain(`DELETE ${recordId(1)}`);
    });

    // Reopened: the state is shared, so the item says what a click does now.
    clearToasts();
    await user.click(screen.getByRole('button', { name: 'cell menu row 1' }));
    expect(await screen.findByRole('menuitem', { name: 'Follow record' })).toBeVisible();
    await user.click(screen.getByRole('menuitem', { name: 'Follow record' }));
    await screen.findByText(/You follow “Order 1”\./u);
    await user.click(screen.getByRole('button', { name: 'cell menu row 1' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Unfollow record' }));
    expect(await screen.findByText('You no longer follow “Order 1”.')).toBeVisible();
    await waitFor(() => {
      expect(calls.filter((call) => call.startsWith('DELETE'))).toHaveLength(2);
    });
  });
});
