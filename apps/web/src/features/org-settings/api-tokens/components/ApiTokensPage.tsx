import { cn, Skeleton } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams } from 'react-router';

import { useDocumentTitle } from '../../../../lib/a11y/use-document-title';
import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { PAGE_GUTTER, PageHeading } from '../../../../lib/layout/page-heading';
import { notFound } from '../../../../lib/navigation/not-found';
import { isOrgAdmin } from '../../../../lib/permissions/org';
import { orgQuery } from '../../../../lib/query/queries';
import { meQuery } from '../../../../lib/session/session';
import { policyOf } from '../api';

import { MyTokens } from './MyTokens';
import { OrgTokens } from './OrgTokens';
import { PolicyForm } from './PolicyForm';

const TABS = ['mine', 'all', 'policy'] as const;
const PANEL_ID = 'api-tokens-panel';
type Tab = (typeof TABS)[number];

/**
 * `/o/:orgSlug/settings/api-tokens` (BACKLOG T714, CONTRACTS §26; no board
 * "S6 · API tokens" on the canvas — built like the integrations page,
 * FRONTEND §15.5). Every member: "Mine"; organization owners/admins also
 * "All tokens" and "Policy" (`?tab=all|policy`; others always see "Mine").
 */
export function ApiTokensPage() {
  const { t } = useTranslation('apiTokens');
  const { orgSlug } = useParams();
  const [params, setParams] = useSearchParams();
  const me = useQuery(meQuery());
  const summary = me.data?.orgs.find((item) => item.slug === orgSlug);
  const org = useQuery({
    ...orgQuery(summary?.id ?? ''),
    enabled: summary !== undefined,
    staleTime: 0,
  });
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  useDocumentTitle(summary === undefined ? undefined : `${t('page.title')} · ${summary.name}`);

  if (me.data !== undefined && summary === undefined) notFound();
  if (summary === undefined) return null;

  const admin = isOrgAdmin(summary.role);
  const visible: readonly Tab[] = admin ? TABS : ['mine'];
  const requested = params.get('tab');
  const tab: Tab = visible.find((item) => item === requested) ?? 'mine';
  const select = (next: Tab) => {
    setParams(
      (current) => {
        const copy = new URLSearchParams(current);
        if (next === 'mine') copy.delete('tab');
        else copy.set('tab', next);
        return copy;
      },
      { replace: true },
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = visible.indexOf(tab);
    const last = visible.length - 1;
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
    select(visible[next] ?? 'mine');
    tabs.current[next]?.focus();
  };
  const policy = policyOf(org.data);

  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <PageHeading
        back={{
          to: `/o/${encodeURIComponent(summary.slug)}`,
          label: t('page.back', { name: summary.name }),
        }}
        icon={KeyRound}
        title={t('page.title')}
        subtitle={t('page.subtitle')}
      >
        {admin ? (
          <div
            role="tablist"
            aria-label={t('page.tabs')}
            className="-mb-px flex gap-1 overflow-x-auto"
          >
            {visible.map((name, index) => (
              <button
                key={name}
                ref={(element) => {
                  tabs.current[index] = element;
                }}
                type="button"
                role="tab"
                id={`api-tokens-tab-${name}`}
                aria-selected={tab === name}
                aria-controls={PANEL_ID}
                tabIndex={tab === name ? 0 : -1}
                data-testid={`api-tokens-tab-${name}`}
                className={cn(
                  'inline-flex min-h-control shrink-0 items-center border-b-2 px-3 text-body whitespace-nowrap lg:min-h-9',
                  tab === name
                    ? 'border-accent font-medium text-fg'
                    : 'border-transparent text-fg-muted hover:text-fg',
                )}
                onClick={() => {
                  select(name);
                }}
                onKeyDown={onKeyDown}
              >
                {t(`page.tab.${name}`)}
              </button>
            ))}
          </div>
        ) : undefined}
      </PageHeading>
      <div
        {...(admin
          ? { role: 'tabpanel', id: PANEL_ID, 'aria-labelledby': `api-tokens-tab-${tab}` }
          : {})}
        className={cn('flex flex-col gap-4 py-6', PAGE_GUTTER)}
      >
        {org.isPending ? (
          <div role="status" aria-busy="true" aria-label={t('page.loading')}>
            <Skeleton className="h-24" />
          </div>
        ) : org.isError ? (
          <ErrorAlert error={org.error} />
        ) : tab === 'all' ? (
          <OrgTokens orgId={summary.id} />
        ) : tab === 'policy' ? (
          <PolicyForm key={org.data.updated_at} orgId={summary.id} policy={policy} />
        ) : (
          <MyTokens orgId={summary.id} policy={policy} />
        )}
      </div>
    </div>
  );
}

export default ApiTokensPage;
