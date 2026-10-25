import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, ME, ORG, problem, renderApp, stubApi } from '../../../../../../test/app-harness';
import { axeViolations } from '../../../../../../test/axe';
import { clearToasts } from '../../../../../lib/toast/toast';

import type { UserChannelDto, UserChannelListDto } from '@cellhive/contracts';

/** Every `user:` handler of the page, to play a realtime message (the test socket never opens). */
const handlers = vi.hoisted(
  () => new Map<string, { onMessage?: (message: unknown) => void; onReconnect?: () => void }[]>(),
);
vi.mock('../../../../../lib/realtime/channels', async (importActual) => {
  const actual = await importActual<typeof import('../../../../../lib/realtime/channels')>();
  return {
    ...actual,
    useRealtimeChannel: (channel: string | null, options: Record<string, unknown>) => {
      if (channel === null) return;
      const list = handlers.get(channel) ?? [];
      // One entry per hook: the latest options of each caller (keyed by its callbacks' shape).
      const key = String(Object.keys(options).sort());
      const index = list.findIndex((item) => String(Object.keys(item).sort()) === key);
      if (index === -1) list.push(options);
      else list[index] = options;
      handlers.set(channel, list);
    },
  };
});

const PATH = `/o/${ORG.slug}/settings/notifications`;
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const LINK = `https://t.me/acme_bot?start=${TOKEN}`;

function playChannelChanged(status: 'linked' | 'error' | 'unlinked') {
  const message = {
    type: 'channel.changed',
    channel: `user:${ME.user.id}`,
    organization_id: ORG.id,
    kind: 'telegram',
    status,
  };
  act(() => {
    for (const handler of handlers.get(`user:${ME.user.id}`) ?? []) handler.onMessage?.(message);
  });
}

function linked(overrides: Partial<UserChannelDto> = {}): UserChannelDto {
  return {
    kind: 'telegram',
    status: 'linked',
    error_reason: null,
    linked_at: '2026-10-16T08:00:00.000Z',
    bot_username: 'acme_bot',
    ...overrides,
  };
}

interface Options {
  readonly role?: 'owner' | 'member';
  readonly channels: UserChannelListDto;
  readonly expiresInMs?: number;
  readonly createStatus?: number;
}

function serve(options: Options) {
  let channels = options.channels;
  const calls: string[] = [];
  const bot = options.channels.available_kinds.includes('telegram');
  const preferences = {
    items: ['automation.disabled', 'record.assigned'].flatMap((type) => [
      { type, channel: 'in_app', enabled: true, locked: type === 'automation.disabled' },
      { type, channel: 'email', enabled: true, locked: false },
      ...(bot ? [{ type, channel: 'telegram', enabled: true, locked: false }] : []),
    ]),
  };
  stubApi({
    signedIn: true,
    smtpEnabled: true,
    routes: {
      'GET /me': () => json({ ...ME, orgs: [{ ...ME.orgs[0], role: options.role ?? 'member' }] }),
      [`GET /orgs/${ORG.id}`]: () => json(ORG),
      [`GET /orgs/${ORG.id}/me/notification-settings`]: () =>
        json({
          email_frequency: 'immediate',
          daily_hour: 8,
          muted_bases: [],
          auto_follow_created: true,
          auto_follow_assigned: true,
        }),
      [`GET /orgs/${ORG.id}/me/notification-preferences`]: () => json(preferences),
      [`GET /orgs/${ORG.id}/me/notifications/unread-count`]: () => json({ count: 0 }),
      [`GET /orgs/${ORG.id}/me/channels`]: () => {
        calls.push('list');
        return json(channels);
      },
      [`POST /orgs/${ORG.id}/me/channels/telegram`]: () => {
        calls.push('create');
        if (options.createStatus === 429) {
          return new Response(
            JSON.stringify({
              type: 'https://cellhive.io/errors/RATE_LIMITED',
              title: 'Too Many Requests',
              status: 429,
              code: 'RATE_LIMITED',
              request_id: 'req_0123456789ABCDEF',
            }),
            {
              status: 429,
              headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '1200' },
            },
          );
        }
        if (options.createStatus === 422) return problem('TELEGRAM_NOT_CONFIGURED', 422);
        channels = {
          ...channels,
          items: [
            ...channels.items.filter((item) => item.status === 'linked'),
            linked({ status: 'pending', linked_at: null }),
          ],
        };
        return json(
          {
            link: LINK,
            expires_at: new Date(Date.now() + (options.expiresInMs ?? 600_000)).toISOString(),
          },
          201,
        );
      },
      [`DELETE /orgs/${ORG.id}/me/channels/telegram`]: () => {
        calls.push('delete');
        channels = { ...channels, items: [] };
        return new Response(null, { status: 204 });
      },
    },
  });
  return {
    calls,
    set(next: UserChannelListDto) {
      channels = next;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
  handlers.clear();
});

const AVAILABLE = ['telegram'] as const;

describe('Telegram channel of the notification settings (T555)', () => {
  it('without a notification bot: members get an explanation, no Telegram column', async () => {
    serve({ channels: { items: [], available_kinds: [] } });
    await renderApp(PATH);
    const section = await screen.findByTestId('telegram-channel');
    expect(await within(section).findByTestId('telegram-unavailable')).toHaveTextContent(
      'Ask an organization owner or admin',
    );
    expect(within(section).queryByTestId('telegram-setup-bot')).not.toBeInTheDocument();
    expect(within(section).queryByTestId('telegram-link')).not.toBeInTheDocument();
    expect(await screen.findByTestId('pref-record.assigned-email')).toBeInTheDocument();
    expect(screen.queryByTestId('pref-record.assigned-telegram')).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Telegram' })).not.toBeInTheDocument();
  });

  it('without a notification bot: admins get a way to the bot page', async () => {
    serve({ role: 'owner', channels: { items: [], available_kinds: [] } });
    await renderApp(PATH);
    const link = await screen.findByTestId('telegram-setup-bot');
    expect(link).toHaveAttribute('href', `/o/${ORG.slug}/settings/telegram`);
    expect(link).toHaveTextContent('Choose a notification bot');
  });

  it('links: t.me link in a new tab + QR + countdown, then linked by realtime', async () => {
    const server = serve({ channels: { items: [], available_kinds: [...AVAILABLE] } });
    const user = userEvent.setup();
    await renderApp(PATH);
    // The Telegram column is there but waits for a link.
    const telegramSwitch = await screen.findByTestId('pref-record.assigned-telegram');
    expect(telegramSwitch).toBeDisabled();
    expect(screen.getByRole('columnheader', { name: 'Telegram' })).toBeInTheDocument();
    expect(screen.getByTestId('pref-telegram-note')).toHaveTextContent(
      'The Telegram column applies once you link Telegram.',
    );
    expect(await screen.findByTestId('telegram-unlinked')).toBeInTheDocument();

    await user.click(screen.getByTestId('telegram-link'));
    const open = await screen.findByTestId('telegram-open');
    expect(open).toHaveAttribute('href', LINK);
    expect(open).toHaveAttribute('target', '_blank');
    expect(open).toHaveAttribute('rel', 'noopener noreferrer');
    expect(open).toHaveAccessibleName('Open Telegram (opens in a new tab)');
    await waitFor(() => {
      expect(open).toHaveFocus();
    });
    expect(
      await screen.findByRole('img', { name: /QR code of the link to @acme_bot/u }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('telegram-countdown')).toHaveTextContent(
      /One-time link, expires in (10:00|9:5\d)/u,
    );
    expect(screen.getByTestId('telegram-announce')).toHaveTextContent(
      'Link created. Open it in Telegram and press Start.',
    );
    expect(screen.getByText(/Press Start in the chat with @acme_bot/u)).toBeInTheDocument();
    expect(await axeViolations(document.body)).toEqual([]);

    // `/start` in Telegram → `channel.changed` → the list is read again.
    server.set({ items: [linked()], available_kinds: [...AVAILABLE] });
    playChannelChanged('linked');
    const done = await screen.findByTestId('telegram-linked');
    expect(done).toHaveTextContent('Linked');
    expect(done).toHaveTextContent('Linked to @acme_bot since');
    expect(screen.queryByTestId('telegram-open')).not.toBeInTheDocument();
    expect(screen.getByTestId('settings-saved')).toHaveTextContent('Telegram is linked.');
    await waitFor(() => {
      expect(screen.getByTestId('pref-record.assigned-telegram')).toBeEnabled();
    });
    expect(screen.queryByTestId('pref-telegram-note')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(TOKEN);
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('unlinks after confirming', async () => {
    const server = serve({ channels: { items: [linked()], available_kinds: [...AVAILABLE] } });
    const user = userEvent.setup();
    await renderApp(PATH);
    await user.click(await screen.findByTestId('telegram-unlink'));
    const dialog = await screen.findByRole('alertdialog', { name: 'Unlink Telegram?' });
    await user.click(within(dialog).getByRole('button', { name: 'Keep linked' }));
    expect(server.calls).not.toContain('delete');
    await user.click(screen.getByTestId('telegram-unlink'));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByTestId('telegram-unlink-confirm'),
    );
    expect(await screen.findByTestId('telegram-unlinked')).toBeInTheDocument();
    expect(server.calls).toContain('delete');
    expect(screen.getByTestId('settings-saved')).toHaveTextContent('Telegram unlinked.');
  });

  it.each([
    ['blocked', 'you may have blocked @acme_bot'],
    [
      'bot_changed',
      'The organization changed its notification bot. Link again, this time with @acme_bot.',
    ],
  ] as const)('error %s: the reason and "Link again"', async (reason, text) => {
    const server = serve({
      channels: {
        items: [linked({ status: 'error', error_reason: reason })],
        available_kinds: [...AVAILABLE],
      },
    });
    const user = userEvent.setup();
    await renderApp(PATH);
    expect(await screen.findByTestId('telegram-error-reason')).toHaveTextContent(text);
    expect(screen.getByTestId('telegram-state')).toHaveTextContent('Not delivered');
    expect(screen.getByTestId('pref-record.assigned-telegram')).toBeDisabled();
    await user.click(screen.getByTestId('telegram-relink'));
    expect(await screen.findByTestId('telegram-open')).toHaveAttribute('href', LINK);
    expect(server.calls).toContain('create');
  });

  it('a link waiting from elsewhere can be replaced or cancelled', async () => {
    const server = serve({
      channels: {
        items: [linked({ status: 'pending', linked_at: null })],
        available_kinds: [...AVAILABLE],
      },
    });
    const user = userEvent.setup();
    await renderApp(PATH);
    expect(await screen.findByTestId('telegram-pending')).toHaveTextContent(
      'A link created in another tab or device is waiting.',
    );
    await user.click(screen.getByTestId('telegram-cancel'));
    expect(await screen.findByTestId('telegram-unlinked')).toBeInTheDocument();
    expect(server.calls).toContain('delete');
  });

  it('an unused link expires: "New link"', async () => {
    serve({ channels: { items: [], available_kinds: [...AVAILABLE] }, expiresInMs: 1500 });
    const user = userEvent.setup();
    await renderApp(PATH);
    await user.click(await screen.findByTestId('telegram-link'));
    expect(await screen.findByTestId('telegram-open')).toBeInTheDocument();
    expect(
      await screen.findByTestId('telegram-expired', {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('telegram-announce')).toHaveTextContent(
        'The Telegram link expired.',
      );
    });
    expect(screen.queryByTestId('telegram-open')).not.toBeInTheDocument();
    expect(screen.getByTestId('telegram-new-link')).toBeEnabled();
  });

  it('too many links: the error with the wait', async () => {
    serve({ channels: { items: [], available_kinds: [...AVAILABLE] }, createStatus: 429 });
    const user = userEvent.setup();
    await renderApp(PATH);
    await user.click(await screen.findByTestId('telegram-link'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests.');
    expect(screen.queryByTestId('telegram-open')).not.toBeInTheDocument();
  });

  it('the bot was just removed: the error, then the explanation', async () => {
    const server = serve({
      channels: { items: [], available_kinds: [...AVAILABLE] },
      createStatus: 422,
    });
    const user = userEvent.setup();
    await renderApp(PATH);
    const button = await screen.findByTestId('telegram-link');
    // Removed meanwhile: the list read again after the `422` has no bot.
    server.set({ items: [], available_kinds: [] });
    await user.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The organization has no Telegram bot for notifications yet.',
    );
    expect(await screen.findByTestId('telegram-unavailable')).toBeInTheDocument();
  });

  it('"Link Telegram" of the table moves to the card', async () => {
    serve({ channels: { items: [], available_kinds: [...AVAILABLE] } });
    const user = userEvent.setup();
    Element.prototype.scrollIntoView = vi.fn();
    await renderApp(PATH);
    await screen.findByTestId('telegram-unlinked');
    await user.click(await screen.findByTestId('pref-telegram-link'));
    expect(screen.getByTestId('telegram-link')).toHaveFocus();
  });
});
