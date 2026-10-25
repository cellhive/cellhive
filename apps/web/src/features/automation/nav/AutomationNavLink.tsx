import { cn } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { Zap } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router';

import { automationsQuery } from '../../../lib/query/automations';

/**
 * (T520, board "S5 · Automation list") The sidebar entry of a base's
 * automation list, under its tables, with the number of automations the
 * caller manages — the same query as the list page (one request). The app
 * shell shows it only to people who manage automations (base admins, table
 * managers: `canManageAutomations`); its strings are in `common`, which the
 * shell always has (no lazy namespace in the sidebar).
 */
export function AutomationNavLink({ baseId }: { baseId: string }) {
  const { t, i18n } = useTranslation('common');
  const list = useQuery({ ...automationsQuery(baseId), staleTime: 60_000 });
  const numbers = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const count = list.data?.total;
  return (
    <li className="flex">
      <NavLink
        to={`/b/${encodeURIComponent(baseId)}/automations`}
        data-testid="base-automations-link"
        className={({ isActive }) =>
          cn(
            'flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-body text-fg hover:bg-surface-sunken max-lg:min-h-control',
            isActive && 'bg-accent-soft font-medium text-accent',
          )
        }
      >
        <Zap aria-hidden="true" className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t('nav.automations')}</span>
        {count === undefined ? null : (
          <span
            aria-hidden="true"
            data-testid="base-automations-count"
            className="shrink-0 text-label font-normal text-fg-muted tabular-nums"
          >
            {numbers.format(count)}
          </span>
        )}
      </NavLink>
    </li>
  );
}
