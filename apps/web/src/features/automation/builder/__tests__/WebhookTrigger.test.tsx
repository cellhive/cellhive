import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, ME, ORG, renderApp, stubApi } from '../../../../../test/app-harness';
import { axeViolations } from '../../../../../test/axe';
import { BASE_ID, FIELD, fieldList, NOW, TABLE_ID } from '../../../../../test/records';
import { clearToasts } from '../../../../lib/toast/toast';

/** Every `user:` handler of the page, to play a realtime message (the test socket never opens). */
const handlers = vi.hoisted(
  () => new Map<string, { onMessage?: (message: unknown) => void; onReconnect?: () => void }[]>(),
);
vi.mock('../../../../lib/realtime/channels', async (importActual) => {
  const actual = await importActual<typeof import('../../../../lib/realtime/channels')>();
  return {
    ...actual,
    useRealtimeChannel: (channel: string | null, options: Record<string, unknown>) => {
      if (channel === null) return;
      const list = handlers.get(channel) ?? [];
      const key = String(Object.keys(options).sort());
      const index = list.findIndex((item) => String(Object.keys(item).sort()) === key);
      if (index === -1) list.push(options);
      else list[index] = options;
      handlers.set(channel, list);
    },
  };
});

/**
 * T612: the `webhook.received` trigger in the builder — the hook of the
 * base and its URL, "Listen for a sample request" (countdown, realtime
 * `incoming_webhook.sample_captured`), the sample as a keyboard tree, and
 * its paths in the "+" menu of a step's value; base admins only.
 */

const AUTOMATION_ID = 'aut_Webhook000000001';
const HOOK_ID = 'hok_Shop000000000001';
const SELF = { id: ME.user.id, name: ME.user.display_name };
const HOOK_URL =
  'https://cellhive.example.com/api/v1/hooks/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

function base(admin: boolean) {
  return {
    id: BASE_ID,
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
      tables: {
        [TABLE_ID]: {
          perm: 'manage',
          operations: ['add', 'delete'],
          view_rule: { allow_edit: true, visible_views: null },
          read_scope: 'all',
          fields: {},
          option_edit_fields: [],
          file_download_fields: [],
        },
      },
      dashboards: {},
    },
  };
}

const HOOK = {
  id: HOOK_ID,
  base_id: BASE_ID,
  name: 'Shop orders',
  url: HOOK_URL,
  auth: 'bearer',
  enabled: true,
  rate_limit_per_sec: 5,
  signing_secret_rotating_until: null,
  listen_until: null,
  sample_captured_at: null,
  last_received_at: null,
  usages: [{ automation_id: AUTOMATION_ID, name: 'Orders in' }],
  created_by: SELF,
  created_at: NOW,
  updated_at: NOW,
};

const SAMPLE = {
  body: { order: 42, customer: { email: 'lan@example.com', name: 'Lan' } },
  headers: { 'content-type': 'application/json' },
  query: { source: 'shop' },
  truncated: false,
  received_at: '2026-10-18T10:00:00.000Z',
};

const AUTOMATION = {
  id: AUTOMATION_ID,
  base_id: BASE_ID,
  name: 'Orders in',
  description: '',
  enabled: false,
  disabled_reason: null,
  version: 2,
  definition: {
    trigger: { type: 'webhook.received', incoming_webhook_id: HOOK_ID },
    condition: null,
    actions: [
      {
        id: 'act_1',
        type: 'create_record',
        config: { table_id: TABLE_ID, fields: { [FIELD.notes]: { literal: 'New order' } } },
      },
    ],
  },
  run_as: SELF,
  run_as_since: NOW,
  created_by: SELF,
  created_at: NOW,
  updated_at: NOW,
};

const NO_RUNS = {
  queued: 0,
  running: 0,
  waiting: 0,
  succeeded: 0,
  failed: 0,
  skipped: 0,
  cancelled: 0,
};
/** The list's item: the automation with its run summary. */
const LISTED = {
  ...AUTOMATION,
  last_run: null,
  errors_24h: 0,
  run_counts_24h: NO_RUNS,
  run_counts_7d: NO_RUNS,
};

const TABLES = {
  items: [
    {
      id: TABLE_ID,
      base_id: BASE_ID,
      name: 'Orders',
      description: null,
      primary_field_id: FIELD.title,
      position: 0,
      schema_state: 'ready',
      created_at: NOW,
      updated_at: NOW,
    },
  ],
  total: 1,
  offset: 0,
  limit: 1000,
};

function serve(options: { admin?: boolean; hooks?: unknown[] } = {}) {
  const calls: string[] = [];
  const patches: Record<string, unknown>[] = [];
  const state = { sample: null as typeof SAMPLE | null, listenUntil: null as string | null };
  stubApi({
    signedIn: true,
    routes: {
      [`GET /bases/${BASE_ID}`]: () => json(base(options.admin ?? true)),
      [`GET /orgs/${ORG.id}`]: () => json(ORG),
      [`GET /bases/${BASE_ID}/tables`]: () => json(TABLES),
      [`GET /tables/${TABLE_ID}/fields`]: () => json(fieldList()),
      [`GET /tables/${TABLE_ID}/views`]: () =>
        json({ items: [], total: 0, offset: 0, limit: 1000 }),
      [`GET /bases/${BASE_ID}/automations`]: () =>
        json({ items: [LISTED], total: 1, offset: 0, limit: 1000 }),
      [`GET /automations/${AUTOMATION_ID}`]: () => json(AUTOMATION),
      [`GET /bases/${BASE_ID}/incoming-webhooks`]: () => json({ items: options.hooks ?? [HOOK] }),
      [`POST /incoming-webhooks/${HOOK_ID}/listen`]: () => {
        calls.push('listen');
        state.listenUntil = new Date(Date.now() + 180_000).toISOString();
        return json({ listen_until: state.listenUntil });
      },
      [`DELETE /incoming-webhooks/${HOOK_ID}/listen`]: () => {
        calls.push('stop');
        state.listenUntil = null;
        return new Response(null, { status: 204 });
      },
      [`GET /incoming-webhooks/${HOOK_ID}/sample`]: () =>
        json({ sample: state.sample, listen_until: state.listenUntil }),
      [`PATCH /automations/${AUTOMATION_ID}`]: (init) => {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        patches.push(body);
        return json({ ...AUTOMATION, ...body, version: 3 });
      },
    },
  });
  return { calls, patches, state };
}

function playSampleCaptured(hookId = HOOK_ID) {
  act(() => {
    for (const handler of handlers.get(`user:${ME.user.id}`) ?? []) {
      handler.onMessage?.({
        type: 'incoming_webhook.sample_captured',
        channel: `user:${ME.user.id}`,
        organization_id: ORG.id,
        incoming_webhook_id: hookId,
      });
    }
  });
}

afterEach(() => {
  clearToasts();
  handlers.clear();
});

describe('webhook.received in the builder (T612)', () => {
  it('listens, receives the sample by realtime, browses it by keyboard and maps a path', async () => {
    const { calls, patches, state } = serve();
    await renderApp(`/b/${BASE_ID}/automations/${AUTOMATION_ID}`);
    const panel = await screen.findByTestId('webhook-trigger');
    const hook = await within(panel).findByTestId('webhook-trigger-hook');
    await waitFor(() => {
      expect(hook).toHaveValue(HOOK_ID);
    });
    expect(within(panel).getByTestId('webhook-trigger-url')).toHaveValue(HOOK_URL);
    expect(within(panel).getByText(/still runs the automations of this webhook/u)).toBeVisible();
    // The trigger card names the hook.
    expect(screen.getByTestId('step-trigger')).toHaveTextContent('Shop orders');
    expect(await within(panel).findByTestId('webhook-listen-idle')).toBeVisible();
    expect(await axeViolations(document.body)).toEqual([]);

    await userEvent.click(within(panel).getByTestId('webhook-listen-start'));
    expect(await within(panel).findByTestId('webhook-listen-waiting')).toBeVisible();
    expect(calls).toEqual(['listen']);
    expect(within(panel).getByTestId('webhook-listen-countdown')).toHaveTextContent(
      /[23]:\d\d left/u,
    );
    // The state change is announced once; the countdown is not.
    expect(
      within(panel).getByText('Listening for a sample request for 3 minutes.'),
    ).toHaveAttribute('role', 'status');
    expect(await axeViolations(document.body)).toEqual([]);

    // A request arrives: the server stores it and tells this user.
    state.sample = SAMPLE;
    state.listenUntil = null;
    playSampleCaptured('hok_Other00000000001');
    expect(within(panel).getByTestId('webhook-listen-waiting')).toBeVisible();
    playSampleCaptured();
    expect(await within(panel).findByTestId('webhook-listen-captured')).toBeVisible();
    const tree = within(panel).getByRole('tree', { name: 'Sample request data' });
    expect(tree).not.toHaveTextContent('authorization');
    expect(await axeViolations(document.body)).toEqual([]);

    // Keyboard: Body (open) → order → customer; → opens it; ↓ goes to email; Enter chooses.
    const body = within(tree).getByRole('treeitem', { name: /Body/u });
    expect(body).toHaveAttribute('aria-expanded', 'true');
    body.focus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    const customer = within(tree).getByRole('treeitem', { name: /customer/u });
    expect(customer).toHaveFocus();
    expect(customer).toHaveAttribute('aria-expanded', 'false');
    await userEvent.keyboard('{ArrowRight}');
    expect(customer).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{ArrowRight}');
    const email = within(tree).getByRole('treeitem', { name: /email/u });
    expect(email).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(email).toHaveAttribute('aria-selected', 'true');
    expect(within(panel).getByTestId('sample-path-reference')).toHaveTextContent(
      '{{ [@body.customer.email] }}',
    );
    await userEvent.keyboard('{ArrowLeft}');
    expect(customer).toHaveFocus();

    // The step maps the sample's `body.order` to Amount from the "+" menu.
    const stepButton = screen.getByTestId('step-act_1').querySelector('[data-step-button]');
    if (stepButton === null) throw new Error('no step button');
    await userEvent.click(stepButton);
    const config = await screen.findByTestId('config-panel');
    await userEvent.selectOptions(within(config).getByTestId('field-map-add'), FIELD.amount);
    await userEvent.click(
      within(config).getByRole('button', { name: /Choose a value for .*Amount/u }),
    );
    const picker = await within(config).findByTestId('value-picker');
    expect(within(picker).getByRole('group', { name: 'Webhook data' })).toBeVisible();
    await userEvent.click(within(picker).getByRole('option', { name: /^body\.order/u }));
    expect(within(config).getByTestId(`field-map-row-${FIELD.amount}`)).toHaveTextContent(
      'body.order',
    );
    await userEvent.click(screen.getByTestId('builder-save'));
    await waitFor(() => {
      expect(patches).toHaveLength(1);
    });
    expect(patches[0]).toMatchObject({
      definition: {
        trigger: { type: 'webhook.received', incoming_webhook_id: HOOK_ID },
        condition: null,
        actions: [
          {
            config: {
              fields: { [FIELD.amount]: { trigger: 'body', path: 'order' } },
            },
          },
        ],
      },
    });
  });

  it('stops listening', async () => {
    const { calls } = serve();
    await renderApp(`/b/${BASE_ID}/automations/${AUTOMATION_ID}`);
    const panel = await screen.findByTestId('webhook-trigger');
    await userEvent.click(await within(panel).findByTestId('webhook-listen-start'));
    await userEvent.click(await within(panel).findByTestId('webhook-listen-stop'));
    expect(await within(panel).findByTestId('webhook-listen-idle')).toBeVisible();
    expect(calls).toEqual(['listen', 'stop']);
  });

  it('explains a base without hooks and offers to create one', async () => {
    serve({ hooks: [] });
    await renderApp(`/b/${BASE_ID}/automations/${AUTOMATION_ID}`);
    const empty = await screen.findByTestId('webhook-trigger-empty');
    expect(empty).toHaveTextContent('This base has no incoming webhook yet.');
    await userEvent.click(within(empty).getByTestId('webhook-trigger-create'));
    expect(await screen.findByRole('dialog', { name: 'New incoming webhook' })).toBeVisible();
  });

  it('is base admins only in the trigger picker and the create dialog; the list names the hook', async () => {
    serve({ admin: false });
    await renderApp(`/b/${BASE_ID}/automations/new?trigger=record.created&name=X`);
    const type = await screen.findByTestId('trigger-type');
    expect(
      within(type).getByRole('option', {
        name: 'When a webhook request is received (base admins only)',
      }),
    ).toBeDisabled();
  });

  it('offers the trigger to base admins when creating, and names hooks in the list', async () => {
    serve();
    await renderApp(`/b/${BASE_ID}/automations`);
    const table = await screen.findByTestId('automation-table');
    const row = within(table).getByTestId(`automation-row-${AUTOMATION_ID}`);
    expect(within(row).getByText('When a webhook request is received')).toBeVisible();
    expect(await within(row).findByText('Shop orders')).toBeVisible();
    await userEvent.click(screen.getByTestId('create-automation'));
    const dialog = await screen.findByTestId('create-automation-dialog');
    expect(within(dialog).getByTestId('trigger-webhook.received')).toBeEnabled();
  });
});
