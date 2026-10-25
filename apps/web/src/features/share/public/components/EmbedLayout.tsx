import { Suspense } from 'react';
import { Outlet } from 'react-router';

import { SessionlessProvider } from '../../../../lib/session/sessionless';

import { ShareLoading } from './ShareScreens';

/**
 * (T814) Layout of a share page framed by another site (`/s/:token?embed=1`,
 * FRONTEND §2): the page alone — no product header or language picker of
 * the share layout, the host page is the frame. The same rules as the share
 * layout otherwise: never indexed, no `Referer` carrying the token, no
 * session asked for. Only links that may be embedded get a CSP letting the
 * listed origins frame them (nginx + API, CONTRACTS §16A).
 */
export function EmbedLayout() {
  return (
    <div className="flex h-dvh flex-col bg-canvas" data-embed="">
      <meta name="robots" content="noindex, nofollow" />
      <meta name="referrer" content="no-referrer" />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <Suspense fallback={<ShareLoading />}>
          <SessionlessProvider value>
            <Outlet />
          </SessionlessProvider>
        </Suspense>
      </div>
    </div>
  );
}

export default EmbedLayout;
