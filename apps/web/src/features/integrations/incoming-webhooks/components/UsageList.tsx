import { Lock, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { IncomingWebhookUsage } from '@cellhive/contracts';

/**
 * Automations triggered by a hook (`usages`, CONTRACTS §25.1): name and a
 * link to the builder; `name = null` (an automation the caller cannot see)
 * is said so, without a link.
 */
export function UsageList({
  baseId,
  usages,
  'data-testid': testId,
}: {
  readonly baseId: string;
  readonly usages: readonly IncomingWebhookUsage[];
  readonly 'data-testid'?: string;
}) {
  const { t } = useTranslation('incomingWebhooks');
  return (
    <ul
      className="flex max-h-60 flex-col overflow-y-auto rounded-lg border border-line"
      data-testid={testId}
    >
      {usages.map((usage) => (
        <li
          key={usage.automation_id}
          className="flex items-center gap-2 border-t border-line px-3 py-2 first:border-t-0"
        >
          {usage.name === null ? (
            <>
              <Lock aria-hidden="true" className="size-3.5 shrink-0 text-fg-muted" />
              <span className="text-fg-muted">{t('usages.hidden')}</span>
            </>
          ) : (
            <>
              <Zap aria-hidden="true" className="size-3.5 shrink-0 text-fg-muted" />
              <span className="min-w-0 font-medium break-words">{usage.name}</span>
              <Link
                to={`/b/${encodeURIComponent(baseId)}/automations/${encodeURIComponent(usage.automation_id)}`}
                aria-label={t('usages.openNamed', { name: usage.name })}
                className="ml-auto inline-flex min-h-6 shrink-0 items-center text-label text-accent underline-offset-4 hover:underline max-lg:min-h-control"
              >
                {t('usages.open')}
              </Link>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
