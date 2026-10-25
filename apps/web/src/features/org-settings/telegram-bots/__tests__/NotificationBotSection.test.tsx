import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, ME, ORG, renderApp, stubApi } from '../../../../../test/app-harness';
import { axeViolations } from '../../../../../test/axe';
import { clearToasts } from '../../../../lib/toast/toast';

import type { OrgNotificationChannelsDto, SecretDto } from '@cellhive/contracts';

const PATH = `/o/${ORG.slug}/settings/telegram`;
const NOW = '2026-10-17T03:00:00.000Z';

function bot(id: string, name: string): SecretDto {
  return {
    id: id as SecretDto['id'],
    organization_id: ORG.id,
    kind: 'telegram_bot',
    name,
    base_scope: 'all',
    base_ids: [],
    allowed_hosts: [],
    legacy_hosts_until: null,
    previous_value_expires_at: null,
    created_by: { id: ME.user.id, name: 'Me' },
    created_at: NOW,
    updated_at: NOW,
  };
}

const SALES = bot('sec_0000000000000001', 'Bot Sales');
const SUPPORT = bot('sec_0000000000000002', 'Bot Support');
const USERNAMES: Record<string, string> = { [SALES.id]: 'sales_bot', [SUPPORT.id]: 'support_bot' };

type Status = OrgNotificationChannelsDto['telegram']['status'];

function channelsOf(secretId: string | null, status: Status): OrgNotificationChannelsDto {
  return {
    telegram: {
      secret_id: secretId as OrgNotificationChannelsDto['telegram']['secret_id'],
      bot_username: secretId === null ? null : (USERNAMES[secretId] ?? null),
      status: secretId === null ? null : status,
      delivery_mode: secretId === null ? null : 'polling',
      webhook_status: null,
      webhook_available: true,
    },
  };
}

function problemOf(status: number, code: string, errors: unknown[] = []): Response {
  return new Response(
    JSON.stringify({
      type: `https://cellhive.io/errors/${code}`,
      title: code,
      status,
      code,
      errors,
      request_id: 'req_0123456789ABCDEF',
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

function serve(options: {
  readonly bots: SecretDto[];
  readonly current: string | null;
  readonly status?: Status;
  readonly patch?: () => Response;
}) {
  let channels = channelsOf(options.current, options.status ?? 'ok');
  const patches: unknown[] = [];
  stubApi({
    signedIn: true,
    routes: {
      'GET /me': () => json(ME),
      [`GET /orgs/${ORG.id}`]: () => json(ORG),
      [`GET /orgs/${ORG.id}/secrets`]: () => json({ items: options.bots }),
      [`GET /orgs/${ORG.id}/notification-channels`]: () => json(channels),
      [`PATCH /orgs/${ORG.id}/notification-channels`]: (init) => {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : 'null') as {
          telegram_secret_id: string | null;
        };
        patches.push(body);
        if (options.patch !== undefined) return options.patch();
        channels = channelsOf(body.telegram_secret_id, 'ok');
        return json(channels);
      },
      [`DELETE /secrets/${SALES.id}`]: () =>
        problemOf(409, 'SECRET_IN_USE', [
          {
            path: '',
            code: 'SECRET_IN_USE',
            message: 'x',
            params: { usages: [{ kind: 'notification_channel' }], total: 1 },
          },
        ]),
      [`GET /secrets/${SALES.id}/usages`]: () =>
        json({ items: [{ kind: 'notification_channel' }], total: 1 }),
    },
  });
  return { patches };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

describe('Notification bot of the Telegram bots page (T555)', () => {
  it('no bot yet: choosing the first one saves at once (no confirmation)', async () => {
    const { patches } = serve({ bots: [SALES, SUPPORT], current: null });
    const user = userEvent.setup();
    await renderApp(PATH);
    const section = await screen.findByTestId('notification-bot');
    expect(await within(section).findByTestId('notification-bot-none')).toBeInTheDocument();
    expect(within(section).getByText(/Nothing is sent to anyone when you save/u)).toBeVisible();
    const save = within(section).getByTestId('notification-bot-save');
    expect(save).toBeDisabled();
    await user.selectOptions(
      within(section).getByLabelText('Bot that sends notifications'),
      SALES.id,
    );
    await user.click(save);
    await waitFor(() => {
      expect(patches).toEqual([{ telegram_secret_id: SALES.id }]);
    });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(await within(section).findByTestId('notification-bot-username')).toHaveTextContent(
      '@sales_bot',
    );
    expect(within(section).getByTestId('notification-bot-status')).toHaveTextContent('Working');
    expect(await screen.findByText('@sales_bot now sends notifications.')).toBeInTheDocument();
    // The chosen bot is labelled in the list.
    const rows = screen.getAllByTestId('bot-row');
    expect(within(rows[0] as HTMLElement).getByTestId('bot-notification-label')).toHaveTextContent(
      'Notification bot',
    );
    expect(within(rows[1] as HTMLElement).queryByTestId('bot-notification-label')).toBeNull();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('changing the bot warns that everyone has to link again', async () => {
    const { patches } = serve({ bots: [SALES, SUPPORT], current: SALES.id });
    const user = userEvent.setup();
    await renderApp(PATH);
    const section = await screen.findByTestId('notification-bot');
    expect(await within(section).findByTestId('notification-bot-username')).toHaveTextContent(
      '@sales_bot',
    );
    expect(
      within(section).getByText(/Changing or removing the bot unlinks everyone/u),
    ).toBeVisible();
    await user.selectOptions(within(section).getByTestId('notification-bot-select'), SUPPORT.id);
    await user.click(within(section).getByTestId('notification-bot-save'));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Change the notification bot?',
    });
    expect(dialog).toHaveTextContent('Members have to link Telegram again');
    expect(dialog).toHaveTextContent('“Bot Support”');
    expect(patches).toEqual([]);
    expect(await axeViolations(document.body)).toEqual([]);
    await user.click(within(dialog).getByTestId('notification-bot-confirm'));
    await waitFor(() => {
      expect(patches).toEqual([{ telegram_secret_id: SUPPORT.id }]);
    });
    expect(await within(section).findByText('@support_bot')).toBeInTheDocument();
  });

  it('removing the bot is confirmed too', async () => {
    const { patches } = serve({ bots: [SALES], current: SALES.id });
    const user = userEvent.setup();
    await renderApp(PATH);
    const section = await screen.findByTestId('notification-bot');
    await within(section).findByTestId('notification-bot-username');
    await user.selectOptions(within(section).getByTestId('notification-bot-select'), '');
    await user.click(within(section).getByTestId('notification-bot-save'));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Stop notifications on Telegram?',
    });
    await user.click(within(dialog).getByTestId('notification-bot-confirm'));
    await waitFor(() => {
      expect(patches).toEqual([{ telegram_secret_id: null }]);
    });
    expect(await within(section).findByTestId('notification-bot-none')).toBeInTheDocument();
  });

  it.each([
    ['webhook_conflict', 'Webhook elsewhere', 'Remove that webhook (deleteWebhook)'],
    ['invalid_token', 'Token refused', 'Paste the new token with “Change”'],
  ] as const)('status %s comes with what to do', async (status, badge, guidance) => {
    serve({ bots: [SALES], current: SALES.id, status });
    await renderApp(PATH);
    expect(await screen.findByTestId('notification-bot-status')).toHaveTextContent(badge);
    expect(screen.getByTestId('notification-bot-guidance')).toHaveTextContent(guidance);
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('a refused token is shown (422 INVALID_BOT_TOKEN)', async () => {
    serve({
      bots: [SALES],
      current: null,
      patch: () =>
        problemOf(422, 'VALIDATION_FAILED', [
          { path: 'telegram_secret_id', code: 'INVALID_BOT_TOKEN', message: 'x' },
        ]),
    });
    const user = userEvent.setup();
    await renderApp(PATH);
    const section = await screen.findByTestId('notification-bot');
    await user.selectOptions(
      await within(section).findByTestId('notification-bot-select'),
      SALES.id,
    );
    await user.click(within(section).getByTestId('notification-bot-save'));
    expect(await within(section).findByRole('alert')).toHaveTextContent(
      'This is not a Telegram bot token',
    );
  });

  it('no bots yet: the section says to add one first', async () => {
    serve({ bots: [], current: null });
    await renderApp(PATH);
    expect(await screen.findByTestId('notification-bot-no-bots')).toHaveTextContent(
      'Add a bot below first',
    );
    expect(screen.queryByTestId('notification-bot-select')).not.toBeInTheDocument();
  });

  it('the notification bot cannot be deleted: explained, no delete button', async () => {
    serve({ bots: [SALES], current: SALES.id });
    const user = userEvent.setup();
    await renderApp(PATH);
    await screen.findByTestId('bot-notification-label');
    await user.click(screen.getByTestId('bot-delete'));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete Bot Sales?' });
    expect(within(dialog).getByTestId('bot-delete-blocked')).toHaveTextContent(
      'It cannot be deleted while it sends members their notifications.',
    );
    expect(within(dialog).getByTestId('bot-delete-confirm')).toBeDisabled();
  });

  it('a 409 because it became the notification bot meanwhile is explained', async () => {
    serve({ bots: [SALES], current: null });
    const user = userEvent.setup();
    await renderApp(PATH);
    await screen.findByTestId('notification-bot-none');
    await user.click(screen.getByTestId('bot-delete'));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete Bot Sales?' });
    await user.click(within(dialog).getByTestId('bot-delete-confirm'));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(
      'It cannot be deleted while it sends members their notifications.',
    );
    expect(alert).not.toHaveTextContent('Automations still use this bot');
  });

  it('editing the notification bot explains what a new bot token does', async () => {
    serve({ bots: [SALES], current: SALES.id });
    const user = userEvent.setup();
    await renderApp(PATH);
    await screen.findByTestId('bot-notification-label');
    await user.click(screen.getByRole('button', { name: 'Change Bot Sales' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change Bot Sales' });
    expect(within(dialog).getByTestId('bot-notification-token-hint')).toHaveTextContent(
      'makes every member link Telegram again',
    );
  });
});
