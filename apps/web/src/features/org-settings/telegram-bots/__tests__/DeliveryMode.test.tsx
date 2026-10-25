import {
  PUBLIC_URL_NOT_HTTPS,
  TELEGRAM_DELIVERY_MODES,
  TELEGRAM_WEBHOOK_CONFLICT,
} from '@cellhive/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, ME, ORG, renderApp, stubApi } from '../../../../../test/app-harness';
import { axeViolations } from '../../../../../test/axe';
import { ApiError } from '../../../../lib/api/client';
import { clearToasts } from '../../../../lib/toast/toast';
import {
  DELIVERY_MODES,
  deliveryModeErrorOf,
  fellBackToPolling,
  PUBLIC_URL_NOT_HTTPS_CODE,
  WEBHOOK_CONFLICT_CODE,
} from '../notification-bot/delivery-mode';

describe('local copies of contract constants', () => {
  it('match @cellhive/contracts', () => {
    expect(DELIVERY_MODES).toEqual(TELEGRAM_DELIVERY_MODES);
    expect(PUBLIC_URL_NOT_HTTPS_CODE).toBe(PUBLIC_URL_NOT_HTTPS);
    expect(WEBHOOK_CONFLICT_CODE).toBe(TELEGRAM_WEBHOOK_CONFLICT);
  });
});

import type {
  OrgNotificationChannelsDto,
  SecretDto,
  TelegramDeliveryMode,
  TelegramWebhookStatus,
} from '@cellhive/contracts';

const PATH = `/o/${ORG.slug}/settings/telegram`;
const NOW = '2026-10-18T03:00:00.000Z';

const SALES: SecretDto = {
  id: 'sec_0000000000000001',
  organization_id: ORG.id,
  kind: 'telegram_bot',
  name: 'Bot Sales',
  base_scope: 'all',
  base_ids: [],
  allowed_hosts: [],
  legacy_hosts_until: null,
  previous_value_expires_at: null,
  created_by: { id: ME.user.id, name: 'Me' },
  created_at: NOW,
  updated_at: NOW,
};

function channelsOf(
  mode: TelegramDeliveryMode,
  webhookStatus: TelegramWebhookStatus | null,
  webhookAvailable = true,
): OrgNotificationChannelsDto {
  return {
    telegram: {
      secret_id: SALES.id,
      bot_username: 'sales_bot',
      status: 'ok',
      delivery_mode: mode,
      webhook_status: mode === 'webhook' ? webhookStatus : null,
      webhook_available: webhookAvailable,
    },
  };
}

function problemOf(status: number, code: string, errors: unknown[] = []): Response {
  return new Response(JSON.stringify({ type: 'about:blank', title: code, status, code, errors }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

const invalid = (detail: string) =>
  problemOf(422, 'VALIDATION_FAILED', [
    { path: 'telegram_delivery_mode', code: detail, message: 'x' },
  ]);

function serve(options: {
  readonly mode?: TelegramDeliveryMode;
  readonly webhookStatus?: TelegramWebhookStatus | null;
  /** Answer of `PATCH …/notification-channels` (default: the mode is saved, `webhook_status: ok`). */
  readonly patch?: () => Response;
  /** `webhook_available` of `GET` (default `true`). */
  readonly webhookAvailable?: boolean;
}) {
  let channels = channelsOf(
    options.mode ?? 'polling',
    options.webhookStatus ?? null,
    options.webhookAvailable ?? true,
  );
  const patches: unknown[] = [];
  stubApi({
    signedIn: true,
    routes: {
      'GET /me': () => json(ME),
      [`GET /orgs/${ORG.id}`]: () => json(ORG),
      [`GET /orgs/${ORG.id}/secrets`]: () => json({ items: [SALES] }),
      [`GET /orgs/${ORG.id}/notification-channels`]: () => json(channels),
      [`PATCH /orgs/${ORG.id}/notification-channels`]: (init) => {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : 'null') as {
          telegram_delivery_mode: TelegramDeliveryMode;
        };
        patches.push(body);
        if (options.patch !== undefined) return options.patch();
        channels = channelsOf(body.telegram_delivery_mode, 'ok');
        return json(channels);
      },
      // A token of another bot while in webhook mode: the server falls back to polling (T609).
      [`PATCH /secrets/${SALES.id}`]: () => {
        channels = channelsOf('polling', null);
        return json(SALES);
      },
    },
  });
  return { patches };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

describe('delivery mode helpers', () => {
  const problem = (status: number, code: string) =>
    new ApiError({
      status,
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'telegram_delivery_mode', code, message: 'x' }],
    });

  it.each([
    [problem(422, 'PUBLIC_URL_NOT_HTTPS'), 'public_url'],
    [problem(422, 'TELEGRAM_WEBHOOK_CONFLICT'), 'conflict'],
    [problem(422, 'INVALID_BOT_TOKEN'), null],
    [problem(503, 'PUBLIC_URL_NOT_HTTPS'), null],
    [new Error('network'), null],
  ] as const)('%#: → %s', (error, kind) => {
    expect(deliveryModeErrorOf(error)).toBe(kind);
  });

  it.each([
    ['webhook', 'polling', true],
    ['webhook', 'webhook', false],
    ['polling', 'polling', false],
    [null, 'polling', false],
    [undefined, undefined, false],
  ] as const)('%s → %s: fell back %s', (before, after, expected) => {
    expect(fellBackToPolling(before, after)).toBe(expected);
  });
});

describe('Delivery mode of the notification bot (T614)', () => {
  it('polling by default; switching to webhook saves it and shows the webhook state', async () => {
    const { patches } = serve({});
    const user = userEvent.setup();
    await renderApp(PATH);
    const mode = await screen.findByTestId('delivery-mode');
    const group = within(mode).getByRole('group', { name: 'Receive messages by' });
    expect(within(group).getByRole('radio', { name: /Polling \(default\)/u })).toBeChecked();
    const apply = within(mode).getByTestId('delivery-mode-save');
    expect(apply).toBeDisabled();
    expect(within(mode).queryByTestId('delivery-mode-webhook-state')).toBeNull();
    await user.click(within(group).getByRole('radio', { name: /^Webhook/u }));
    expect(apply).toBeEnabled();
    expect(await axeViolations(document.body)).toEqual([]);
    await user.click(apply);
    await waitFor(() => {
      expect(patches).toEqual([{ telegram_delivery_mode: 'webhook' }]);
    });
    expect(await within(mode).findByTestId('delivery-mode-webhook-status')).toHaveTextContent(
      'Working',
    );
    expect(mode).toHaveAttribute('data-mode', 'webhook');
    expect(await screen.findByText(/straight to Cellhive \(webhook\)/u)).toBeInTheDocument();
  });

  it('PUBLIC_URL not https: explained, and the webhook choice is turned off', async () => {
    serve({ patch: () => invalid('PUBLIC_URL_NOT_HTTPS') });
    const user = userEvent.setup();
    await renderApp(PATH);
    const mode = await screen.findByTestId('delivery-mode');
    await user.click(within(mode).getByTestId('delivery-mode-webhook'));
    await user.click(within(mode).getByTestId('delivery-mode-save'));
    const error = await within(mode).findByTestId('delivery-mode-error');
    expect(error).toHaveAttribute('role', 'alert');
    expect(error).toHaveTextContent('This server is not reachable over HTTPS');
    expect(within(mode).getByTestId('delivery-mode-webhook')).toBeDisabled();
    expect(within(mode).getByTestId('delivery-mode-polling')).toBeChecked();
    expect(within(mode).getByTestId('delivery-mode-unavailable')).toBeVisible();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('webhook_available: false turns the webhook choice off before any save (T616)', async () => {
    const { patches } = serve({ webhookAvailable: false });
    await renderApp(PATH);
    const mode = await screen.findByTestId('delivery-mode');
    expect(within(mode).getByTestId('delivery-mode-webhook')).toBeDisabled();
    expect(within(mode).getByTestId('delivery-mode-polling')).toBeChecked();
    expect(within(mode).getByTestId('delivery-mode-unavailable')).toBeVisible();
    expect(within(mode).getByTestId('delivery-mode-save')).toBeDisabled();
    expect(patches).toEqual([]);
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('a webhook set elsewhere: step-by-step guidance, the bot keeps polling', async () => {
    serve({ patch: () => invalid('TELEGRAM_WEBHOOK_CONFLICT') });
    const user = userEvent.setup();
    await renderApp(PATH);
    const mode = await screen.findByTestId('delivery-mode');
    await user.click(within(mode).getByTestId('delivery-mode-webhook'));
    await user.click(within(mode).getByTestId('delivery-mode-save'));
    const error = await within(mode).findByTestId('delivery-mode-error');
    expect(error).toHaveTextContent('already sends its messages to another webhook');
    expect(within(error).getAllByRole('listitem')).toHaveLength(2);
    expect(error).toHaveTextContent('keeps receiving messages by polling');
    // Not the PUBLIC_URL case: the choice stays available.
    expect(within(mode).getByTestId('delivery-mode-webhook')).toBeEnabled();
    expect(mode).toHaveAttribute('data-mode', 'polling');
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('webhook errors seen by the hourly check come with what to do; back to polling', async () => {
    const { patches } = serve({ mode: 'webhook', webhookStatus: 'error' });
    const user = userEvent.setup();
    await renderApp(PATH);
    const mode = await screen.findByTestId('delivery-mode');
    expect(within(mode).getByTestId('delivery-mode-webhook-status')).toHaveTextContent(
      'Delivery errors',
    );
    expect(within(mode).getByTestId('delivery-mode-webhook-error')).toHaveTextContent(
      'Check that PUBLIC_URL is reachable from the internet',
    );
    expect(await axeViolations(document.body)).toEqual([]);
    await user.click(within(mode).getByTestId('delivery-mode-polling'));
    await user.click(within(mode).getByTestId('delivery-mode-save'));
    await waitFor(() => {
      expect(patches).toEqual([{ telegram_delivery_mode: 'polling' }]);
    });
    await waitFor(() => {
      expect(within(mode).queryByTestId('delivery-mode-webhook-state')).toBeNull();
    });
  });

  it('no mode choice without a notification bot', async () => {
    stubApi({
      signedIn: true,
      routes: {
        'GET /me': () => json(ME),
        [`GET /orgs/${ORG.id}`]: () => json(ORG),
        [`GET /orgs/${ORG.id}/secrets`]: () => json({ items: [SALES] }),
        [`GET /orgs/${ORG.id}/notification-channels`]: () =>
          json({
            telegram: {
              secret_id: null,
              bot_username: null,
              status: null,
              delivery_mode: null,
              webhook_status: null,
              webhook_available: true,
            },
          }),
      },
    });
    await renderApp(PATH);
    await screen.findByTestId('notification-bot-none');
    expect(screen.queryByTestId('delivery-mode')).toBeNull();
  });

  it('a token change of the notification bot in webhook mode: told it went back to polling', async () => {
    serve({ mode: 'webhook', webhookStatus: 'ok' });
    const user = userEvent.setup();
    await renderApp(PATH);
    await screen.findByTestId('delivery-mode-webhook-status');
    await user.click(screen.getByRole('button', { name: 'Change Bot Sales' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change Bot Sales' });
    expect(within(dialog).getByTestId('bot-notification-token-hint')).toHaveTextContent(
      'receiving goes back to polling',
    );
    await user.type(
      within(dialog).getByTestId('bot-token'),
      '222222222:AAH-another-bot-token-0000000000000',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/receiving went back to polling/u)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('delivery-mode')).toHaveAttribute('data-mode', 'polling');
    });
  });
});
