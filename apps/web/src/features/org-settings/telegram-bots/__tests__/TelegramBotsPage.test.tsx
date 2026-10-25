import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, ME, ORG, renderApp, stubApi } from '../../../../../test/app-harness';
import { axeViolations } from '../../../../../test/axe';
import { clearToasts } from '../../../../lib/toast/toast';

import type { SecretDto } from '@cellhive/contracts';

const PATH = `/o/${ORG.slug}/settings/telegram`;
const NOW = '2026-10-05T03:00:00.000Z';
const BASE = { id: 'bse_0123456789ABCDEF', name: 'Sales' } as const;
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';

const SALES: SecretDto = {
  id: 'sec_0000000000000001',
  organization_id: ORG.id,
  kind: 'telegram_bot',
  name: 'Bot Sales',
  base_scope: 'selected',
  base_ids: [BASE.id],
  allowed_hosts: [],
  legacy_hosts_until: null,
  previous_value_expires_at: null,
  created_by: { id: ME.user.id, name: 'Me' },
  created_at: NOW,
  updated_at: NOW,
};

interface Call {
  readonly route: string;
  readonly body: unknown;
}

function serve(initial: SecretDto[], role: 'owner' | 'member' = 'owner', notificationBot = false) {
  let items = initial;
  const calls: Call[] = [];
  const body = (init: RequestInit | undefined): unknown =>
    typeof init?.body === 'string' ? JSON.parse(init.body) : null;
  const routes: Record<string, (init: RequestInit | undefined) => Response> = {
    'GET /me': () => json({ ...ME, orgs: [{ ...ME.orgs[0], role }] }),
    [`GET /orgs/${ORG.id}`]: () => json(ORG),
    [`GET /orgs/${ORG.id}/secrets`]: () => json({ items }),
    [`GET /orgs/${ORG.id}/workspaces`]: () =>
      json({
        items: [
          {
            id: 'wsp_0123456789ABCDEF',
            organization_id: ORG.id,
            name: 'Main',
            slug: 'main',
            role: 'admin',
            created_at: NOW,
            updated_at: NOW,
          },
        ],
        total: 1,
        offset: 0,
        limit: 1000,
      }),
    'GET /workspaces/wsp_0123456789ABCDEF/bases': () =>
      json({
        items: [
          {
            id: BASE.id,
            organization_id: ORG.id,
            workspace_id: 'wsp_0123456789ABCDEF',
            owner_id: ME.user.id,
            name: BASE.name,
            icon: null,
            description: null,
            permission_version: 1,
            created_at: NOW,
            updated_at: NOW,
            deleted_at: null,
          },
        ],
        total: 1,
        offset: 0,
        limit: 1000,
      }),
    [`POST /orgs/${ORG.id}/secrets`]: (init) => {
      calls.push({ route: 'create', body: body(init) });
      const sent = body(init) as { name: string; base_scope: 'all' | 'selected' };
      const created: SecretDto = {
        ...SALES,
        id: 'sec_0000000000000009',
        name: sent.name,
        base_scope: sent.base_scope,
        base_ids: [],
        allowed_hosts: [],
        legacy_hosts_until: null,
        previous_value_expires_at: null,
      };
      items = [...items, created];
      return json(created, 201);
    },
    [`GET /secrets/${SALES.id}/usages`]: () =>
      json({
        items: [
          ...(notificationBot ? [{ kind: 'notification_channel' }] : []),
          {
            kind: 'automation',
            automation_id: 'aut_0000000000000001',
            base_id: BASE.id,
            name: 'Báo đơn',
          },
        ],
        total: notificationBot ? 2 : 1,
      }),
    [`DELETE /secrets/${SALES.id}`]: () =>
      new Response(
        JSON.stringify({
          type: 'x',
          title: 'x',
          status: 409,
          code: 'SECRET_IN_USE',
          errors: [
            {
              path: '',
              code: 'SECRET_IN_USE',
              message: 'x',
              params: { usages: [], total: 1 },
            },
          ],
        }),
        { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
      ),
  };
  stubApi({ signedIn: true, routes });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

describe('TelegramBotsPage (T516)', () => {
  it('lists the bots with their bases, never a token', async () => {
    serve([SALES]);
    await renderApp(PATH);
    const row = await screen.findByTestId('bot-row');
    expect(row).toHaveTextContent('Bot Sales');
    await waitFor(() => {
      expect(row).toHaveTextContent('Bases: Sales');
    });
    expect(document.body).not.toHaveTextContent('AAH');
    expect(screen.getByTestId('nav-telegram')).toHaveAttribute('aria-current', 'page');
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('adds a bot: the token is checked, sent once, and not shown again', async () => {
    const { calls } = serve([]);
    const user = userEvent.setup();
    await renderApp(PATH);
    await user.click(await screen.findByTestId('bot-add'));
    const dialog = await screen.findByRole('dialog', { name: 'Add a Telegram bot' });
    await user.type(within(dialog).getByLabelText('Name'), 'Bot IT');
    await user.type(within(dialog).getByLabelText('Bot token'), 'not-a-token');
    await user.click(within(dialog).getByTestId('bot-save'));
    expect(within(dialog).getByText(/This is not a Telegram bot token/u)).toBeInTheDocument();
    expect(calls).toEqual([]);
    await user.clear(within(dialog).getByLabelText('Bot token'));
    await user.type(within(dialog).getByLabelText('Bot token'), TOKEN);
    expect(within(dialog).getByLabelText('Bot token')).toHaveAttribute('type', 'password');
    await user.click(within(dialog).getByTestId('bot-save'));
    await waitFor(() => {
      expect(calls).toEqual([
        {
          route: 'create',
          body: {
            kind: 'telegram_bot',
            name: 'Bot IT',
            value: TOKEN,
            base_scope: 'all',
            base_ids: [],
          },
        },
      ]);
    });
    expect(await screen.findByText('Bot “Bot IT” added.')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('AAHdq');
  });

  it('delete lists the automations using the bot and shows the 409', async () => {
    serve([SALES]);
    const user = userEvent.setup();
    await renderApp(PATH);
    await user.click(await screen.findByTestId('bot-delete'));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete Bot Sales?' });
    expect(await within(dialog).findByTestId('bot-usages')).toHaveTextContent('Báo đơn');
    await user.click(within(dialog).getByTestId('bot-delete-confirm'));
    expect(
      await within(dialog).findAllByText('Automations still use this bot. Change them first.'),
    ).not.toHaveLength(0);
  });

  it('delete says when the bot sends the notifications of the organization (T549)', async () => {
    serve([SALES], 'owner', true);
    const user = userEvent.setup();
    await renderApp(PATH);
    await user.click(await screen.findByTestId('bot-delete'));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete Bot Sales?' });
    expect(await within(dialog).findByTestId('bot-notification-usage')).toHaveTextContent(
      'This bot sends members their notifications',
    );
    expect(within(dialog).getByText('1 automation uses this bot: change it first.')).toBeVisible();
    expect(within(dialog).getByTestId('bot-usages')).toHaveTextContent('Báo đơn');
  });

  it('members get the not-found screen', async () => {
    serve([SALES], 'member');
    await renderApp(PATH);
    expect(await screen.findByRole('heading', { name: /not found/iu })).toBeInTheDocument();
    expect(screen.queryByTestId('bot-row')).not.toBeInTheDocument();
  });
});
