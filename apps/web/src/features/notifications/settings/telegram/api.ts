import { telegramLinkSchema, userChannelListSchema } from '@cellhive/contracts';
import { queryOptions } from '@tanstack/react-query';

import { apiRequest, apiRequestVoid, UNCHECKED_SCHEMA } from '../../../../lib/api/client';
import { keys } from '../../../../lib/query/keys';

const id = encodeURIComponent;
/** Schemas are checked in development only, as the rest of the notification screens (F§14.1). */
const DEV = import.meta.env.DEV;
const me = (orgId: string) => `/orgs/${id(orgId)}/me`;

/**
 * The caller's own personal channels in one organization (BACKLOG T555,
 * CONTRACTS §22.7): read them, create a one-time `t.me` link (10 minutes),
 * unlink (also cancels the links waiting). Never a chat id or a Telegram
 * name; the link token only lives in the answer of `createTelegramLink`
 * and on screen while the link is valid — it is never stored or logged.
 */
export const userChannelsApi = {
  list: (orgId: string, signal?: AbortSignal) =>
    apiRequest(`${me(orgId)}/channels`, DEV ? userChannelListSchema : UNCHECKED_SCHEMA, {
      signal,
    }),
  createTelegramLink: (orgId: string) =>
    apiRequest(`${me(orgId)}/channels/telegram`, DEV ? telegramLinkSchema : UNCHECKED_SCHEMA, {
      method: 'POST',
    }),
  unlinkTelegram: (orgId: string) =>
    apiRequestVoid(`${me(orgId)}/channels/telegram`, { method: 'DELETE' }),
};

/**
 * Kept fresh by `channel.changed` on `user:<me>` (CONTRACTS §7) — no
 * polling; as a fallback (a message missed while the tab slept) it is read
 * again whenever the window gets the focus back.
 */
export const userChannelsQuery = (orgId: string) =>
  queryOptions({
    queryKey: keys.userChannels(orgId),
    queryFn: ({ signal }) => userChannelsApi.list(orgId, signal),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
