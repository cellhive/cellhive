import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { json, ME, ORG, problem, renderApp, stubApi } from '../../../../../test/app-harness';
import { axeViolations } from '../../../../../test/axe';
import { BASE_ID, FIELD, fieldList, NOW, TABLE_ID } from '../../../../../test/records';
import { clearToasts } from '../../../../lib/toast/toast';

const AUTOMATION_ID = 'aut_Builder000000001';
const SELF = { id: ME.user.id, name: ME.user.display_name };
const OTHER = { id: 'usr_Other00000000001', name: 'Trần Thu Hà' };

function base(kind: 'admin' | 'editor') {
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
      tables: {
        [TABLE_ID]: {
          perm: kind === 'admin' ? 'manage' : 'edit',
          operations: ['add', 'delete'],
          view_rule: { allow_edit: false, visible_views: null },
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

function automation(overrides: Record<string, unknown> = {}) {
  return {
    id: AUTOMATION_ID,
    base_id: BASE_ID,
    name: 'Status done',
    description: '',
    enabled: false,
    disabled_reason: null,
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
            fields: { [FIELD.notes]: { template: `Done: {{ [${FIELD.title}] }}` } },
          },
        },
      ],
    },
    run_as: SELF,
    run_as_since: NOW,
    created_by: SELF,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

interface Call {
  readonly method: string;
  readonly body: unknown;
  readonly ifMatch: string | null;
}

function serve(
  kind: 'admin' | 'editor',
  current: ReturnType<typeof automation>,
  save?: (body: Record<string, unknown>) => Response,
  extra: Record<string, (init: RequestInit | undefined) => Response> = {},
) {
  const calls: Call[] = [];
  const record = (method: string, init: RequestInit | undefined) => {
    calls.push({
      method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      ifMatch: new Headers(init?.headers).get('If-Match'),
    });
  };
  stubApi({
    signedIn: true,
    routes: {
      [`GET /bases/${BASE_ID}`]: () => json(base(kind)),
      [`GET /orgs/${ORG.id}`]: () => json(ORG),
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
          : json({ items: [current], total: 1, offset: 0, limit: 1000 }),
      [`GET /automations/${AUTOMATION_ID}`]: () => json(current),
      [`PATCH /automations/${AUTOMATION_ID}`]: (init) => {
        record('PATCH', init);
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        if (save !== undefined) return save(body);
        return json({ ...current, ...body, version: current.version + 1 });
      },
      [`POST /automations/${AUTOMATION_ID}/enable`]: (init) => {
        record('ENABLE', init);
        return json({ ...current, enabled: true, version: current.version + 1 });
      },
      // T556: the copy of T551 (turned off, the caller as run_as).
      [`POST /automations/${AUTOMATION_ID}/duplicate`]: (init) => {
        record('DUPLICATE', init);
        return json(
          { ...current, id: COPY_ID, name: `${current.name} (copy)`, enabled: false },
          201,
        );
      },
      [`GET /automations/${COPY_ID}`]: () =>
        json({ ...current, id: COPY_ID, name: `${current.name} (copy)`, enabled: false }),
      [`POST /bases/${BASE_ID}/automations`]: (init) => {
        record('POST', init);
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        return json({ ...current, ...body }, 201);
      },
      ...extra,
    },
  });
  return calls;
}

const PAGE = `/b/${BASE_ID}/automations/${AUTOMATION_ID}`;
const COPY_ID = 'aut_Builder000000002';

afterEach(() => {
  clearToasts();
});

describe('AutomationBuilderPage (T521)', () => {
  it('shows the flow with chips and saves a change with If-Match', async () => {
    const calls = serve('admin', automation());
    await renderApp(PAGE);
    const flow = await screen.findByTestId('flow');
    expect(within(flow).getByTestId('step-trigger')).toHaveTextContent('When a record is updated');
    // The watched field and the template chip are named from the schema.
    await waitFor(() => {
      expect(within(flow).getByTestId('step-trigger')).toHaveTextContent('Watching Status');
    });
    expect(within(flow).getByTestId('step-act_1')).toHaveTextContent('Notes = Done: Title');
    expect(screen.queryByTestId('run-as-banner')).toBeNull();
    // The trigger panel is open first.
    expect(await screen.findByTestId('trigger-panel')).toBeVisible();
    expect(await axeViolations(document.body)).toEqual([]);

    await userEvent.click(within(flow).getByRole('button', { name: 'Update record' }));
    const panel = await screen.findByTestId('config-panel');
    expect(within(panel).getByRole('heading', { name: 'Step 1 · Update record' })).toBeVisible();
    await userEvent.selectOptions(within(panel).getByTestId('field-map-add'), 'Amount');
    await userEvent.type(within(panel).getByLabelText('Value of Amount'), '12');
    expect(screen.getByTestId('builder-unsaved')).toBeVisible();
    await userEvent.click(screen.getByTestId('builder-save'));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.ifMatch).toBe('"3"');
    expect(calls[0]?.body).toMatchObject({
      definition: {
        actions: [
          {
            id: 'act_1',
            config: {
              fields: {
                [FIELD.notes]: { template: `Done: {{ [${FIELD.title}] }}` },
                [FIELD.amount]: { literal: 12 },
              },
            },
          },
        ],
      },
    });
    expect(calls[0]?.body).not.toHaveProperty('name');
    expect(calls[0]?.body).toHaveProperty('version', 3);
    await waitFor(() => {
      expect(screen.queryByTestId('builder-unsaved')).toBeNull();
    });
  });

  it('names a formula by its fields on the card and keeps it visible on a number field (T527)', async () => {
    const stored = `{{ [${FIELD.amount}] + 1 }}`;
    serve(
      'admin',
      automation({
        definition: {
          ...automation().definition,
          actions: [
            {
              id: 'act_1',
              type: 'update_record',
              config: {
                table_id: TABLE_ID,
                record_id: null,
                fields: { [FIELD.amount]: { template: stored } },
              },
            },
          ],
        },
      }),
    );
    const requests: unknown[] = [];
    const fetchStub = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith(`/bases/${BASE_ID}/automations/validate-template`)) {
        requests.push(JSON.parse(init?.body as string));
        return Promise.resolve(
          json({
            valid: true,
            stored,
            display: '{{ [Amount] + 1 }}',
            placeholders: [
              {
                index: 0,
                start: 0,
                length: stored.length,
                stored: `[${FIELD.amount}] + 1`,
                display: '[Amount] + 1',
                result_type: { kind: 'number', list: false },
                fields: [{ field_id: FIELD.amount, link_path: [] }],
              },
            ],
            errors: [],
          }),
        );
      }
      return fetchStub(input, init);
    };
    await renderApp(PAGE);
    const flow = await screen.findByTestId('flow');
    await waitFor(() => {
      expect(within(flow).getByTestId('step-act_1')).toHaveTextContent('Amount = [Amount] + 1');
    });
    expect(within(flow).getByTestId('step-act_1')).not.toHaveTextContent(FIELD.amount);
    await userEvent.click(within(flow).getByRole('button', { name: 'Update record' }));
    const panel = await screen.findByTestId('config-panel');
    // Not an empty number box: the formula's chip.
    await waitFor(() => {
      expect(within(panel).getByText('[Amount] + 1')).toBeVisible();
    });
    expect(requests.length).toBeGreaterThan(0);
  });

  it('duplicates the saved version from the header, not while changes are unsaved (T556)', async () => {
    const calls = serve('admin', automation());
    const { router } = await renderApp(PAGE);
    const duplicate = await screen.findByTestId('builder-duplicate');
    expect(duplicate).toBeEnabled();
    expect(duplicate).toHaveAccessibleName('Duplicate');
    // An unsaved change: the copy would not include it.
    await userEvent.click(await screen.findByRole('button', { name: 'Update record' }));
    const panel = await screen.findByTestId('config-panel');
    await userEvent.selectOptions(within(panel).getByTestId('field-map-add'), 'Amount');
    await userEvent.type(within(panel).getByLabelText('Value of Amount'), '12');
    expect(screen.getByTestId('builder-unsaved')).toBeVisible();
    expect(screen.getByTestId('builder-duplicate')).toBeDisabled();
    expect(screen.getByTestId('builder-duplicate')).toHaveAccessibleDescription(
      'Save or discard your changes first: the copy is made from the saved version.',
    );
    await userEvent.click(screen.getByTestId('builder-discard'));
    await userEvent.click(screen.getByTestId('builder-duplicate'));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/b/${BASE_ID}/automations/${COPY_ID}`);
    });
    await waitFor(() => {
      expect(screen.getByTestId('builder-title')).toHaveTextContent('(copy)');
    });
    expect(screen.getByTestId('builder-enabled')).not.toBeChecked();
    expect(calls.map((call) => call.method)).toEqual(['DUPLICATE']);
  });

  it('warns that saving moves run_as to the editor (ADR-25 §4)', async () => {
    serve('admin', automation({ run_as: OTHER }));
    await renderApp(PAGE);
    const banner = await screen.findByTestId('run-as-banner');
    expect(banner).toHaveTextContent('runs with the permissions of Trần Thu Hà');
    await userEvent.click(within(banner).getByRole('button', { name: 'Permissions used' }));
    expect(within(banner).getByTestId('run-as-scope')).toHaveTextContent(
      'Write: Orders (fields Notes)',
    );
  });

  it('asks before turning on an automation that runs as someone else (ADR-25 §4)', async () => {
    const calls = serve('admin', automation({ run_as: OTHER }));
    await renderApp(PAGE);
    await userEvent.click(await screen.findByTestId('builder-enabled'));
    // The dialog is a lazy chunk of the list: it shows once loaded.
    const dialog = await screen.findByTestId('enable-automation-dialog');
    expect(dialog).toHaveTextContent('runs with the permissions of Trần Thu Hà');
    expect(calls).toEqual([]);
    await userEvent.click(within(dialog).getByTestId('enable-automation-confirm'));
    await waitFor(() => {
      expect(screen.queryByTestId('enable-automation-dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('builder-enabled')).toBeChecked();
    expect(calls.map((call) => [call.method, call.ifMatch])).toEqual([['ENABLE', '"3"']]);
  });

  it('adds steps from the menu and refuses to save what is incomplete', async () => {
    const calls = serve('admin', automation());
    await renderApp(PAGE);
    await screen.findByTestId('flow');
    await userEvent.click(screen.getByTestId('add-step'));
    const menu = await screen.findByTestId('add-step-menu');
    // Every step type of S5 can be added (send_telegram since T516).
    expect(within(menu).getByTestId('add-send_telegram')).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await userEvent.click(within(menu).getByTestId('add-if'));
    expect(await screen.findByTestId('branches-act_2')).toBeVisible();
    await userEvent.click(screen.getByTestId('builder-save'));
    const summary = await screen.findByTestId('issue-summary');
    expect(summary).toHaveTextContent('Not saved: 1 problem');
    expect(summary).toHaveTextContent('Step 2: Add at least one condition.');
    expect(screen.getByTestId('step-act_2')).toHaveTextContent('1 problem');
    expect(calls).toHaveLength(0);
  });

  it('points 422 AUTOMATION_INVALID at the step of errors[].path', async () => {
    serve('admin', automation(), () =>
      json(
        {
          type: 'about:blank',
          title: 'Invalid automation',
          status: 422,
          code: 'AUTOMATION_INVALID',
          errors: [
            {
              path: `definition.actions[0].config.fields.${FIELD.notes}`,
              code: 'UNKNOWN_FIELD',
              message: 'Unknown field',
            },
          ],
        },
        422,
      ),
    );
    await renderApp(PAGE);
    await screen.findByTestId('flow');
    await userEvent.click(screen.getByTestId('builder-title').nextElementSibling as HTMLElement);
    await userEvent.type(screen.getByTestId('builder-name'), ' 2{Enter}');
    await userEvent.click(screen.getByTestId('builder-save'));
    expect(await screen.findByTestId('issue-summary')).toHaveTextContent('Step 1:');
    // The step opens, its field row says why.
    const panel = await screen.findByTestId('config-panel');
    expect(within(panel).getByTestId(`field-map-row-${FIELD.notes}`)).toHaveTextContent(/field/iu);
  });

  it('asks what to do when it was changed elsewhere (409)', async () => {
    serve('admin', automation(), () =>
      json(
        {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          code: 'VERSION_CONFLICT',
          errors: [
            {
              path: 'version',
              code: 'VERSION_CONFLICT',
              params: {
                current_version: 5,
                version: 3,
                updated_by: { id: OTHER.id, name: OTHER.name },
              },
            },
          ],
        },
        409,
      ),
    );
    await renderApp(PAGE);
    await screen.findByTestId('flow');
    await userEvent.click(screen.getByTestId('builder-title').nextElementSibling as HTMLElement);
    await userEvent.type(screen.getByTestId('builder-name'), '!{Enter}');
    await userEvent.click(screen.getByTestId('builder-save'));
    const dialog = await screen.findByTestId('conflict-dialog');
    expect(dialog.closest('dialog')).toHaveTextContent('Trần Thu Hà saved this automation');
  });

  it('tells people who manage no automation why', async () => {
    serve('editor', automation());
    await renderApp(PAGE);
    expect(await screen.findByTestId('builder-message')).toHaveTextContent(
      'You don’t manage any automation in this base',
    );
  });
});

/**
 * T1015 (CONTRACTS §30.8, FRONTEND §13.2): `?draft=mdr_…` opens the draft of
 * an MCP client, read with the session from `GET /bases/:baseId/automation-drafts/:id`
 * — unsaved, off, its own label, the Telegram chat written in the draft
 * named with its step; saved like any new automation, turned off. A draft
 * that is gone (someone else's, expired) is one message.
 */
describe('AutomationBuilderPage: a draft of an MCP client (T1015)', () => {
  const DRAFT_ID = 'mdr_McpDraft00000001';
  const DRAFT_PAGE = `/b/${BASE_ID}/automations/new?draft=${DRAFT_ID}`;
  const SECRET_ID = 'sec_TelegramBot00001';
  const definition = {
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
        type: 'send_telegram',
        config: {
          secret_id: SECRET_ID,
          chat_id: { literal: '-1001234567890' },
          text: { template: 'Done', digest: null },
        },
      },
    ],
  };
  const draft = {
    id: DRAFT_ID,
    base_id: BASE_ID,
    name: 'Tell the team',
    definition,
    explanation: 'Posts to the team group when an order is done.',
    warnings: [
      {
        code: 'literal_chat_id',
        message: 'Step act_1 posts to the Telegram chat -1001234567890 written in the draft.',
        action_id: 'act_1',
      },
    ],
    expires_at: NOW,
  };
  const draftRoute = `GET /bases/${BASE_ID}/automation-drafts/${DRAFT_ID}`;

  it('opens the draft unsaved and off with its label and the chat written in it; saves it off', async () => {
    const calls = serve('admin', automation(), undefined, { [draftRoute]: () => json(draft) });
    await renderApp(DRAFT_PAGE);
    const banner = await screen.findByTestId('ai-draft-banner', {}, { timeout: 5000 });
    expect(banner).toHaveAttribute('data-source', 'mcp');
    expect(within(banner).getByRole('heading')).toHaveTextContent(
      'Draft from an MCP client — check before saving',
    );
    expect(within(banner).queryByTestId('ai-draft-request')).toBeNull();
    expect(within(banner).getByTestId('ai-draft-explanation')).toHaveTextContent(draft.explanation);
    expect(within(banner).getByRole('list', { name: '1 note on this draft' })).toBeVisible();
    expect(within(banner).getByTestId('ai-draft-warning-literal_chat_id')).toHaveTextContent(
      'Telegram chat written in the draft: step 1 posts to -1001234567890, written into the ' +
        'draft rather than taken from a field. Save it only if this group or channel is yours.',
    );
    expect(screen.getByTestId('builder-title')).toHaveTextContent(draft.name);
    expect(await screen.findByTestId('step-act_1')).toHaveTextContent('Telegram');
    const enabled = screen.getByTestId('builder-enabled');
    expect(enabled).not.toBeChecked();
    expect(enabled).toBeDisabled();
    expect(await axeViolations(document.body)).toEqual([]);

    await userEvent.click(screen.getByTestId('builder-save'));
    await waitFor(() => {
      expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    });
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
      name: draft.name,
      definition,
      enabled: false,
    });
  });

  it('says a draft that is gone does not exist, and never loads the builder', async () => {
    serve('admin', automation(), undefined, {
      [draftRoute]: () => problem('NOT_FOUND', 404),
    });
    await renderApp(DRAFT_PAGE);
    const message = await screen.findByTestId('builder-message');
    expect(message).toHaveTextContent('This draft does not exist or has expired');
    expect(message).toHaveTextContent('lasts 24 hours and opens only for the person who made it');
    expect(
      within(message).getByRole('link', { name: 'Back to the automation list' }),
    ).toHaveAttribute('href', `/b/${BASE_ID}/automations`);
    expect(screen.queryByTestId('ai-draft-banner')).toBeNull();
    expect(screen.queryByTestId('builder-save')).toBeNull();
  });

  it('ignores a draft parameter that is not a draft id', async () => {
    const fetchCalls = serve('admin', automation());
    await renderApp(`/b/${BASE_ID}/automations/new?draft=../../secrets`);
    expect(await screen.findByTestId('builder-save')).toBeVisible();
    expect(screen.queryByTestId('ai-draft-banner')).toBeNull();
    expect(fetchCalls).toEqual([]);
  });
});
