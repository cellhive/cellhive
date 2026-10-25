import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, ME, problem, renderApp, stubApi } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import {
  BASE_ID,
  baseDetail,
  fieldList,
  NOW,
  record,
  recordId,
  TABLE,
  TABLE_ID,
  type AccessKind,
} from '../../../../test/records';
import { resetRunningClicks } from '../../../lib/buttons/runs';
import { clearToasts } from '../../../lib/toast/toast';

import type { ChannelMessage } from '../../../lib/realtime/socket';

/**
 * T525: a button field in the record panel — confirmation, the click, the
 * spinner until `automation.run.finished` on `user:<me>`, the toast, the
 * cells read again; disabled buttons say why; `429` says when to retry.
 */

// The canvas grid needs a real browser (E2E): a stand-in.
vi.mock('../../../grid/GridView', () => ({
  GridView: ({ label }: { label: string }) => <section aria-label={label} data-testid="grid" />,
}));

/** Handlers of `user:` subscriptions, to push `automation.run.finished`. */
const userHandlers = new Set<(message: ChannelMessage) => void>();
vi.mock('../../../lib/realtime/channels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/realtime/channels')>();
  return {
    ...actual,
    useRealtimeChannel: (
      channel: string | null,
      options: { onMessage?: (message: ChannelMessage) => void },
    ) => {
      if (channel?.startsWith('user:') === true && options.onMessage !== undefined) {
        userHandlers.add((message) => options.onMessage?.(message));
      }
      actual.useRealtimeChannel(channel, options);
    },
  };
});

const BUTTON = 'fld_Approve000000001';
const AUTOMATION = 'aut_Approve000000001';
const RUN = 'run_Approve000000001';

function buttonField(confirm: Record<string, unknown> | null) {
  return {
    id: BUTTON,
    table_id: TABLE_ID,
    name: 'Quick approve',
    type: 'button',
    options: { label: 'Approve', color: 5, confirm },
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 6,
    created_at: NOW,
    updated_at: NOW,
    button: { automation_id: AUTOMATION, automation_enabled: true, min_permission: 'edit' },
  };
}

interface Server {
  readonly kind?: AccessKind;
  readonly cell: unknown;
  readonly confirm?: Record<string, unknown> | null;
  readonly click?: () => Response;
}

function serve(server: Server) {
  const clicks: RequestInit[] = [];
  const reads: string[] = [];
  const item = record(1, { [BUTTON]: server.cell });
  const fields = fieldList([buttonField(server.confirm ?? null)]);
  stubApi({
    signedIn: true,
    routes: {
      [`GET /bases/${BASE_ID}`]: () => json(baseDetail(server.kind ?? 'editor')),
      [`GET /bases/${BASE_ID}/tables`]: () =>
        json({ items: [TABLE], total: 1, offset: 0, limit: 1000 }),
      [`GET /tables/${TABLE_ID}`]: () => json(TABLE),
      [`GET /tables/${TABLE_ID}/fields`]: () => json(fields),
      [`POST /tables/${TABLE_ID}/records/query`]: () =>
        json({ records: [item], total: 1, offset: 0, limit: 200 }),
      [`GET /tables/${TABLE_ID}/records/${item.id}`]: () => {
        reads.push(item.id);
        return json(item);
      },
      [`GET /tables/${TABLE_ID}/records/${item.id}/history`]: () =>
        json({ items: [], next_cursor: null }),
      [`POST /tables/${TABLE_ID}/records/${item.id}/buttons/${BUTTON}/click`]: (init) => {
        clicks.push(init ?? {});
        return server.click?.() ?? json({ run_id: RUN }, 202);
      },
    },
  });
  return { clicks, reads };
}

async function openPanel() {
  await renderApp(`/b/${BASE_ID}/t/${TABLE_ID}?record=${recordId(1)}`);
  return screen.findByRole('dialog', { name: /Order 1/u }, { timeout: 12_000 });
}

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
  window.localStorage.clear();
});

afterEach(() => {
  clearToasts();
  resetRunningClicks();
  userHandlers.clear();
});

describe('button fields in the record panel (T525)', () => {
  it('confirms, clicks, spins until the run finishes, then says so; no axe violations', async () => {
    const { clicks, reads } = serve({
      cell: { state: 'ready', reason: null },
      confirm: {
        title: 'Approve this order?',
        message: 'It cannot be undone.',
        confirm_label: 'Yes, approve',
      },
    });
    const dialog = await openPanel();
    const user = userEvent.setup();
    const group = within(dialog).getByRole('group', { name: 'Quick approve' });
    const button = within(group).getByRole('button', { name: 'Approve' });
    // No cell history: a button stores nothing.
    expect(within(group).queryByRole('button', { name: /History/u })).toBeNull();
    expect(await axeViolations(document.body)).toEqual([]);

    await user.click(button);
    const confirm = await screen.findByRole('alertdialog', { name: 'Approve this order?' });
    expect(within(confirm).getByText('It cannot be undone.')).toBeVisible();
    expect(clicks).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Yes, approve' }));

    await waitFor(() => {
      expect(clicks).toHaveLength(1);
    });
    expect(new Headers(clicks[0]?.headers).get('Idempotency-Key')).toMatch(/^web-/u);
    const running = await within(group).findByRole('button', { name: 'Running…' });
    expect(running).toHaveAttribute('aria-busy', 'true');
    // A second press while it runs sends nothing.
    await user.click(running);
    expect(clicks).toHaveLength(1);

    const before = reads.length;
    act(() => {
      for (const handler of userHandlers) {
        handler({
          type: 'automation.run.finished',
          channel: `user:${ME.user.id}`,
          run_id: RUN,
          organization_id: 'org_0123456789ABCDEF',
          automation_id: AUTOMATION,
          table_id: TABLE_ID,
          record_id: recordId(1),
          status: 'succeeded',
        } as ChannelMessage);
      }
    });
    expect(await screen.findByText('«Approve» finished for Order 1.')).toBeVisible();
    // Only managers of the automation get "View run".
    expect(screen.queryByRole('button', { name: 'View run' })).toBeNull();
    expect(await within(group).findByRole('button', { name: 'Approve' })).not.toHaveAttribute(
      'aria-busy',
    );
    // The button cells are read again (never pushed by realtime).
    await waitFor(() => {
      expect(reads.length).toBeGreaterThan(before);
    });
  });

  it('a disabled button says why and sends nothing', async () => {
    const { clicks } = serve({ kind: 'reader', cell: { state: 'disabled', reason: 'permission' } });
    const dialog = await openPanel();
    const button = within(within(dialog).getByRole('group', { name: 'Quick approve' })).getByRole(
      'button',
      { name: 'Approve' },
    );
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAccessibleDescription(
      'You need permission to edit this record to use this button.',
    );
    await userEvent.setup().click(button);
    expect(clicks).toHaveLength(0);
  });

  it('429: says when to try again', async () => {
    serve({
      cell: { state: 'ready', reason: null },
      click: () => {
        const answer = problem('RATE_LIMITED', 429);
        answer.headers.set('Retry-After', '42');
        return answer;
      },
    });
    const dialog = await openPanel();
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('You clicked too fast. Try again in 42 seconds.')).toBeVisible();
    // The button is ready again at once (the server counts, the toast counts down).
    expect(within(dialog).getByRole('button', { name: 'Approve' })).not.toHaveAttribute(
      'aria-busy',
    );
  });

  it('422 BUTTON_DISABLED: the state changed meanwhile', async () => {
    serve({
      cell: { state: 'ready', reason: null },
      click: () =>
        json(
          {
            type: 'https://cellhive.io/errors/VALIDATION_FAILED',
            title: 'VALIDATION_FAILED',
            status: 422,
            code: 'VALIDATION_FAILED',
            errors: [
              { path: 'field_id', code: 'BUTTON_DISABLED', params: { reason: 'condition' } },
            ],
            request_id: 'req_0123456789ABCDEF',
          },
          422,
        ),
    });
    const dialog = await openPanel();
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(
      await screen.findByText("This record does not meet the button's condition."),
    ).toBeVisible();
  });
});
