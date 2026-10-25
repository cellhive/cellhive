import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, ME, ORG, renderApp, stubApi } from '../../../../../test/app-harness';
import { axeViolations } from '../../../../../test/axe';
import { clearToasts } from '../../../../lib/toast/toast';

import type { HttpAllowlistEntryDto, SecretDto } from '@cellhive/contracts';

/** T613: the organization's integrations page — HTTP allowlist and HTTP secrets. */

const PATH = `/o/${ORG.slug}/settings/integrations`;
const NOW = '2026-10-18T03:00:00.000Z';
const GENERATED = `whsec_${'A'.repeat(43)}=`;

const ENTRY: HttpAllowlistEntryDto = {
  id: 'hal_0000000000000001',
  organization_id: ORG.id,
  pattern: 'n8n.internal:5678',
  host: 'n8n.internal',
  wildcard: false,
  port: 5678,
  note: 'n8n nội bộ',
  created_by: { id: ME.user.id, name: 'Me' },
  created_at: NOW,
};

const HEADER: SecretDto = {
  id: 'sec_Header0000000001',
  organization_id: ORG.id,
  kind: 'http_header',
  name: 'CRM API key',
  base_scope: 'all',
  base_ids: [],
  allowed_hosts: ['api.crm.test'],
  legacy_hosts_until: null,
  previous_value_expires_at: null,
  created_by: { id: ME.user.id, name: 'Me' },
  created_at: NOW,
  updated_at: NOW,
};

const BOT: SecretDto = {
  ...HEADER,
  id: 'sec_Bot0000000000001',
  kind: 'telegram_bot',
  name: 'Bot',
  allowed_hosts: [],
};

interface Call {
  readonly route: string;
  readonly body: unknown;
}

function serve(
  options: {
    role?: 'owner' | 'member';
    privateAddresses?: 'org' | 'off';
    /** The answer of the next `POST …/secrets` (a problem document). */
    createProblem?: () => Response;
  } = {},
) {
  let entries: HttpAllowlistEntryDto[] = [ENTRY];
  let secrets: SecretDto[] = [HEADER, BOT];
  const calls: Call[] = [];
  const body = (init: RequestInit | undefined): unknown =>
    typeof init?.body === 'string' ? JSON.parse(init.body) : null;
  stubApi({
    signedIn: true,
    routes: {
      'GET /me': () => json({ ...ME, orgs: [{ ...ME.orgs[0], role: options.role ?? 'owner' }] }),
      [`GET /orgs/${ORG.id}`]: () => json(ORG),
      [`GET /orgs/${ORG.id}/workspaces`]: () =>
        json({ items: [], total: 0, offset: 0, limit: 1000 }),
      [`GET /orgs/${ORG.id}/http-allowlist`]: () =>
        json({ items: entries, private_addresses: options.privateAddresses ?? 'org' }),
      [`POST /orgs/${ORG.id}/http-allowlist`]: (init) => {
        const sent = body(init) as { pattern: string; note: string };
        calls.push({ route: 'allowlist.create', body: sent });
        const created = {
          ...ENTRY,
          id: 'hal_0000000000000002' as const,
          pattern: sent.pattern,
          note: sent.note,
          port: null,
        };
        entries = [...entries, created];
        return json(created, 201);
      },
      [`DELETE /http-allowlist/${ENTRY.id}`]: () => {
        calls.push({ route: 'allowlist.delete', body: null });
        entries = entries.filter((entry) => entry.id !== ENTRY.id);
        return new Response(null, { status: 204 });
      },
      [`GET /orgs/${ORG.id}/secrets`]: () => json({ items: secrets }),
      [`POST /orgs/${ORG.id}/secrets`]: (init) => {
        const sent = body(init) as { name: string; kind: SecretDto['kind'] };
        calls.push({ route: 'secret.create', body: sent });
        if (options.createProblem !== undefined) return options.createProblem();
        const created: SecretDto = {
          ...HEADER,
          id: 'sec_Sign000000000001',
          kind: sent.kind,
          name: sent.name,
        };
        secrets = [...secrets, created];
        return json({ ...created, value: GENERATED }, 201);
      },
      [`GET /secrets/${HEADER.id}/usages`]: () =>
        json({
          items: [
            {
              kind: 'automation',
              automation_id: 'aut_0000000000000001',
              base_id: 'bse_0000000000000001',
              name: 'Đồng bộ CRM',
            },
          ],
          total: 1,
        }),
    },
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

describe('IntegrationsPage (T613)', () => {
  it('lists, adds and removes allowlist entries', async () => {
    const calls = serve();
    await renderApp(PATH);
    const section = await screen.findByTestId('allowlist-section');
    expect(await within(section).findByText('n8n.internal:5678')).toBeVisible();
    expect(within(section).getByText('Port 5678')).toBeVisible();
    // A typed IP address is refused before sending.
    await userEvent.type(within(section).getByTestId('allowlist-pattern'), '10.0.0.1');
    await userEvent.click(within(section).getByTestId('allowlist-add'));
    expect(within(section).getByText(/IP addresses and ranges are not accepted/u)).toBeVisible();
    expect(calls).toEqual([]);
    await userEvent.clear(within(section).getByTestId('allowlist-pattern'));
    await userEvent.type(within(section).getByTestId('allowlist-pattern'), 'Hooks.Corp.Example');
    expect(within(section).getByText('Will be saved as hooks.corp.example')).toBeVisible();
    await userEvent.click(within(section).getByTestId('allowlist-add'));
    await waitFor(() => {
      expect(calls[0]).toEqual({
        route: 'allowlist.create',
        body: { pattern: 'Hooks.Corp.Example', note: '' },
      });
    });
    await userEvent.click(
      within(section).getByRole('button', { name: 'Remove n8n.internal:5678' }),
    );
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove n8n.internal:5678?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(calls.some((call) => call.route === 'allowlist.delete')).toBe(true);
    });
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('says when the instance keeps internal addresses closed', async () => {
    serve({ privateAddresses: 'off' });
    await renderApp(PATH);
    expect(await screen.findByTestId('allowlist-off')).toHaveTextContent(
      'HTTP_PRIVATE_ALLOWLIST=off',
    );
  });

  it('lists HTTP secrets only, and shows a generated signing secret once', async () => {
    const calls = serve();
    await renderApp(PATH);
    const section = await screen.findByTestId('http-secrets-section');
    const rows = await within(section).findAllByTestId('http-secret-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('CRM API key');
    expect(rows[0]).toHaveTextContent('Header value');

    await userEvent.click(within(section).getByTestId('secret-add'));
    const form = await screen.findByTestId('secret-form');
    await userEvent.click(within(form).getByTestId('secret-kind-webhook_signing'));
    expect(within(form).getByTestId('secret-mode-generate')).toBeChecked();
    await userEvent.type(within(form).getByTestId('secret-name'), 'Ký n8n');
    // T701: the allowed hosts are required, checked as typed, one per line.
    await userEvent.click(within(form).getByTestId('secret-save'));
    const hosts = within(form).getByTestId('secret-allowed-hosts');
    expect(hosts).toHaveAttribute('aria-invalid', 'true');
    expect(within(form).getByText('List at least one host.')).toBeVisible();
    expect(calls).toHaveLength(0);
    await userEvent.type(hosts, 'n8n.example.com{Enter}*.hooks.example:8443');
    await userEvent.click(within(form).getByTestId('secret-save'));
    await waitFor(() => {
      expect(calls[0]).toMatchObject({
        route: 'secret.create',
        body: {
          kind: 'webhook_signing',
          name: 'Ký n8n',
          generate: true,
          allowed_hosts: ['n8n.example.com', '*.hooks.example:8443'],
        },
      });
    });
    const reveal = await screen.findByTestId('secret-reveal');
    expect(within(reveal).getByTestId('secret-reveal-value')).toHaveValue(GENERATED);
    expect(await axeViolations(document.body)).toEqual([]);
    // "Done" before confirming explains instead of closing.
    await userEvent.click(within(reveal).getByTestId('secret-reveal-done'));
    expect(within(reveal).getByRole('alert')).toHaveTextContent(/cannot be shown again/u);
    await userEvent.click(within(reveal).getByTestId('secret-reveal-confirm'));
    await userEvent.click(within(reveal).getByTestId('secret-reveal-done'));
    await waitFor(() => {
      expect(screen.queryByTestId('secret-reveal')).toBeNull();
    });
    expect(screen.queryByDisplayValue(GENERATED)).toBeNull();
  });

  it('shows the server verdict on the allowed hosts under that field (T701)', async () => {
    const calls = serve({
      createProblem: () =>
        json(
          {
            type: 'https://cellhive.io/errors/VALIDATION_FAILED',
            title: 'Validation failed',
            status: 422,
            code: 'VALIDATION_FAILED',
            request_id: 'req_0000000000000001',
            errors: [
              {
                path: 'allowed_hosts',
                code: 'TOO_MANY_ALLOWED_HOSTS',
                message: 'At most 20 hosts',
              },
            ],
          },
          422,
        ),
    });
    await renderApp(PATH);
    const section = await screen.findByTestId('http-secrets-section');
    await userEvent.click(within(section).getByTestId('secret-add'));
    const form = await screen.findByTestId('secret-form');
    await userEvent.type(within(form).getByTestId('secret-name'), 'CRM');
    await userEvent.type(within(form).getByTestId('secret-value'), 'Bearer x');
    await userEvent.type(within(form).getByTestId('secret-allowed-hosts'), 'api.crm.test');
    await userEvent.click(within(form).getByTestId('secret-save'));
    await waitFor(() => {
      expect(within(form).getByTestId('secret-allowed-hosts')).toHaveAttribute(
        'aria-invalid',
        'true',
      );
    });
    expect(calls[0]).toMatchObject({ body: { allowed_hosts: ['api.crm.test'] } });
    expect(within(form).getByText('A secret can list at most 20 allowed hosts.')).toBeVisible();
  });

  it('will not delete a secret automations use', async () => {
    serve();
    await renderApp(PATH);
    const section = await screen.findByTestId('http-secrets-section');
    await userEvent.click(
      await within(section).findByRole('button', { name: 'Delete CRM API key' }),
    );
    const dialog = await screen.findByTestId('secret-delete');
    expect(await within(dialog).findByText('Đồng bộ CRM')).toBeVisible();
    expect(within(dialog).getByTestId('secret-delete-confirm')).toBeDisabled();
  });

  it('members get the not-found screen', async () => {
    serve({ role: 'member' });
    await renderApp(PATH);
    expect(await screen.findByRole('heading', { name: /not found/iu })).toBeInTheDocument();
    expect(screen.queryByTestId('allowlist-section')).not.toBeInTheDocument();
  });
});
