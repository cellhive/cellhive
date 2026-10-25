import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, ME, ORG, renderApp, stubApi } from '../../../../../test/app-harness';
import { axeViolations } from '../../../../../test/axe';
import { clearToasts } from '../../../../lib/toast/toast';

import type { IncomingWebhookDto } from '@cellhive/contracts';

const BASE = 'bse_0123456789ABCDEF';
const PATH = `/b/${BASE}/settings/webhooks`;
const NOW = '2026-10-18T03:00:00.000Z';
const TOKEN = 'Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmE';
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';

const HOOK: IncomingWebhookDto = {
  id: 'hok_0000000000000001',
  base_id: BASE,
  name: 'Shop orders',
  url: 'http://localhost/api/v1/hooks/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
  auth: 'both',
  enabled: true,
  rate_limit_per_sec: 5,
  signing_secret_rotating_until: null,
  listen_until: null,
  sample_captured_at: null,
  last_received_at: NOW,
  usages: [{ automation_id: 'aut_0000000000000001', name: 'Create order' }],
  created_by: { id: ME.user.id, name: 'Me' },
  created_at: NOW,
  updated_at: NOW,
};

function baseDetail(admin: boolean) {
  return {
    id: BASE,
    organization_id: ORG.id,
    workspace_id: 'wsp_0123456789ABCDEF',
    owner_id: ME.user.id,
    name: 'Sales',
    icon: null,
    description: null,
    permission_version: 3,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    access: {
      role: null,
      is_admin: admin,
      base_rule: { copy: true, download: true, share_link: true },
      tables: {},
      dashboards: {},
    },
  };
}

function serve(initial: IncomingWebhookDto[], admin = true) {
  let items = initial;
  const calls: { route: string; body: unknown; headers: Headers }[] = [];
  const record = (route: string, init: RequestInit | undefined) => {
    calls.push({
      route,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      headers: new Headers(init?.headers),
    });
  };
  stubApi({
    signedIn: true,
    routes: {
      [`GET /bases/${BASE}`]: () => json(baseDetail(admin)),
      [`GET /bases/${BASE}/tables`]: () => json({ items: [], total: 0, offset: 0, limit: 1000 }),
      [`GET /bases/${BASE}/tables/trash`]: () => json({ items: [] }),
      [`GET /bases/${BASE}/automations`]: () =>
        json({ items: [], total: 0, offset: 0, limit: 1000 }),
      [`GET /bases/${BASE}/incoming-webhooks`]: () => json({ items }),
      [`GET /incoming-webhooks/${HOOK.id}/requests`]: () =>
        json({
          items: [
            {
              id: 'whr_0000000000000001',
              received_at: NOW,
              size_bytes: 2048,
              duplicate: true,
              causation_accepted: false,
              event_id: null,
            },
          ],
          next_cursor: null,
        }),
      [`POST /bases/${BASE}/incoming-webhooks`]: (init) => {
        record('create', init);
        const created: IncomingWebhookDto = {
          ...HOOK,
          id: 'hok_0000000000000002',
          name: 'Form tool',
          auth: 'bearer',
          usages: [],
        };
        items = [...items, created];
        return json({ ...created, signing_secret: null, bearer_token: TOKEN }, 201);
      },
      [`POST /incoming-webhooks/${HOOK.id}/rotate-secret`]: (init) => {
        record('rotate', init);
        return json({
          ...HOOK,
          signing_secret_rotating_until: '2026-10-19T03:00:00.000Z',
          signing_secret: SECRET,
          bearer_token: null,
        });
      },
      [`DELETE /incoming-webhooks/${HOOK.id}`]: () =>
        new Response(
          JSON.stringify({
            type: 'x',
            title: 'x',
            status: 409,
            code: 'WEBHOOK_IN_USE',
            errors: [
              {
                path: '',
                code: 'WEBHOOK_IN_USE',
                message: 'x',
                params: { usages: HOOK.usages, total: 1 },
              },
            ],
          }),
          { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
        ),
    },
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

describe('IncomingWebhooksPage (T611)', () => {
  it('lists hooks with status, checks, automations and the last request; no secret', async () => {
    serve([HOOK]);
    await renderApp(PATH);
    const row = await screen.findByTestId('hook-row');
    expect(row).toHaveTextContent('Shop orders');
    expect(within(row).getByTestId('hook-status')).toHaveTextContent('Receiving');
    expect(within(row).getByTestId('hook-auth')).toHaveTextContent('Bearer + signature');
    expect(row).toHaveTextContent('Used by 1 automation: Create order');
    await waitFor(() => {
      expect(within(row).getByTestId('hook-last')).toHaveTextContent('Last request');
    });
    expect(document.body).not.toHaveTextContent('whsec_');
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('creates a hook (bearer by default) and shows the token once, closing only once confirmed', async () => {
    const { calls } = serve([]);
    const user = userEvent.setup();
    await renderApp(PATH);
    await user.click(await screen.findByTestId('hook-add'));
    const dialog = await screen.findByRole('dialog', { name: 'New incoming webhook' });
    expect(within(dialog).getByTestId('hook-auth-bearer')).toBeChecked();
    await user.click(within(dialog).getByTestId('hook-create-submit'));
    expect(within(dialog).getByText('Required.')).toBeInTheDocument();
    expect(calls).toEqual([]);
    // `none` needs the acknowledgement.
    await user.type(within(dialog).getByLabelText('Name'), 'Form tool');
    await user.click(within(dialog).getByTestId('hook-auth-none'));
    await user.click(within(dialog).getByTestId('hook-create-submit'));
    expect(within(dialog).getByTestId('hook-none-warning')).toHaveTextContent(
      'Anyone with the URL can call this webhook',
    );
    expect(calls).toEqual([]);
    await user.click(within(dialog).getByTestId('hook-auth-bearer'));
    await user.click(within(dialog).getByTestId('hook-create-submit'));
    await waitFor(() => {
      expect(calls.map((call) => call.body)).toEqual([
        { name: 'Form tool', auth: 'bearer', rate_limit_per_sec: 5 },
      ]);
    });
    expect(calls[0]?.headers.get('Idempotency-Key')).toMatch(/^web-/u);

    const reveal = await screen.findByTestId('secret-reveal');
    expect(within(reveal).getByTestId('reveal-bearer_token')).toHaveValue(TOKEN);
    expect(within(reveal).getByTestId('reveal-url')).toHaveValue(HOOK.url);
    expect(within(reveal).getByTestId('secret-reveal-warning')).toHaveTextContent(
      'Shown only once',
    );
    // Escape and "Done" refuse until the user confirms.
    const native = reveal.closest('dialog');
    if (native === null) throw new Error('no dialog');
    fireEvent(native, new Event('cancel', { cancelable: true }));
    expect(await within(reveal).findByRole('alert')).toHaveTextContent(
      'Confirm that you stored the secret first',
    );
    await user.click(within(reveal).getByTestId('secret-reveal-done'));
    expect(screen.getByTestId('secret-reveal')).toBeInTheDocument();
    await user.click(within(reveal).getByTestId('secret-reveal-confirm'));
    await user.click(within(reveal).getByTestId('secret-reveal-done'));
    await waitFor(() => {
      expect(screen.queryByTestId('secret-reveal')).toBeNull();
    });
    expect(document.body).not.toHaveTextContent(TOKEN);
    expect(await screen.findAllByTestId('hook-row')).toHaveLength(1);
  });

  it('rotates the signing secret from the drawer: confirmation, then the new secret once', async () => {
    const { calls } = serve([HOOK]);
    const user = userEvent.setup();
    await renderApp(`${PATH}?hook=${HOOK.id}`);
    const drawer = await screen.findByTestId('hook-drawer');
    expect(within(drawer).getByTestId('hook-url')).toHaveValue(HOOK.url);
    await user.click(within(drawer).getByTestId('hook-rotate'));
    const confirm = await screen.findByRole('alertdialog', { name: 'Rotate the signing secret?' });
    expect(confirm).toHaveTextContent('keeps working for 24 hours');
    await user.click(within(confirm).getByTestId('hook-confirm-confirm'));
    const reveal = await screen.findByTestId('secret-reveal');
    expect(within(reveal).getByTestId('reveal-signing_secret')).toHaveValue(SECRET);
    expect(within(reveal).queryByTestId('reveal-url')).toBeNull();
    expect(calls.map((call) => call.route)).toEqual(['rotate']);
  });

  it('switches drawer tabs with the arrow keys and shows the log without bodies', async () => {
    serve([HOOK]);
    const user = userEvent.setup();
    await renderApp(`${PATH}?hook=${HOOK.id}`);
    const settingsTab = await screen.findByTestId('hook-tab-settings');
    settingsTab.focus();
    await user.keyboard('{ArrowRight}');
    // The tab is in the URL (`?tab=`): the router applies it asynchronously.
    await waitFor(() => {
      expect(screen.getByTestId('hook-tab-requests')).toHaveAttribute('aria-selected', 'true');
    });
    expect(screen.getByTestId('hook-tab-requests')).toHaveFocus();
    const row = await screen.findByTestId('hook-log-row');
    expect(row).toHaveTextContent('Size 2 KB');
    expect(within(row).getByTestId('hook-log-duplicate')).toBeInTheDocument();
  });

  it('delete lists the automations using the hook (and the 409 list)', async () => {
    serve([HOOK]);
    const user = userEvent.setup();
    await renderApp(`${PATH}?hook=${HOOK.id}`);
    await user.click(await screen.findByTestId('hook-delete'));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete “Shop orders”?' });
    expect(within(dialog).getByTestId('hook-delete-usages')).toHaveTextContent('Create order');
    expect(within(dialog).getByTestId('hook-delete-dialog-confirm')).toBeDisabled();
  });

  it('is the 404 screen for someone who is not a base admin', async () => {
    serve([HOOK], false);
    await renderApp(PATH);
    expect(await screen.findByText(/404|not found/iu)).toBeInTheDocument();
    expect(screen.queryByTestId('hook-list')).toBeNull();
  });
});
