import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { json, ME, ORG, renderApp, stubApi } from '../../../../../test/app-harness';
import { axeViolations } from '../../../../../test/axe';
import { BASE_ID, FIELD, fieldList, NOW, TABLE_ID } from '../../../../../test/records';
import { clearToasts } from '../../../../lib/toast/toast';

import type { SecretDto } from '@cellhive/contracts';

/**
 * T717: the allowed hosts of the chosen secret in the `http_request` and
 * `run_n8n_workflow` editors — a warning before saving when the literal URL
 * is not one of them, the deadline of a secret without hosts, and the
 * server's `SECRET_HOST_NOT_ALLOWED` on the secret field.
 */

const AUTOMATION_ID = 'aut_Http000000000001';
const SELF = { id: ME.user.id, name: ME.user.display_name };
const HEADER_SECRET = 'sec_Header0000000001';
const SIGNING_SECRET = 'sec_Signing000000001';

function secret(patch: Partial<SecretDto>): SecretDto {
  return {
    id: HEADER_SECRET,
    organization_id: ORG.id,
    kind: 'http_header',
    name: 'CRM API key',
    base_scope: 'all',
    base_ids: [],
    allowed_hosts: ['api.crm.test', '*.crm.test'],
    legacy_hosts_until: null,
    previous_value_expires_at: null,
    created_by: SELF,
    created_at: NOW,
    updated_at: NOW,
    ...patch,
  };
}

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

function httpStep(url: string, secretId: string | null) {
  return {
    id: 'act_1',
    type: 'http_request',
    config: {
      method: 'POST',
      url: { literal: url },
      query: [],
      headers: [],
      auth: secretId === null ? null : { header_name: 'Authorization', secret_id: secretId },
      body: null,
      signing_secret_id: null,
      fail_on_http_error: true,
    },
  };
}

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

function serve(
  current: ReturnType<typeof automation>,
  options: {
    readonly secrets: readonly SecretDto[];
    readonly role?: 'owner' | 'member';
    readonly save?: () => Response;
  },
) {
  stubApi({
    signedIn: true,
    routes: {
      'GET /me': () => json({ ...ME, orgs: [{ ...ME.orgs[0], role: options.role ?? 'owner' }] }),
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
      [`POST /tables/${TABLE_ID}/records/query`]: () => json({ records: [], offset: 0, limit: 50 }),
      [`GET /bases/${BASE_ID}/secrets`]: () =>
        json({
          items: options.secrets.map((item) => ({ id: item.id, kind: item.kind, name: item.name })),
        }),
      [`GET /orgs/${ORG.id}/secrets`]: () => json({ items: options.secrets }),
      [`GET /bases/${BASE_ID}/automations`]: () =>
        json({ items: [current], total: 1, offset: 0, limit: 1000 }),
      [`GET /automations/${AUTOMATION_ID}`]: () => json(current),
      [`PATCH /automations/${AUTOMATION_ID}`]: () =>
        options.save === undefined ? json(current) : options.save(),
    },
  });
}

const PAGE = `/b/${BASE_ID}/automations/${AUTOMATION_ID}`;

afterEach(() => {
  clearToasts();
});

async function openStep(name: string, testId: string) {
  await renderApp(PAGE);
  const flow = await screen.findByTestId('flow');
  await userEvent.click(within(flow).getByRole('button', { name }));
  return screen.findByTestId(testId, {}, { timeout: 10_000 });
}

describe('secret allowed hosts in the HTTP step editors (T717)', () => {
  it('names the hosts a secret is sent to when the URL is one of them', async () => {
    serve(automation([httpStep('https://eu.crm.test/orders', HEADER_SECRET)]), {
      secrets: [secret({})],
    });
    const editor = await openStep('Send HTTP request', 'http-request-editor');
    const hosts = await within(editor).findByTestId('http-auth-secret-hosts');
    expect(hosts).toHaveAttribute('data-verdict', 'allowed');
    expect(hosts).toHaveTextContent('This secret is sent only to: api.crm.test, *.crm.test.');
    // The select is described by it.
    expect(
      within(editor).getByTestId('http-auth-secret').getAttribute('aria-describedby'),
    ).toContain(hosts.id);
  });

  it('warns before saving when the literal URL is not an allowed host, then shows the server error on the secret field', async () => {
    serve(automation([httpStep('https://attacker.test/', null)]), {
      secrets: [secret({})],
      save: () =>
        json(
          {
            type: 'about:blank',
            title: 'Invalid automation',
            status: 422,
            code: 'AUTOMATION_INVALID',
            errors: [
              {
                path: 'definition.actions[0].config.auth.secret_id',
                code: 'SECRET_HOST_NOT_ALLOWED',
                message: 'This secret may not be sent to the host of this URL',
                params: { kind: 'http_header', reason: 'not_listed' },
              },
            ],
          },
          422,
        ),
    });
    const editor = await openStep('Send HTTP request', 'http-request-editor');
    await userEvent.click(within(editor).getByRole('radio', { name: 'Header with a secret' }));
    const select = within(editor).getByTestId('http-auth-secret');
    await waitFor(() => {
      expect(select).toBeEnabled();
    });
    await userEvent.selectOptions(select, HEADER_SECRET);
    const warning = await within(editor).findByTestId('http-auth-secret-hosts');
    expect(warning).toHaveAttribute('data-verdict', 'not_listed');
    expect(warning).toHaveTextContent('attacker.test is not an allowed host of this secret');
    expect(warning).toHaveTextContent('Allowed hosts: api.crm.test, *.crm.test.');
    expect(within(warning).getByRole('link', { name: 'Open integrations' })).toHaveAttribute(
      'href',
      `/o/${ORG.slug}/settings/integrations`,
    );
    expect(await axeViolations(document.body)).toEqual([]);

    await userEvent.click(screen.getByTestId('builder-save'));
    await waitFor(() => {
      expect(within(editor).getByTestId('http-auth-secret')).toHaveAttribute(
        'aria-invalid',
        'true',
      );
    });
    expect(
      within(editor).getByText(
        'This secret may not be sent to the host of this URL (a plain http URL needs an allowed host with its port). Use an allowed host, or add this host to the secret in the organization settings.',
      ),
    ).toBeVisible();
  });

  it('review fix: a listed host over plain http is refused — says to use https or name the port', async () => {
    serve(automation([httpStep('http://api.crm.test/orders', null)]), { secrets: [secret({})] });
    const editor = await openStep('Send HTTP request', 'http-request-editor');
    await userEvent.click(within(editor).getByRole('radio', { name: 'Header with a secret' }));
    const select = within(editor).getByTestId('http-auth-secret');
    await waitFor(() => {
      expect(select).toBeEnabled();
    });
    await userEvent.selectOptions(select, HEADER_SECRET);
    const warning = await within(editor).findByTestId('http-auth-secret-hosts');
    expect(warning).toHaveAttribute('data-verdict', 'plain_http');
    expect(warning).toHaveTextContent('This secret is not sent over plain http');
    expect(warning).toHaveTextContent('add api.crm.test:80 to the secret');
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('gives the deadline of a secret without hosts, and says when it stopped sending (n8n)', async () => {
    const legacy = secret({
      id: SIGNING_SECRET,
      kind: 'webhook_signing',
      name: 'Ký n8n',
      allowed_hosts: [],
      legacy_hosts_until: '2999-11-20T00:00:00.000Z',
    });
    serve(
      automation([
        {
          id: 'act_1',
          type: 'run_n8n_workflow',
          config: {
            url: { literal: 'https://n8n.example.com/webhook/x' },
            signing_secret_id: SIGNING_SECRET,
            fields: null,
            include_changes: true,
          },
        },
      ]),
      { secrets: [legacy] },
    );
    const editor = await openStep('Run n8n workflow', 'n8n-editor');
    const note = await within(editor).findByTestId('n8n-secret-hosts');
    expect(note).toHaveAttribute('data-verdict', 'legacy');
    expect(note).toHaveTextContent('This secret has no allowed hosts yet');
    expect(note).toHaveTextContent(/until .*2999/u);
  });

  it('says nothing about hosts to someone who is not an owner/admin of the organization', async () => {
    serve(automation([httpStep('https://attacker.test/', HEADER_SECRET)]), {
      secrets: [secret({})],
      role: 'member',
    });
    const editor = await openStep('Send HTTP request', 'http-request-editor');
    await waitFor(() => {
      expect(within(editor).getByTestId('http-auth-secret')).toHaveValue(HEADER_SECRET);
    });
    expect(within(editor).queryByTestId('http-auth-secret-hosts')).toBeNull();
  });
});
