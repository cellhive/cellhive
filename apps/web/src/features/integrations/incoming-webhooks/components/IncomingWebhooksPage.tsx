import { INCOMING_WEBHOOKS_MAX_PER_BASE } from '@cellhive/contracts';
import { Button, cn, Skeleton } from '@cellhive/ui';
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { ChevronRight, Plus, Webhook } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams } from 'react-router';

import { useDocumentTitle } from '../../../../lib/a11y/use-document-title';
import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../../lib/i18n/format';
import { PAGE_GUTTER, PageHeading } from '../../../../lib/layout/page-heading';
import { baseQuery } from '../../../../lib/query/queries';
import { showToast } from '../../../../lib/toast/toast';
import { incomingWebhooksQuery, useHookCache } from '../cache';

import { CreateWebhookDialog } from './CreateWebhookDialog';
import { DeleteWebhookDialog } from './DeleteWebhookDialog';
import { AuthBadge, StatusBadge } from './parts';
import { SecretRevealDialog, type Reveal } from './SecretRevealDialog';
import { DRAWER_TABS, WebhookDrawer, type DrawerTab } from './WebhookDrawer';

import type { IncomingWebhookDto } from '@cellhive/contracts';

/**
 * `/b/:baseId/settings/webhooks` (BACKLOG T611, CONTRACTS §25.1; no S5c
 * board — built from the org settings pages, F§15): the incoming webhooks of
 * a base — name, status, checks, the automations they trigger and the last
 * request; "New webhook"; one hook opens in a drawer (`?hook=`, F§2).
 * Secrets issued by create / rotate / new Bearer token are shown once in
 * {@link SecretRevealDialog}. Base admins only: the route guard
 * `baseSettings` gives everyone else the 404 screen (the API answers `403`).
 */
export function IncomingWebhooksPage() {
  const { t } = useTranslation('incomingWebhooks');
  const format = useFormatters();
  const { baseId = '' } = useParams();
  const { data: base } = useSuspenseQuery(baseQuery(baseId));
  const list = useQuery({ ...incomingWebhooksQuery(baseId), refetchOnWindowFocus: true });
  const items = list.data?.items ?? [];
  const { put, refresh } = useHookCache(baseId);
  const [params, setParams] = useSearchParams();
  const openId = params.get('hook');
  const tabParam = params.get('tab');
  const tab: DrawerTab = DRAWER_TABS.includes(tabParam as DrawerTab)
    ? (tabParam as DrawerTab)
    : 'settings';
  const open = openId === null ? null : (items.find((hook) => hook.id === openId) ?? null);
  const [creating, setCreating] = useState(false);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [deleting, setDeleting] = useState<IncomingWebhookDto | null>(null);
  useDocumentTitle(`${t('page.title')} · ${base.name}`);

  const openHook = (hookId: string | null, nextTab: DrawerTab = 'settings') => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (hookId === null) {
          next.delete('hook');
          next.delete('tab');
        } else {
          next.set('hook', hookId);
          if (nextTab === 'settings') next.delete('tab');
          else next.set('tab', nextTab);
        }
        return next;
      },
      { replace: hookId !== null && openId === hookId },
    );
  };
  const atLimit = items.length >= INCOMING_WEBHOOKS_MAX_PER_BASE;
  const add = () => {
    setCreating(true);
  };

  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <PageHeading
        back={{
          to: `/b/${encodeURIComponent(base.id)}`,
          label: t('page.back', { name: base.name }),
        }}
        icon={Webhook}
        title={t('page.title')}
        subtitle={t('page.subtitle')}
        actions={
          <Button data-testid="hook-add" disabled={atLimit} onClick={add}>
            <Plus aria-hidden="true" />
            {t('page.add')}
          </Button>
        }
      />
      <div className={cn('flex flex-col gap-4 py-6', PAGE_GUTTER)}>
        <h2 className="sr-only">{t('page.listHeading')}</h2>
        {atLimit ? (
          <p className="text-label font-normal text-fg-muted">
            {t('page.limit', { max: INCOMING_WEBHOOKS_MAX_PER_BASE })}
          </p>
        ) : null}
        {list.isPending ? (
          <div
            role="status"
            aria-busy="true"
            aria-label={t('page.loading')}
            className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4"
          >
            {[0, 1].map((row) => (
              <Skeleton key={row} className="h-14" />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : items.length === 0 ? (
          <section
            data-testid="hooks-empty"
            className="flex flex-col items-start gap-2.5 rounded-lg border border-line bg-surface p-6"
          >
            <span className="flex size-10 items-center justify-center rounded-lg bg-accent-soft text-accent">
              <Webhook aria-hidden="true" className="size-5" />
            </span>
            <h3 className="text-heading">{t('page.emptyTitle')}</h3>
            <p className="max-w-prose text-body text-fg-muted">{t('page.empty')}</p>
            <Button variant="secondary" onClick={add}>
              <Plus aria-hidden="true" />
              {t('page.add')}
            </Button>
          </section>
        ) : (
          <ul
            aria-label={t('page.title')}
            className="flex flex-col rounded-lg border border-line bg-surface"
            data-testid="hook-list"
          >
            {items.map((hook) => {
              // T616: from the list itself (no request per hook any more).
              const last = hook.last_received_at;
              return (
                <li
                  key={hook.id}
                  data-testid="hook-row"
                  className="flex items-center gap-3 border-t border-line px-4 py-3 first:border-t-0"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="truncate font-medium text-fg">{hook.name}</span>
                      <StatusBadge enabled={hook.enabled} />
                      <AuthBadge auth={hook.auth} />
                    </span>
                    <span className="text-label font-normal text-fg-muted">
                      {hook.usages.length === 0
                        ? t('list.noUsages')
                        : t('list.usages', {
                            count: hook.usages.length,
                            names: hook.usages
                              .map((usage) => usage.name ?? t('usages.hidden'))
                              .join(', '),
                          })}
                    </span>
                    <span className="text-label font-normal text-fg-muted" data-testid="hook-last">
                      {last === null ? (
                        t('list.never')
                      ) : (
                        <>
                          {t('list.lastPrefix')}{' '}
                          <time dateTime={last} title={format.dateTime(last)}>
                            {format.relative(last)}
                          </time>
                        </>
                      )}
                    </span>
                  </div>
                  <Button
                    variant="secondary"
                    aria-label={t('list.manage', { name: hook.name })}
                    data-testid="hook-open"
                    onClick={() => {
                      openHook(hook.id);
                    }}
                  >
                    <span className="max-sm:sr-only">{t('list.manageShort')}</span>
                    <ChevronRight aria-hidden="true" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-label font-normal text-fg-muted">{t('page.whoSees')}</p>
      </div>

      <CreateWebhookDialog
        baseId={baseId}
        open={creating}
        onClose={() => {
          setCreating(false);
        }}
        onCreated={(hook) => {
          setCreating(false);
          put(hook);
          setReveal({ reason: 'created', hook });
        }}
      />
      <WebhookDrawer
        baseId={baseId}
        hook={open}
        tab={tab}
        onTab={(next) => {
          if (open !== null) openHook(open.id, next);
        }}
        onClose={() => {
          openHook(null);
        }}
        onRevealed={(reason, hook) => {
          setReveal({ reason, hook });
        }}
        onDelete={() => {
          setDeleting(open);
        }}
      />
      <DeleteWebhookDialog
        key={deleting?.id ?? 'none'}
        baseId={baseId}
        hook={deleting}
        onClose={() => {
          setDeleting(null);
        }}
        onDeleted={(hook) => {
          setDeleting(null);
          openHook(null);
          refresh();
          showToast({ variant: 'success', message: t('toast.deleted', { name: hook.name }) });
        }}
      />
      <SecretRevealDialog
        reveal={reveal}
        onDone={() => {
          setReveal(null);
        }}
      />
    </div>
  );
}

export default IncomingWebhooksPage;
