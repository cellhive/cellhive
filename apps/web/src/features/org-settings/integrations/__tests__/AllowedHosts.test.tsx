import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, ME, ORG, renderApp, stubApi } from '../../../../../test/app-harness';
import { axeViolations } from '../../../../../test/axe';
import { clearToasts } from '../../../../lib/toast/toast';

import type { SecretDto } from '@cellhive/contracts';

/**
 * T717: the allowed hosts of HTTP secrets as chips (keyboard, paste,
 * announcements, the rules), and the secrets stored before allowed hosts
 * existed — "Set hosts before <date>", "Sending stopped", the page banner.
 */

const PATH = `/o/${ORG.slug}/settings/integrations`;
const NOW = '2026-10-18T03:00:00.000Z';

function secret(patch: Partial<SecretDto>): SecretDto {
  return {
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
    ...patch,
  };
}

const PENDING = secret({
  id: 'sec_Legacy0000000001',
  name: 'Old CRM',
  allowed_hosts: [],
  legacy_hosts_until: '2999-11-17T03:00:00.000Z',
});
const STOPPED = secret({
  id: 'sec_Legacy0000000002',
  kind: 'webhook_signing',
  name: 'Old n8n',
  allowed_hosts: [],
  legacy_hosts_until: '2026-01-01T00:00:00.000Z',
});

function serve(secrets: SecretDto[]) {
  const sent: { route: string; body: unknown }[] = [];
  const body = (init: RequestInit | undefined): unknown =>
    typeof init?.body === 'string' ? JSON.parse(init.body) : null;
  stubApi({
    signedIn: true,
    routes: {
      [`GET /orgs/${ORG.id}`]: () => json(ORG),
      [`GET /orgs/${ORG.id}/workspaces`]: () =>
        json({ items: [], total: 0, offset: 0, limit: 1000 }),
      [`GET /orgs/${ORG.id}/http-allowlist`]: () => json({ items: [], private_addresses: 'org' }),
      [`GET /orgs/${ORG.id}/secrets`]: () => json({ items: secrets }),
      [`POST /orgs/${ORG.id}/secrets`]: (init) => {
        sent.push({ route: 'create', body: body(init) });
        return json(secret({ id: 'sec_New0000000000001', name: 'New' }), 201);
      },
      [`PATCH /secrets/${PENDING.id}`]: (init) => {
        sent.push({ route: 'update', body: body(init) });
        return json({ ...PENDING, allowed_hosts: ['api.crm.test'], legacy_hosts_until: null });
      },
    },
  });
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

async function openAdd() {
  await renderApp(PATH);
  const section = await screen.findByTestId('http-secrets-section');
  await userEvent.click(within(section).getByTestId('secret-add'));
  return screen.findByTestId('secret-form');
}

describe('allowed hosts as chips (T717)', () => {
  it('adds, refuses and removes hosts with the keyboard, announcing each change', async () => {
    const sent = serve([secret({})]);
    const form = await openAdd();
    const input = within(form).getByTestId('secret-allowed-hosts');
    expect(within(form).getByTestId('secret-allowed-hosts-rules')).toHaveTextContent(
      /its subdomains only .* not example\.com itself/u,
    );
    expect(within(form).getByTestId('secret-allowed-hosts-rules')).toHaveTextContent(
      'This list does not open internal addresses or other ports — the HTTP allowlist above does.',
    );

    // An IP address stays typed, with the reason.
    await userEvent.type(input, '10.0.0.1{Enter}');
    expect(within(form).getByTestId('secret-allowed-hosts-problem')).toHaveTextContent(
      'Not a host: 10.0.0.1.',
    );
    expect(input).toHaveValue('10.0.0.1');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(within(form).queryAllByTestId('secret-allowed-host-chip')).toHaveLength(0);

    // A host becomes a chip in its stored form; the preview said so first.
    await userEvent.clear(input);
    await userEvent.type(input, '*.CRM.test');
    expect(
      within(form).getByText('Press Enter to add — will be saved as *.crm.test'),
    ).toBeVisible();
    await userEvent.keyboard('{Enter}');
    expect(within(form).getAllByTestId('secret-allowed-host-chip')[0]).toHaveTextContent(
      '*.crm.test',
    );
    expect(input).toHaveValue('');
    expect(within(form).getByTestId('secret-allowed-hosts-count')).toHaveTextContent(
      '1 / 20 hosts',
    );
    expect(within(form).getByRole('status')).toHaveTextContent('Added *.crm.test. 1 / 20 hosts');

    // A comma adds too; a duplicate is named.
    await userEvent.type(input, 'api.crm.test,*.crm.test,');
    expect(within(form).getAllByTestId('secret-allowed-host-chip')).toHaveLength(2);
    expect(within(form).getByTestId('secret-allowed-hosts-problem')).toHaveTextContent(
      'Already listed: *.crm.test.',
    );

    // Backspace in the empty input moves to the last chip; Delete removes it.
    await userEvent.keyboard('{Backspace}');
    expect(within(form).getByRole('button', { name: 'Remove api.crm.test' })).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(within(form).getByRole('button', { name: 'Remove *.crm.test' })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}{Delete}');
    await waitFor(() => {
      expect(within(form).getAllByTestId('secret-allowed-host-chip')).toHaveLength(1);
    });
    expect(within(form).getByRole('status')).toHaveTextContent('Removed api.crm.test.');
    await waitFor(() => {
      expect(within(form).getByRole('button', { name: 'Remove *.crm.test' })).toHaveFocus();
    });
    expect(await axeViolations(document.body)).toEqual([]);

    await userEvent.type(within(form).getByTestId('secret-name'), 'CRM');
    await userEvent.type(within(form).getByTestId('secret-value'), 'Bearer x');
    await userEvent.click(within(form).getByTestId('secret-save'));
    await waitFor(() => {
      expect(sent[0]).toMatchObject({ route: 'create', body: { allowed_hosts: ['*.crm.test'] } });
    });
  });

  it('turns a paste of several hosts into chips', async () => {
    serve([]);
    const form = await openAdd();
    const input = within(form).getByTestId('secret-allowed-hosts');
    await userEvent.click(input);
    await userEvent.paste('api.crm.test\nhooks.crm.test:8443\nhttps://bad.test/x');
    const chips = within(form).getAllByTestId('secret-allowed-host-chip');
    expect(chips.map((chip) => chip.textContent)).toEqual(['api.crm.test', 'hooks.crm.test:8443']);
    expect(input).toHaveValue('https://bad.test/x');
  });
});

describe('secrets without allowed hosts (T717)', () => {
  it('labels their deadline or that they stopped, with a banner on top of the page', async () => {
    const sent = serve([secret({}), PENDING, STOPPED]);
    await renderApp(PATH);
    const banner = await screen.findByTestId('legacy-hosts-banner');
    expect(banner).toHaveTextContent('2 HTTP secrets have no allowed hosts');
    expect(banner).toHaveTextContent(/the first one is .*2999/u);
    expect(banner).toHaveTextContent('1 of them already stopped sending');
    expect(within(banner).getByRole('link', { name: 'Set their hosts' })).toHaveAttribute(
      'href',
      '#http-secrets',
    );

    const rows = await screen.findAllByTestId('http-secret-row');
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByTestId('http-secret-hosts')).toHaveTextContent(
      'Sent only to: api.crm.test',
    );
    expect(within(rows[0] as HTMLElement).queryByTestId('http-secret-legacy')).toBeNull();
    expect(within(rows[1] as HTMLElement).getByTestId('http-secret-legacy')).toHaveTextContent(
      /Set hosts before .*2999/u,
    );
    expect(within(rows[2] as HTMLElement).getByTestId('http-secret-legacy')).toHaveTextContent(
      'Sending stopped',
    );
    expect(await axeViolations(document.body)).toEqual([]);

    // "Set hosts" opens the form; the list may stay empty until then, a host ends the period.
    await userEvent.click(screen.getByRole('button', { name: 'Set allowed hosts of Old CRM' }));
    const form = await screen.findByTestId('secret-form');
    expect(form).toHaveTextContent('This secret has no allowed hosts yet');
    await userEvent.type(within(form).getByTestId('secret-allowed-hosts'), 'api.crm.test{Enter}');
    await userEvent.click(within(form).getByTestId('secret-save'));
    await waitFor(() => {
      expect(sent[0]).toEqual({ route: 'update', body: { allowed_hosts: ['api.crm.test'] } });
    });
  });

  it('shows no banner when every HTTP secret has hosts', async () => {
    serve([secret({})]);
    await renderApp(PATH);
    await screen.findAllByTestId('http-secret-row');
    expect(screen.queryByTestId('legacy-hosts-banner')).toBeNull();
  });
});
