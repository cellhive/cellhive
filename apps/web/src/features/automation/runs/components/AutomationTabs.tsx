import { cn } from '@cellhive/ui';
import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

/** Phones: below 768 px the tabs leave the top bar for a row of their own (F§13.2, F§13.3). */
const PHONE_QUERY = '(max-width: 767.98px)';

function subscribePhone(listener: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const media = window.matchMedia(PHONE_QUERY);
  media.addEventListener('change', listener);
  return () => {
    media.removeEventListener('change', listener);
  };
}

function isPhone(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;
}

/**
 * Whether the automation screens use their phone layout (< 768 px): the
 * "Configuration | Run history" tabs sit on a row below the top bar, as in
 * the builder (T527 M3; T556 for the run history, S5-review §4 #16).
 */
export function useAutomationPhoneLayout(): boolean {
  return useSyncExternalStore(subscribePhone, isPhone, () => false);
}

export interface AutomationTabsProps {
  readonly baseId: string;
  readonly automationId: string;
  readonly current: 'config' | 'runs';
}

/** URL of the run history of an automation (T523), optionally opened on a run or filter. */
export function automationRunsPath(
  baseId: string,
  automationId: string,
  search: Readonly<Record<string, string>> = {},
): string {
  const query = new URLSearchParams(search).toString();
  return `/b/${baseId}/automations/${automationId}/runs${query === '' ? '' : `?${query}`}`;
}

/** URL of the run history of every automation of a base (T523). */
export function baseRunsPath(
  baseId: string,
  search: Readonly<Record<string, string>> = {},
): string {
  const query = new URLSearchParams(search).toString();
  return `/b/${baseId}/automations/runs${query === '' ? '' : `?${query}`}`;
}

/**
 * "Configuration | Run history" in the header of an automation (board "S5 ·
 * Run history"): two routes, so links in a `nav` (the current one marked
 * `aria-current="page"`) rather than an ARIA tab list. The builder (T521)
 * shows it with `current="config"`, the run history (T523) with `"runs"`.
 * Its strings are in `common` (the builder chunk does not load the run
 * history's namespace).
 */
export function AutomationTabs({ baseId, automationId, current }: AutomationTabsProps) {
  const { t } = useTranslation('common');
  const tabs = [
    {
      key: 'config',
      to: `/b/${baseId}/automations/${automationId}`,
      label: t('automationTabs.config'),
    },
    { key: 'runs', to: automationRunsPath(baseId, automationId), label: t('automationTabs.runs') },
  ] as const;
  return (
    <nav
      aria-label={t('automationTabs.label')}
      className="flex h-control shrink-0 items-center gap-0.5 rounded-md border border-line bg-surface-sunken p-0.5"
      data-testid="automation-tabs"
    >
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          to={tab.to}
          aria-current={current === tab.key ? 'page' : undefined}
          data-testid={`automation-tab-${tab.key}`}
          className={cn(
            'inline-flex h-full items-center rounded-sm px-3 text-label font-normal whitespace-nowrap text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent max-lg:min-h-[36px]',
            current === tab.key && 'bg-surface font-medium text-fg shadow-sm',
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
