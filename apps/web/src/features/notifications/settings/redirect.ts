import { redirect, type LoaderFunctionArgs } from 'react-router';

import { loginPathFor } from '../../../lib/navigation/safe-next';
import { PREFERENCE_KEYS, readPreference } from '../../../lib/preferences';
import { meQuery } from '../../../lib/session/session';

import type { QueryClient } from '@tanstack/react-query';

/**
 * (T524) Loader of `/me/settings/notifications`, the "Manage notifications"
 * link of notification emails sent before settings were per organization
 * (CONTRACTS §22.4): the settings of the last used (else first)
 * organization; without any, the home screen. A lazy route module, so the
 * app's entry does not carry it.
 */
export function notificationSettingsRedirect(queryClient: QueryClient) {
  return async ({ request }: LoaderFunctionArgs) => {
    const session = await queryClient.query(meQuery());
    if (session === null) throw redirect(loginPathFor(new URL(request.url)));
    const last = readPreference(PREFERENCE_KEYS.lastOrg);
    const org = session.orgs.find((item) => item.slug === last) ?? session.orgs[0];
    if (org === undefined) throw redirect('/');
    throw redirect(`/o/${encodeURIComponent(org.slug)}/settings/notifications`);
  };
}
