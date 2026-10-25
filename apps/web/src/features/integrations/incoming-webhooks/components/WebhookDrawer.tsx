import { cn, Dialog } from '@cellhive/ui';
import { useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { RequestLog } from './RequestLog';
import { WebhookSettings, type WebhookSettingsProps } from './WebhookSettings';

import type { IncomingWebhookDto } from '@cellhive/contracts';

export const DRAWER_TABS = ['settings', 'requests'] as const;
export type DrawerTab = (typeof DRAWER_TABS)[number];

export interface WebhookDrawerProps {
  readonly baseId: string;
  readonly hook: IncomingWebhookDto | null;
  readonly tab: DrawerTab;
  readonly onTab: (tab: DrawerTab) => void;
  readonly onClose: () => void;
  readonly onRevealed: WebhookSettingsProps['onRevealed'];
  readonly onDelete: () => void;
}

/**
 * One webhook in a drawer beside the list (`Dialog layout="drawer"`, a
 * bottom sheet below 768 px), opened by `?hook=` so it can be linked:
 * tabs "Settings" and "Request log" (`?tab=requests`; WAI-ARIA tabs, arrow
 * keys, Home/End).
 */
export function WebhookDrawer({
  baseId,
  hook,
  tab,
  onTab,
  onClose,
  onRevealed,
  onDelete,
}: WebhookDrawerProps) {
  const { t } = useTranslation('incomingWebhooks');
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = DRAWER_TABS.indexOf(tab);
    const last = DRAWER_TABS.length - 1;
    const next =
      event.key === 'ArrowRight'
        ? index === last
          ? 0
          : index + 1
        : event.key === 'ArrowLeft'
          ? index === 0
            ? last
            : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    const target = DRAWER_TABS[next] ?? 'settings';
    onTab(target);
    tabs.current[next]?.focus();
  };
  return (
    <Dialog
      open={hook !== null}
      layout="drawer"
      className="md:overflow-y-auto"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={hook?.name ?? ''}
      description={t('drawer.description')}
      closeLabel={t('common.close')}
    >
      {hook === null ? null : (
        <div className="flex flex-col gap-4" data-testid="hook-drawer">
          <div
            role="tablist"
            aria-label={t('drawer.tabs')}
            className="-mx-6 flex gap-1 border-b border-line px-6"
          >
            {DRAWER_TABS.map((name, index) => (
              <button
                key={name}
                ref={(element) => {
                  tabs.current[index] = element;
                }}
                type="button"
                role="tab"
                id={`hook-tab-${name}`}
                aria-selected={tab === name}
                aria-controls={`hook-panel-${name}`}
                tabIndex={tab === name ? 0 : -1}
                data-testid={`hook-tab-${name}`}
                className={cn(
                  '-mb-px inline-flex min-h-control items-center border-b-2 px-3 text-body lg:min-h-9',
                  tab === name
                    ? 'border-accent font-medium text-fg'
                    : 'border-transparent text-fg-muted hover:text-fg',
                )}
                onClick={() => {
                  onTab(name);
                }}
                onKeyDown={onKeyDown}
              >
                {t(`drawer.tab.${name}`)}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`hook-panel-${tab}`} aria-labelledby={`hook-tab-${tab}`}>
            {tab === 'settings' ? (
              <WebhookSettings
                baseId={baseId}
                hook={hook}
                onRevealed={onRevealed}
                onDelete={onDelete}
              />
            ) : (
              <RequestLog baseId={baseId} hook={hook} />
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
