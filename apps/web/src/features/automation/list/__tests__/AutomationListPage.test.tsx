import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, ME, ORG, problem, renderApp, stubApi } from '../../../../../test/app-harness';
import { axeViolations } from '../../../../../test/axe';
import { BASE_ID, FIELD, fieldList, NOW, OPTION, TABLE_ID } from '../../../../../test/records';
import { clearToasts } from '../../../../lib/toast/toast';

import type { ChannelMessage } from '../../../../lib/realtime/socket';

/** The page's `user:` handlers, to play a realtime message (the test socket never opens). */
const channels = vi.hoisted(
  () =>
    new Map<
      string,
      { onMessage?: (message: unknown) => void; onReconnect?: () => void } | undefined
    >(),
);
vi.mock('../../../../lib/realtime/channels', async (importActual) => {
  const actual = await importActual<typeof import('../../../../lib/realtime/channels')>();
  return {
    ...actual,
    useRealtimeChannel: (channel: string | null, options: Record<string, unknown>) => {
      if (channel !== null) channels.set(channel, options);
    },
  };
});

const OTHER = { id: 'usr_Other00000000001', name: 'Trần Thu Hà' };
const SELF = { id: ME.user.id, name: ME.user.display_name };

function tableAccess(perm: 'read_only' | 'edit' | 'manage') {
  return {
    perm,
    operations: ['add', 'delete'],
    view_rule: { allow_edit: false, visible_views: null },
    read_scope: 'all',
    fields: {},
    option_edit_fields: [],
    file_download_fields: [],
  };
}

function base(kind: 'admin' | 'manager' | 'editor') {
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
      is_admin: kind === 'admin',
      base_rule: { copy: true, download: true, share_link: true },
      tables: { [TABLE_ID]: tableAccess(kind === 'editor' ? 'edit' : 'manage') },
      dashboards: {},
    },
  };
}

const NO_RUNS = {
  queued: 0,
  running: 0,
  waiting: 0,
  succeeded: 0,
  failed: 0,
  skipped: 0,
  cancelled: 0,
};

let serial = 0;
function automation(overrides: Record<string, unknown> = {}) {
  serial += 1;
  return {
    id: `aut_Auto${String(serial).padStart(12, '0')}`,
    base_id: BASE_ID,
    name: `Automation ${String(serial)}`,
    description: '',
    enabled: true,
    disabled_reason: null as string | null,
    version: 3,
    definition: {
      trigger: {
        type: 'record.updated',
        table_id: TABLE_ID,
        watch_fields: [FIELD.status],
        skip_bulk: false,
      },
      condition: null,
      actions: [
        {
          id: 'act_1',
          type: 'update_record',
          config: {
            table_id: TABLE_ID,
            record_id: null,
            fields: { [FIELD.notes]: { literal: 'x' } },
          },
        },
      ],
    },
    run_as: SELF,
    run_as_since: NOW,
    created_by: SELF,
    created_at: NOW,
    updated_at: NOW,
    // Run counts of the list (T518).
    last_run: null as Record<string, unknown> | null,
    errors_24h: 0,
    run_counts_24h: NO_RUNS,
    run_counts_7d: NO_RUNS,
    ...overrides,
  };
}

type Automation = ReturnType<typeof automation>;

/** A write's answer: the automation without the run counts of the list (`Automation`, C§21). */
function dtoOf(item: Automation | undefined) {
  if (item === undefined) return item;
  const dto: Partial<Automation> = { ...item };
  delete dto.last_run;
  delete dto.errors_24h;
  delete dto.run_counts_24h;
  delete dto.run_counts_7d;
  return dto;
}

interface Call {
  method: string;
  path: string;
  body: unknown;
  ifMatch: string | null;
}

/** (T556) What `POST /automations/:id/duplicate` answers per source: the copy, or a refusal. */
type DuplicateAnswer = Automation | 'button' | 'permissions';

function serve(
  kind: 'admin' | 'manager' | 'editor',
  initial: Automation[],
  duplicates: Readonly<Record<string, DuplicateAnswer>> = {},
  extra: Record<string, (init: RequestInit | undefined) => Response> = {},
) {
  let items = initial;
  const calls: Call[] = [];
  const record = (method: string, path: string, init: RequestInit | undefined) => {
    const headers = new Headers(init?.headers);
    calls.push({
      method,
      path,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      ifMatch: headers.get('If-Match'),
    });
  };
  const update = (id: string, patch: Record<string, unknown>) => {
    items = items.map((item) =>
      item.id === id ? { ...item, ...patch, version: item.version + 1 } : item,
    );
    return items.find((item) => item.id === id);
  };
  const routes: Record<string, (init: RequestInit | undefined) => Response> = {
    [`GET /bases/${BASE_ID}`]: () => json(base(kind)),
    [`GET /bases/${BASE_ID}/tables`]: () =>
      json({
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
      }),
    [`GET /tables/${TABLE_ID}/fields`]: () => json(fieldList()),
    [`POST /tables/${TABLE_ID}/records/query`]: () =>
      json({ records: [], total: 0, offset: 0, limit: 1 }),
    [`GET /bases/${BASE_ID}/automations`]: () =>
      kind === 'editor'
        ? problem('PERMISSION_DENIED', 403)
        : json({ items, total: items.length, offset: 0, limit: 1000 }),
    [`POST /bases/${BASE_ID}/automations`]: (init) => {
      record('POST', 'create', init);
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      const created = automation({
        name: body['name'],
        enabled: false,
        definition: {
          ...(body['definition'] as object),
          condition: null,
          actions: [],
        },
      });
      items = [...items, created];
      return json(dtoOf(created), 201);
    },
  };
  for (const item of initial) {
    routes[`POST /automations/${item.id}/enable`] = (init) => {
      record('POST', 'enable', init);
      return json(dtoOf(update(item.id, { enabled: true, disabled_reason: null, run_as: SELF })));
    };
    routes[`POST /automations/${item.id}/disable`] = (init) => {
      record('POST', 'disable', init);
      return json(dtoOf(update(item.id, { enabled: false })));
    };
    routes[`POST /automations/${item.id}/take-over`] = (init) => {
      record('POST', 'take-over', init);
      const body = JSON.parse(init?.body as string) as { enable: boolean };
      return json(
        dtoOf(
          update(item.id, {
            run_as: SELF,
            disabled_reason: null,
            ...(body.enable ? { enabled: true } : {}),
          }),
        ),
      );
    };
    routes[`DELETE /automations/${item.id}`] = (init) => {
      record('DELETE', 'delete', init);
      items = items.filter((other) => other.id !== item.id);
      return new Response(null, { status: 204 });
    };
  }
  for (const [sourceId, answer] of Object.entries(duplicates)) {
    routes[`POST /automations/${sourceId}/duplicate`] = (init) => {
      record('POST', 'duplicate', init);
      if (answer === 'button' || answer === 'permissions') {
        return new Response(
          JSON.stringify({
            type: 'x',
            title: 'x',
            status: 422,
            code: 'AUTOMATION_INVALID',
            errors:
              answer === 'button'
                ? [
                    {
                      path: 'definition.trigger.field_id',
                      code: 'BUTTON_IN_USE',
                      message: 'x',
                      params: { automation_id: sourceId, reason: 'duplicate' },
                    },
                  ]
                : [
                    {
                      path: 'definition.actions[0].config.fields.fld_cost',
                      code: 'UNKNOWN_FIELD',
                      message: 'x',
                      params: {},
                    },
                  ],
          }),
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        );
      }
      items = [...items, answer];
      return json(dtoOf(answer), 201);
    };
    if (typeof answer !== 'string') {
      routes[`GET /automations/${answer.id}`] = () => json(dtoOf(answer));
    }
  }
  Object.assign(routes, extra);
  const fetchMock = stubApi({ signedIn: true, routes });
  return {
    calls,
    fetchMock,
    setItems: (next: Automation[]) => {
      items = next;
    },
  };
}

const PAGE = `/b/${BASE_ID}/automations`;

afterEach(() => {
  clearToasts();
  channels.clear();
});

describe('AutomationListPage (T520)', () => {
  it('lists automations with their trigger, run_as and the sidebar entry', async () => {
    const own = automation({ name: 'Báo khi đơn xong' });
    const theirs = automation({
      name: 'Gửi email',
      run_as: OTHER,
      enabled: false,
      last_run: {
        id: 'run_Run0000000000001',
        status: 'failed',
        error_code: 'invalid_value',
        created_at: NOW,
        finished_at: NOW,
      },
      errors_24h: 3,
      run_counts_24h: { ...NO_RUNS, failed: 3 },
      run_counts_7d: { ...NO_RUNS, failed: 3, succeeded: 4 },
    });
    serve('admin', [own, theirs]);
    await renderApp(PAGE);
    const table = await screen.findByTestId('automation-table');
    const row = within(table).getByTestId(`automation-row-${own.id}`);
    expect(within(row).getByText('Báo khi đơn xong')).toBeVisible();
    expect(within(row).getByText('When a record is updated')).toBeVisible();
    expect(within(row).getByText('Orders · watching Status')).toBeVisible();
    expect(within(row).getByText(ME.user.display_name)).toBeVisible();
    expect(within(row).getByText('Never run')).toBeVisible();
    expect(within(row).getByText('0')).toBeVisible();
    const failing = within(table).getByTestId(`automation-row-${theirs.id}`);
    expect(within(failing).getByText('Failed')).toBeVisible();
    expect(within(failing).getByText('3')).toHaveClass('text-danger');
    expect(await screen.findByTestId('base-automations-count')).toHaveTextContent('2');
    expect(screen.getByTestId('status-on')).toHaveTextContent('On1');
    expect(await axeViolations(document.body)).toEqual([]);

    await userEvent.type(screen.getByTestId('automation-search'), 'gui');
    expect(within(table).queryByTestId(`automation-row-${own.id}`)).toBeNull();
    expect(within(table).getByTestId(`automation-row-${theirs.id}`)).toBeVisible();
  });

  it('turns off at once, and asks before running as the caller instead of someone else', async () => {
    const own = automation({ name: 'Mine' });
    const theirs = automation({ name: 'Theirs', run_as: OTHER, enabled: false });
    const { calls } = serve('admin', [own, theirs]);
    await renderApp(PAGE);
    await userEvent.click(await screen.findByRole('switch', { name: 'Turn on Mine' }));
    await waitFor(() => {
      expect(calls).toContainEqual({ method: 'POST', path: 'disable', body: null, ifMatch: '"3"' });
    });
    expect(await screen.findByText('“Mine” is off.')).toBeVisible();

    await userEvent.click(screen.getByRole('switch', { name: 'Turn on Theirs' }));
    const dialog = await screen.findByTestId('enable-automation-dialog');
    expect(dialog).toHaveTextContent('“Theirs” runs with the permissions of Trần Thu Hà.');
    expect(dialog).toHaveTextContent(
      'Once on, it will run with your permissions instead of Trần Thu Hà’s.',
    );
    expect(calls.some((call) => call.path === 'enable')).toBe(false);
    expect(await axeViolations(document.body)).toEqual([]);
    await userEvent.click(within(dialog).getByTestId('enable-automation-confirm'));
    await waitFor(() => {
      expect(calls).toContainEqual({ method: 'POST', path: 'enable', body: null, ifMatch: '"3"' });
    });
    expect(await screen.findByRole('switch', { name: 'Turn on Theirs' })).toBeChecked();
  });

  it('explains automations the system turned off and fixes them', async () => {
    const breaker = automation({
      name: 'Breaker',
      enabled: false,
      disabled_reason: 'circuit_breaker',
    });
    const lost = automation({
      name: 'Lost',
      enabled: false,
      disabled_reason: 'run_as_lost_access',
      run_as: OTHER,
    });
    const { calls } = serve('admin', [breaker, lost]);
    await renderApp(PAGE);
    const breakerNote = await screen.findByTestId(`disabled-note-${breaker.id}`);
    expect(breakerNote).toHaveTextContent('50 runs in a row failed');
    await userEvent.click(within(breakerNote).getByRole('button', { name: 'Turn back on' }));
    await waitFor(() => {
      expect(calls.map((call) => call.path)).toContain('enable');
    });

    const lostNote = screen.getByTestId(`disabled-note-${lost.id}`);
    expect(lostNote).toHaveTextContent(
      'Trần Thu Hà (who it runs as) no longer has the permissions',
    );
    await userEvent.click(within(lostNote).getByRole('button', { name: 'Take over' }));
    const dialog = await screen.findByTestId('take-over-dialog');
    expect(within(dialog).getByTestId('take-over-reads')).toHaveTextContent('Read: Orders');
    expect(within(dialog).getByTestId('take-over-writes')).toHaveTextContent(
      'Write: Orders (fields Notes)',
    );
    expect(
      within(dialog).getByRole('checkbox', { name: 'Turn it back on right after' }),
    ).toBeChecked();
    expect(await axeViolations(document.body)).toEqual([]);
    await userEvent.click(within(dialog).getByTestId('take-over-confirm'));
    await waitFor(() => {
      expect(calls).toContainEqual({
        method: 'POST',
        path: 'take-over',
        body: { enable: true },
        ifMatch: '"3"',
      });
    });
    expect(await screen.findByText('You now manage “Lost”.')).toBeVisible();
    await waitFor(() => {
      expect(screen.queryByTestId(`disabled-note-${lost.id}`)).toBeNull();
    });
  });

  it('deletes after confirmation', async () => {
    const item = automation({ name: 'Old one' });
    const { calls } = serve('admin', [item]);
    await renderApp(PAGE);
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for Old one' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const confirm = await screen.findByTestId('delete-automation-confirm');
    await userEvent.click(confirm);
    await waitFor(() => {
      expect(calls).toContainEqual({
        method: 'DELETE',
        path: 'delete',
        body: null,
        ifMatch: '"3"',
      });
    });
    expect(await screen.findByTestId('automations-empty')).toBeVisible();
  });

  it('duplicates from the row menu and opens the copy, turned off (T556)', async () => {
    const source = automation({ name: 'Follow up' });
    const copy = automation({ name: 'Follow up (copy)', enabled: false, version: 1 });
    const { calls } = serve('admin', [source], { [source.id]: copy });
    const { router } = await renderApp(PAGE);
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for Follow up' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/b/${BASE_ID}/automations/${copy.id}`);
    });
    expect(
      await screen.findByText(
        '«Follow up (copy)» created. The copy is off and will run with your permissions.',
      ),
    ).toBeVisible();
    expect(await screen.findByTestId('builder-title', {}, { timeout: 5000 })).toHaveTextContent(
      'Follow up (copy)',
    );
    expect(screen.getByTestId('builder-enabled')).not.toBeChecked();
    expect(calls.filter((call) => call.path === 'duplicate')).toEqual([
      { method: 'POST', path: 'duplicate', body: {}, ifMatch: null },
    ]);
  });

  it.each([
    [
      'button',
      'This automation runs from a button, and a button runs only one automation, so it cannot be copied.',
    ],
    [
      'permissions',
      'The copy would run with your permissions, and this automation uses tables, fields or senders you cannot use.',
    ],
  ] as const)('explains a refused duplicate: %s (T556)', async (answer, text) => {
    const source = automation({ name: 'Approve' });
    serve('admin', [source], { [source.id]: answer });
    const { router } = await renderApp(PAGE);
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for Approve' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Could not duplicate «Approve»',
    });
    expect(within(dialog).getByTestId('duplicate-failed-reason')).toHaveTextContent(text);
    expect(await axeViolations(document.body)).toEqual([]);
    expect(within(dialog).getByRole('link', { name: 'Open the automation' })).toHaveAttribute(
      'href',
      `/b/${BASE_ID}/automations/${source.id}`,
    );
    await userEvent.click(within(dialog).getByTestId('duplicate-failed-close'));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(router.state.location.pathname).toBe(PAGE);
  });

  it('continues to the builder from a name and a trigger (created there on save)', async () => {
    const { calls } = serve('admin', []);
    await renderApp(PAGE);
    expect(await screen.findByTestId('automations-empty')).toBeVisible();
    await userEvent.click(screen.getByTestId('create-automation'));
    const dialog = await screen.findByTestId('create-automation-dialog');
    // Button fields exist since T517: the builder asks the button (T525).
    expect(within(dialog).getByTestId('trigger-button.clicked')).toBeEnabled();
    await userEvent.click(within(dialog).getByTestId('create-automation-submit'));
    expect(within(dialog).getByText('Enter a name.')).toBeVisible();
    await userEvent.type(within(dialog).getByTestId('create-automation-name'), 'Watch status');
    await userEvent.click(within(dialog).getByLabelText('When a record is updated'));
    expect(await axeViolations(document.body)).toEqual([]);
    await userEvent.click(within(dialog).getByTestId('create-automation-submit'));
    // The builder opens with the name and the trigger; nothing is created yet.
    expect(await screen.findByTestId('builder-title', {}, { timeout: 5000 })).toHaveTextContent(
      'Watch status',
    );
    expect(await screen.findByTestId('trigger-type')).toHaveValue('record.updated');
    expect(calls.some((call) => call.path === 'create')).toBe(false);
  });

  it('tells people who manage no automation why, without asking the API', async () => {
    const { fetchMock } = serve('editor', []);
    await renderApp(PAGE);
    expect(await screen.findByTestId('automations-forbidden')).toBeVisible();
    expect(screen.queryByTestId('create-automation')).toBeNull();
    expect(screen.queryByTestId('base-automations-link')).toBeNull();
    const asked = fetchMock.mock.calls.map(([url]) => url);
    expect(asked.some((url) => url.includes('/automations'))).toBe(false);
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('refreshes when the system turns one off and says so', async () => {
    const item = automation({ name: 'Sync stock' });
    const { setItems } = serve('admin', [item]);
    await renderApp(PAGE);
    await screen.findByTestId(`automation-row-${item.id}`);
    setItems([{ ...item, enabled: false, disabled_reason: 'circuit_breaker', version: 4 }]);
    const message: ChannelMessage = {
      type: 'notification.created',
      channel: `user:${ME.user.id}`,
      notification_id: 'ntf_0123456789ABCDEF',
      organization_id: ORG.id,
      notification_type: 'automation.disabled',
      base_id: BASE_ID,
    };
    await waitFor(() => {
      expect(channels.get(`user:${ME.user.id}`)?.onMessage).toBeDefined();
    });
    channels.get(`user:${ME.user.id}`)?.onMessage?.(message);
    expect(
      await screen.findByText('“Sync stock” just turned off: too many runs failed.'),
    ).toBeVisible();
    expect(await screen.findByTestId(`disabled-note-${item.id}`)).toBeVisible();
  });
});

/** T913: "Create with AI" (CONTRACTS §29.3) — the milestone draft, never saved or turned on here. */
describe('Create with AI (T913)', () => {
  const draft = {
    name: 'Notify the owner when done',
    description: 'When an order is DONE, notify its owner',
    definition: {
      trigger: {
        type: 'record.updated',
        table_id: TABLE_ID,
        watch_fields: [FIELD.status],
        skip_bulk: false,
      },
      condition: { field: FIELD.status, operator: 'changed_to', value: OPTION.done },
      actions: [
        {
          id: 'act_1',
          type: 'send_notification',
          config: {
            recipients: [{ field: FIELD.owner }],
            title: { template: 'Order done' },
            body: { template: '' },
            link_record: 'trigger',
            skip_actor: false,
          },
        },
      ],
    },
    explanation: 'Sent through the notification channels of the owner.',
    warnings: [{ code: 'unsupported_action', message: 'Calling the shop API is left out.' }],
  };
  const aiOn = (prompts: unknown[]) => ({
    [`GET /orgs/${ORG.id}`]: () => json({ ...ORG, ai: { available: true, record_data: false } }),
    [`POST /bases/${BASE_ID}/ai/automation-draft`]: (init: RequestInit | undefined) => {
      prompts.push(JSON.parse(init?.body as string));
      return json(draft);
    },
  });

  it('drafts from a sentence and opens the builder unsaved and off; saving creates it off', async () => {
    const prompts: unknown[] = [];
    const { calls } = serve('manager', [], {}, aiOn(prompts));
    const { router } = await renderApp(PAGE);
    const empty = await screen.findByTestId('automations-empty');
    await userEvent.click(await within(empty).findByRole('button', { name: 'Create with AI' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create an automation with AI' });
    const examples = await within(dialog).findAllByTestId('ai-draft-example');
    expect(examples.map((example) => example.textContent)).toEqual([
      'When Status in Orders changes to Done, notify Owner',
      'One day before the due date, remind the person in charge',
      'When a record is added to Orders, notify Owner',
    ]);
    // One table managed: no table choice.
    expect(within(dialog).queryByTestId('ai-draft-table')).toBeNull();
    expect(await axeViolations(document.body)).toEqual([]);
    const prompt = within(dialog).getByRole('textbox', { name: 'What should the automation do?' });
    await userEvent.click(examples[0] as HTMLElement);
    expect(prompt).toHaveValue('When Status in Orders changes to Done, notify Owner');
    await userEvent.clear(prompt);
    // Shift+Enter is a new line, Enter sends.
    await userEvent.type(prompt, 'When an order is DONE,{Shift>}{Enter}{/Shift}notify its owner');
    expect(prompt).toHaveValue('When an order is DONE,\nnotify its owner');
    await userEvent.type(prompt, '{Enter}');

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/b/${BASE_ID}/automations/new`);
    });
    expect(prompts).toEqual([
      { prompt: 'When an order is DONE,\nnotify its owner', table_id: TABLE_ID },
    ]);
    const banner = await screen.findByTestId('ai-draft-banner', {}, { timeout: 5000 });
    expect(banner).toHaveTextContent(
      'AI draft: check every step before you save it and turn it on.',
    );
    expect(within(banner).getByTestId('ai-draft-request')).toHaveTextContent(draft.description);
    expect(within(banner).getByTestId('ai-draft-explanation')).toHaveTextContent(draft.explanation);
    expect(within(banner).getByTestId('ai-draft-warnings')).toHaveTextContent(
      'Not included: Calling the shop API is left out.',
    );
    expect(screen.getByTestId('builder-title')).toHaveTextContent(draft.name);
    expect(await screen.findByTestId('step-trigger')).toHaveTextContent('When a record is updated');
    expect(screen.getByTestId('step-condition')).toHaveTextContent('Status');
    expect(screen.getByTestId('step-condition')).toHaveTextContent('Done');
    const step = screen.getByTestId('step-act_1');
    expect(step).toHaveTextContent('Send notification');
    expect(step).toHaveTextContent('Owner');
    expect(within(step).getByTestId('notify-channels-hint')).toHaveTextContent(
      "Sent through each recipient's channels — Telegram when linked.",
    );
    const enabled = screen.getByTestId('builder-enabled');
    expect(enabled).not.toBeChecked();
    expect(enabled).toBeDisabled();
    expect(await axeViolations(document.body)).toEqual([]);

    await userEvent.click(screen.getByTestId('builder-save'));
    await waitFor(() => {
      expect(calls.filter((call) => call.path === 'create')).toHaveLength(1);
    });
    expect(calls.find((call) => call.path === 'create')?.body).toEqual({
      name: draft.name,
      description: draft.description,
      definition: draft.definition,
      enabled: false,
    });
  });

  it('shows no AI entry with AI off', async () => {
    serve('admin', [automation({ name: 'Existing' })]);
    await renderApp(PAGE);
    await screen.findByTestId('create-automation');
    expect(screen.queryByTestId('create-automation-ai')).toBeNull();
    expect(document.querySelector('svg.lucide-sparkles')).toBeNull();
  });
});
