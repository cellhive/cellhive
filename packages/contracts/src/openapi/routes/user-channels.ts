import { z } from 'zod';

import { idOf } from '../../ids.js';
import {
  orgNotificationChannelsSchema,
  telegramLinkSchema,
  updateOrgNotificationChannelsSchema,
  userChannelListSchema,
} from '../../user-channels.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { register, type RouteSpec } from './route-spec.js';

const orgParams = z.object({ orgId: idOf('org') });

const ADMIN_ONLY =
  '`PERMISSION_DENIED`: the caller is a member but not an owner/admin of the organization, ' +
  'or `CSRF_INVALID`';

const OWN =
  "The caller's own channels in the organization (any member; a non-member gets `404`). " +
  'Never a chat id or a Telegram name.';

/** Notification bot and personal channels (CONTRACTS §22.7; BACKLOG T549). */
export const registerUserChannelRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  const add = (spec: RouteSpec) => {
    register(registry, problem, spec);
  };

  add({
    method: 'get',
    path: '/api/v1/orgs/{orgId}/notification-channels',
    operationId: 'getOrgNotificationChannels',
    tag: 'notifications',
    summary: "The organization's notification bot",
    description:
      'Organization owner/admin only. Which `telegram_bot` secret sends personal notifications, ' +
      'its username and what the poller last saw (`ok`, `webhook_conflict`, `invalid_token`), ' +
      'how it receives updates (`delivery_mode`) and, in `webhook` mode, what the hourly ' +
      'check last saw (`webhook_status`).',
    params: orgParams,
    status: 200,
    response: orgNotificationChannelsSchema,
    forbidden: ADMIN_ONLY,
  });
  add({
    method: 'patch',
    path: '/api/v1/orgs/{orgId}/notification-channels',
    operationId: 'updateOrgNotificationChannels',
    tag: 'notifications',
    summary: 'Choose (or remove) the notification bot, or change how it receives updates',
    description:
      'Organization owner/admin only. At least one of `telegram_secret_id`, ' +
      '`telegram_delivery_mode`. The secret must be a `telegram_bot` secret of the ' +
      'organization (its base scope does not apply); its token is checked with Telegram ' +
      '`getMe`. Choosing another bot or `null` puts every personal Telegram channel of the ' +
      'organization in `error` (`bot_changed`) and cancels pending links. ' +
      '`telegram_delivery_mode = webhook` needs an `https` `PUBLIC_URL` (port 443/80/88/8443) ' +
      'and a bot without a webhook pointing elsewhere (checked with `getWebhookInfo`, never ' +
      'overwritten), then calls `setWebhook`; back to `polling`, or another bot, calls ' +
      '`deleteWebhook` on the old bot. Audited as `org.updated` (secret id, bot username and ' +
      'delivery mode, never a token).',
    params: orgParams,
    body: updateOrgNotificationChannelsSchema,
    status: 200,
    response: orgNotificationChannelsSchema,
    forbidden: ADMIN_ONLY,
    errors: {
      422:
        '`VALIDATION_FAILED`: malformed body, `errors[].code` `UNKNOWN_SECRET` (not a ' +
        '`telegram_bot` secret of the organization), `INVALID_BOT_TOKEN` (Telegram refused ' +
        'the token), `BOT_IN_USE` (the bot is the notification bot of another organization), ' +
        '`PUBLIC_URL_NOT_HTTPS` or `TELEGRAM_WEBHOOK_CONFLICT` (webhook mode); ' +
        '`TELEGRAM_NOT_CONFIGURED`: webhook mode without a notification bot',
      503:
        '`DEPENDENCY_UNAVAILABLE`: Telegram did not answer `getMe`, `getWebhookInfo`, ' +
        '`setWebhook` or `deleteWebhook`',
    },
  });
  add({
    method: 'get',
    path: '/api/v1/orgs/{orgId}/me/channels',
    operationId: 'listMyChannels',
    tag: 'notifications',
    summary: 'My personal notification channels',
    description:
      `${OWN} \`status\`: \`linked\`, \`error\` (\`error_reason\` \`bot_changed\` | ` +
      '`blocked`) or `pending` (a link waits to be opened). `available_kinds` lists what the ' +
      'caller can link now (`telegram` when the organization has a notification bot).',
    params: orgParams,
    status: 200,
    response: userChannelListSchema,
  });
  add({
    method: 'post',
    path: '/api/v1/orgs/{orgId}/me/channels/telegram',
    operationId: 'createMyTelegramLink',
    tag: 'notifications',
    summary: 'Create a one-time Telegram link',
    description:
      `${OWN} Opens the notification bot with \`/start <token>\`: the token (32 characters, ` +
      'one use, 10 minutes) is only in this response — the server keeps its SHA-256. At most 5 ' +
      'links pending per member (older ones are cancelled) and 5 created per hour.',
    params: orgParams,
    status: 201,
    response: telegramLinkSchema,
    errors: {
      422: '`TELEGRAM_NOT_CONFIGURED`: the organization has no notification bot',
      429: '`RATE_LIMITED` with `Retry-After`: 5 links were created in the last hour',
    },
  });
  add({
    method: 'delete',
    path: '/api/v1/orgs/{orgId}/me/channels/telegram',
    operationId: 'unlinkMyTelegram',
    tag: 'notifications',
    summary: 'Unlink my Telegram chat',
    description:
      `${OWN} Removes the channel and cancels pending links; idempotent. Audited as ` +
      '`user_channel.unlinked`.',
    params: orgParams,
    status: 204,
  });
};
