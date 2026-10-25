import { Spinner } from '@cellhive/ui';
import { WifiOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useConnectionState, type ConnectionState } from './connection';

/**
 * Fixed banner at the top of the page while the browser is offline or the
 * WebSocket has been lost for more than 5 s (FRONTEND §5, §8.3). The
 * wrapper is a live region that is always present, so that a notice
 * appearing in it is announced; it has no `status` role, not to compete with
 * the status messages of the pages.
 */
export function ConnectionBanner({ state: forced }: { state?: ConnectionState }) {
  const { t } = useTranslation('common');
  const current = useConnectionState();
  const state = forced ?? current;
  return (
    <div aria-live="polite" data-testid="connection-banner" className="sticky top-0 z-50">
      {state === 'online' ? null : (
        <div className="flex items-center justify-center gap-2 border-b border-warning bg-surface px-3 py-1.5 text-label text-fg">
          {state === 'offline' ? (
            <WifiOff aria-hidden="true" className="size-4 shrink-0 text-warning" />
          ) : (
            <Spinner className="text-warning" />
          )}
          <span>
            {state === 'offline' ? t('connection.offline') : t('connection.reconnecting')}
          </span>
        </div>
      )}
    </div>
  );
}
