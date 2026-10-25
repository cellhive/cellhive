import { cn } from '@cellhive/ui';
import { useSuspenseQuery } from '@tanstack/react-query';
import {
  ChevronRight,
  History,
  Link2,
  Settings,
  ShieldCheck,
  Trash2,
  Users,
  Webhook,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { useDocumentTitle } from '../../../lib/a11y/use-document-title';
import { PAGE_GUTTER, PageHeading } from '../../../lib/layout/page-heading';
import { baseQuery } from '../../../lib/query/queries';

interface Entry {
  readonly key: string;
  readonly icon: LucideIcon;
  /** Relative to `/b/:baseId`. */
  readonly path: string;
}

/** Where a base admin manages the base; the first five are also in the settings nav. */
const ENTRIES: readonly Entry[] = [
  { key: 'members', icon: Users, path: 'settings/members' },
  { key: 'roles', icon: ShieldCheck, path: 'settings/roles' },
  { key: 'shareLinks', icon: Link2, path: 'settings/share-links' },
  { key: 'webhooks', icon: Webhook, path: 'settings/webhooks' },
  { key: 'audit', icon: History, path: 'settings/audit' },
  { key: 'automations', icon: Zap, path: 'automations' },
  { key: 'trash', icon: Trash2, path: 'trash' },
];

/**
 * `/b/:baseId/settings` (T712, FRONTEND §17): "General" holds entries only
 * — links to the pages where the base is managed (BACKLOG T712: "Chung —
 * chỉ lối vào"); name, icon and description stay in the base menu.
 */
export function BaseSettingsGeneralPage() {
  const { t } = useTranslation('baseSettings');
  const { baseId = '' } = useParams();
  const { data: base } = useSuspenseQuery(baseQuery(baseId));
  useDocumentTitle(`${t('general.title')} · ${base.name}`);
  const root = `/b/${encodeURIComponent(base.id)}`;
  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <PageHeading
        back={{ to: root, label: t('page.back', { name: base.name }) }}
        icon={Settings}
        title={t('general.title')}
        subtitle={t('general.subtitle', { base: base.name })}
      />
      <div className={cn('flex flex-col gap-6 py-6', PAGE_GUTTER)}>
        <ul className="grid gap-3 md:grid-cols-2" data-testid="base-settings-entries">
          {ENTRIES.map((entry) => (
            <li key={entry.key}>
              <Link
                to={`${root}/${entry.path}`}
                className="flex h-full items-start gap-3 rounded-lg border border-line bg-surface p-4 hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-accent"
              >
                <entry.icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-accent" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-body font-medium text-fg">
                    {t(`general.entries.${entry.key}.title`)}
                  </span>
                  <span className="text-label font-normal text-fg-muted">
                    {t(`general.entries.${entry.key}.description`)}
                  </span>
                </span>
                <ChevronRight aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-muted" />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default BaseSettingsGeneralPage;
