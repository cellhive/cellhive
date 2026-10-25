import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { json, ME, ORG, renderApp, stubApi } from '../../../../../test/app-harness';
import { axeViolations } from '../../../../../test/axe';
import { BASE_ID, FIELD, fieldList, NOW, TABLE_ID } from '../../../../../test/records';
import { clearToasts } from '../../../../lib/toast/toast';
import { resetPickedResponsePaths } from '../actions/http-request/response-paths';

/**
 * T613: the `http_request` editor (header names the outbox owns, JSON body
 * check, send a test, response values for later steps, SSRF explained with
 * the allowlist) and the `run_n8n_workflow` editor (fields, payload preview).
 */

const AUTOMATION_ID = 'aut_Http000000000001';
const SELF = { id: ME.user.id, name: ME.user.display_name };
const RECORD = 'rec_Order00000000001';
const HEADER_SECRET = 'sec_Header0000000001';
const SIGNING_SECRET = 'sec_Signing000000001';
const DELIVERY = 'hdl_Test000000000001';

function base() {
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
      is_admin: true,
      base_rule: { copy: true, download: true, share_link: true },
      tables: {
        [TABLE_ID]: {
          perm: 'manage',
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

const httpStep = {
  id: 'act_1',
  type: 'http_request',
  config: {
    method: 'POST',
    url: { literal: 'https://api.example.com/orders' },
    query: [],
    headers: [],
    auth: null,
    body: { type: 'json', value: { template: `\\{"title": "{{ [${FIELD.title}] }}"}` } },
    signing_secret_id: null,
    fail_on_http_error: true,
  },
};

const n8nStep = {
  id: 'act_1',
  type: 'run_n8n_workflow',
  config: {
    url: { literal: 'https://n8n.example.com/webhook/orders' },
    signing_secret_id: SIGNING_SECRET,
    fields: null,
    include_changes: true,
  },
};

function automation(actions: unknown[]) {
  return {
    id: AUTOMATION_ID,
    base_id: BASE_ID,
    name: 'Send orders',
    description: '',
    enabled: false,
    disabled_reason: null,
    version: 2,
    definition: {
      trigger: {
        type: 'record.updated',
        table_id: TABLE_ID,
        watch_fields: [FIELD.status],
        skip_bulk: false,
      },
      condition: null,
      actions,
    },
    run_as: SELF,
    run_as_since: NOW,
    created_by: SELF,
    created_at: NOW,
    updated_at: NOW,
  };
}

interface Calls {
  tests: { record_id: string | null; draft: Record<string, unknown> }[];
}

function serve(
  current: ReturnType<typeof automation>,
  delivery: Record<string, unknown> = {},
): Calls {
  const calls: Calls = { tests: [] };
  stubApi({
    signedIn: true,
    routes: {
      [`GET /bases/${BASE_ID}`]: () => json(base()),
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
        json({
          records: [
            {
              id: RECORD,
              created_at: NOW,
              updated_at: NOW,
              version: 1,
              fields: { [FIELD.title]: 'DH-10482' },
            },
          ],
          offset: 0,
          limit: 50,
        }),
      // One answer for both kinds (the stub does not see the query string).
      [`GET /bases/${BASE_ID}/secrets`]: () =>
        json({
          items: [
            { id: HEADER_SECRET, kind: 'http_header', name: 'CRM API key' },
            { id: SIGNING_SECRET, kind: 'webhook_signing', name: 'Ký n8n' },
          ],
        }),
      [`GET /bases/${BASE_ID}/automations`]: () =>
        json({ items: [current], total: 1, offset: 0, limit: 1000 }),
      [`GET /automations/${AUTOMATION_ID}`]: () => json(current),
      [`POST /automations/${AUTOMATION_ID}/actions/act_1/http-test`]: (init) => {
        calls.tests.push(JSON.parse(init?.body as string) as Calls['tests'][number]);
        return json({ delivery_id: DELIVERY, warnings: [] }, 202);
      },
      [`GET /http-deliveries/${DELIVERY}`]: () =>
        json({
          id: DELIVERY,
          kind: 'test',
          status: 'succeeded',
          target_host: 'api.example.com',
          attempts: 1,
          response: {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: { id: 'ord_42', total: 120 },
            body_truncated: false,
          },
          error: null,
          created_at: NOW,
          completed_at: NOW,
          ...delivery,
        }),
    },
  });
  return calls;
}

const PAGE = `/b/${BASE_ID}/automations/${AUTOMATION_ID}`;

afterEach(() => {
  clearToasts();
  resetPickedResponsePaths();
});

async function openStep(name: string, testId: string) {
  await renderApp(PAGE);
  const flow = await screen.findByTestId('flow');
  await userEvent.click(within(flow).getByRole('button', { name }));
  return screen.findByTestId(testId, {}, { timeout: 10_000 });
}

describe('http_request editor (T613)', () => {
  it('flags header names the outbox owns and a JSON body that does not parse', async () => {
    serve(
      automation([
        {
          ...httpStep,
          config: {
            ...httpStep.config,
            body: { type: 'json', value: { template: '\\{"title": }' } },
          },
        },
      ]),
    );
    const editor = await openStep('Send HTTP request', 'http-request-editor');
    expect(await within(editor).findByTestId('http-json-problem')).toHaveTextContent(
      /This is not valid JSON/u,
    );
    await userEvent.click(within(editor).getByTestId('http-headers-add'));
    const name = within(editor).getByTestId('http-headers-row-name');
    await userEvent.type(name, 'Host');
    expect(within(editor).getByTestId('http-headers-row-warning')).toHaveTextContent(
      'Cellhive sets Host itself: remove this header.',
    );
    expect(name).toHaveAttribute('aria-invalid', 'true');
    await userEvent.clear(name);
    await userEvent.type(name, 'X-Order');
    expect(within(editor).queryByTestId('http-headers-row-warning')).toBeNull();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('sends a test with the draft and offers response values to later steps', async () => {
    const calls = serve(automation([httpStep]));
    const editor = await openStep('Send HTTP request', 'http-request-editor');
    const test = within(editor).getByTestId('http-test');
    await waitFor(() => {
      expect(within(test).getByTestId('http-test-record')).toHaveValue(RECORD);
    });
    await userEvent.click(within(test).getByTestId('http-test-send'));
    const result = await within(test).findByTestId('http-test-result');
    await waitFor(() => {
      expect(result).toHaveAttribute('data-status', 'succeeded');
    });
    expect(calls.tests[0]?.record_id).toBe(RECORD);
    expect(calls.tests[0]?.draft).toMatchObject({ method: 'POST', url: httpStep.config.url });
    expect(within(test).getByTestId('http-test-status')).toHaveTextContent('HTTP 200');
    expect(within(test).getByTestId('http-test-body')).toHaveTextContent('"ord_42"');
    const use = within(test).getByRole('button', { name: 'Use body.id in later steps' });
    expect(use).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(use);
    expect(use).toHaveAttribute('aria-pressed', 'true');
    expect(within(editor).getByTestId('http-path-picked')).toHaveTextContent('body.id');
    // A typed path is checked: it must be under body.
    await userEvent.type(within(editor).getByTestId('http-path-input'), 'total');
    await userEvent.click(within(editor).getByTestId('http-path-add'));
    expect(within(editor).getByText(/Write a path under body/u)).toBeInTheDocument();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('explains an internal address and links owners to the allowlist', async () => {
    serve(automation([httpStep]), {
      status: 'failed',
      target_host: 'n8n.internal',
      response: null,
      error: { code: 'ssrf_blocked', params: { reason: 'private_address' } },
    });
    const editor = await openStep('Send HTTP request', 'http-request-editor');
    const test = within(editor).getByTestId('http-test');
    await waitFor(() => {
      expect(within(test).getByTestId('http-test-send')).toBeEnabled();
    });
    await userEvent.click(within(test).getByTestId('http-test-send'));
    const error = await within(test).findByTestId('http-test-error');
    expect(error).toHaveTextContent('This host is on an internal network.');
    expect(within(error).getByTestId('http-test-allowlist-hint')).toHaveTextContent(
      /n8n\.internal is an internal address/u,
    );
    expect(within(error).getByRole('link', { name: 'Open the allowlist' })).toHaveAttribute(
      'href',
      `/o/${ORG.slug}/settings/integrations`,
    );
  });
});

describe('run_n8n_workflow editor (T613)', () => {
  it('chooses the fields sent and previews the payload', async () => {
    serve(automation([n8nStep]));
    const editor = await openStep('Run n8n workflow', 'n8n-editor');
    await waitFor(() => {
      expect(within(editor).getByTestId('n8n-secret')).toHaveValue(SIGNING_SECRET);
    });
    const preview = within(editor).getByTestId('n8n-preview');
    await waitFor(() => {
      expect(preview).toHaveTextContent('"Title": "<text>"');
    });
    expect(preview).toHaveTextContent('"changes"');
    await userEvent.click(within(editor).getByRole('radio', { name: 'Chosen fields' }));
    const list = within(editor).getByTestId('n8n-fields');
    await userEvent.click(within(list).getByRole('checkbox', { name: 'Notes' }));
    expect(preview).not.toHaveTextContent('"Notes"');
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('sends a test of the n8n step with its draft (T616)', async () => {
    const calls = serve(automation([n8nStep]));
    const editor = await openStep('Run n8n workflow', 'n8n-editor');
    const test = within(editor).getByTestId('http-test');
    await waitFor(() => {
      expect(within(test).getByTestId('http-test-send')).toBeEnabled();
    });
    await userEvent.click(within(test).getByTestId('http-test-send'));
    const result = await within(test).findByTestId('http-test-result');
    await waitFor(() => {
      expect(result).toHaveAttribute('data-status', 'succeeded');
    });
    expect(calls.tests).toHaveLength(1);
    expect(calls.tests[0]?.draft).toEqual(n8nStep.config);
    expect(calls.tests[0]?.draft).not.toHaveProperty('method');
    expect(within(editor).queryByText(/not available for n8n/u)).toBeNull();
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
