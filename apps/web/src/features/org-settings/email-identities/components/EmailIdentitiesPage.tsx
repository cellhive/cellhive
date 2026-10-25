import { Button, cn, Skeleton } from '@cellhive/ui';
import { useMutation, useQueries, useQuery } from '@tanstack/react-query';
import { AtSign, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { useDocumentTitle } from '../../../../lib/a11y/use-document-title';
import { isApiError } from '../../../../lib/api/client';
import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { PAGE_GUTTER, PageHeading } from '../../../../lib/layout/page-heading';
import { notFound } from '../../../../lib/navigation/not-found';
import { orgBasesQuery, orgQuery } from '../../../../lib/query/queries';
import { meQuery } from '../../../../lib/session/session';
import { showErrorToast, showToast } from '../../../../lib/toast/toast';
import {
  emailIdentitiesApi,
  emailIdentitiesQuery,
  emailIdentityUsagesQuery,
  emailSettingsQuery,
} from '../api';
import { useIdentityCache, useIsNarrow } from '../hooks';

import { ConfirmIdentityDialog } from './ConfirmDialogs';
import { IdentityDrawer, type DrawerState } from './IdentityDrawer';
import { IdentityCards, IdentityTable } from './IdentityList';
import { Note } from './parts';

import type { EmailIdentityDto, EmailSettingsDto } from '@cellhive/contracts';

type Confirm = { readonly kind: 'disable' | 'delete'; readonly identity: EmailIdentityDto } | null;

function DomainsNote({ settings }: { readonly settings: EmailSettingsDto | undefined }) {
  const { t } = useTranslation('emailIdentities');
  if (settings === undefined) return null;
  if (!settings.smtp.configured) {
    return (
      <Note tone="warning" title={t('page.noSmtpTitle')} data-testid="no-smtp-note">
        {t('page.noSmtp')}
      </Note>
    );
  }
  return (
    <Note tone="info" data-testid="domains-note">
      <span>
        {t('page.domains', {
          domains: settings.smtp.allowed_from_domains.join(', '),
        })}
      </span>
      <span>{t('page.ownServer')}</span>
    </Note>
  );
}

function Loading() {
  const { t } = useTranslation('emailIdentities');
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t('page.loading')}
      className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4"
    >
      {[0, 1, 2].map((row) => (
        <Skeleton key={row} className="h-12" />
      ))}
    </div>
  );
}

/**
 * `/o/:orgSlug/settings/email/identities` (T533, ADR-33, CONTRACTS §23.3;
 * boards "S5 · Email identities & signatures", "… - thêm danh tính", "… -
 * xác minh"): the addresses automation emails may be sent as — how they
 * send, status, base scope, automations using them; add/edit in a drawer,
 * verification by code or link, turn off, delete. Organization
 * owners/admins only (guard `orgSettings`; others get the 404 screen).
 */
export function EmailIdentitiesPage() {
  const { t } = useTranslation('emailIdentities');
  const { orgSlug } = useParams();
  const me = useQuery(meQuery());
  const org = me.data?.orgs.find((item) => item.slug === orgSlug);
  const orgId = org?.id ?? '';
  const enabled = org !== undefined;
  const list = useQuery({ ...emailIdentitiesQuery(orgId), enabled });
  const settings = useQuery({ ...emailSettingsQuery(orgId), enabled });
  const orgDetail = useQuery({ ...orgQuery(orgId), enabled });
  const bases = useQuery({ ...orgBasesQuery(orgId), enabled });
  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const usages = useQueries({
    queries: items.map((identity) => emailIdentityUsagesQuery(orgId, identity.id)),
  });
  const usageCounts = useMemo(() => {
    const counts = new Map<string, number>();
    items.forEach((identity, index) => {
      const total = usages[index]?.data?.total;
      if (total !== undefined) counts.set(identity.id, total);
    });
    return counts;
  }, [items, usages]);
  const baseNames = useMemo(
    () => new Map((bases.data ?? []).map((base) => [base.id, base.name] as const)),
    [bases.data],
  );
  const narrow = useIsNarrow();
  const cache = useIdentityCache(orgId);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  useDocumentTitle(org === undefined ? undefined : `${t('page.title')} · ${org.name}`);

  const toggle = useMutation({
    mutationFn: ({ identity, enabled: on }: { identity: EmailIdentityDto; enabled: boolean }) =>
      emailIdentitiesApi.setEnabled(identity.id, on),
    onSuccess: (identity) => {
      cache.put(identity);
      setConfirm(null);
      showToast({
        variant: 'success',
        message: t(identity.status === 'disabled' ? 'toast.disabled' : 'toast.enabled', {
          name: identity.display_name,
        }),
      });
    },
    onError: (error) => {
      if (confirm === null) showErrorToast(error);
      if (isApiError(error) && error.status === 404) cache.refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (identity: EmailIdentityDto) => emailIdentitiesApi.remove(identity.id),
    onSuccess: (_result, identity) => {
      cache.drop(identity.id);
      setConfirm(null);
      showToast({
        variant: 'success',
        message: t('toast.deleted', { name: identity.display_name }),
      });
    },
    onError: (error) => {
      if (isApiError(error) && error.status === 404) cache.refresh();
    },
  });

  if (me.data !== undefined && org === undefined) notFound();
  if (org === undefined) return null;

  const busyId = toggle.isPending ? toggle.variables.identity.id : null;
  const actions = {
    onEdit: (identity: EmailIdentityDto) => {
      setDrawer({ view: 'form', identityId: identity.id });
    },
    onFixName: (identity: EmailIdentityDto) => {
      setDrawer({ view: 'form', identityId: identity.id, focus: 'displayName' });
    },
    onVerify: (identity: EmailIdentityDto) => {
      setDrawer({ view: 'verify', identityId: identity.id, outcome: null });
    },
    onToggle: (identity: EmailIdentityDto) => {
      if (identity.status === 'disabled') {
        toggle.mutate({ identity, enabled: true });
      } else {
        toggle.reset();
        setConfirm({ kind: 'disable', identity });
      }
    },
    onDelete: (identity: EmailIdentityDto) => {
      remove.reset();
      setConfirm({ kind: 'delete', identity });
    },
  };
  const listProps = { items, baseNames, usageCounts, busyId, ...actions };

  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <PageHeading
        back={{
          to: `/o/${encodeURIComponent(org.slug)}`,
          label: t('page.back', { name: org.name }),
        }}
        icon={AtSign}
        title={t('page.title')}
        subtitle={t('page.subtitle', { org: org.name })}
        actions={
          <Button
            data-testid="identity-add"
            onClick={() => {
              setDrawer({ view: 'form', identityId: null });
            }}
          >
            <Plus aria-hidden="true" />
            {t('page.add')}
          </Button>
        }
      />
      <div className={cn('flex flex-col gap-4 py-6', PAGE_GUTTER)}>
        <DomainsNote settings={settings.data} />
        {list.isPending ? (
          <Loading />
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : items.length === 0 ? (
          <section
            data-testid="identities-empty"
            className="flex flex-col items-start gap-2.5 rounded-lg border border-line bg-surface p-6"
          >
            <span className="flex size-10 items-center justify-center rounded-lg bg-accent-soft text-accent">
              <AtSign aria-hidden="true" className="size-5" />
            </span>
            <h2 className="text-heading">{t('page.emptyTitle')}</h2>
            <p className="text-body text-fg-muted">{t('page.empty')}</p>
            <Button
              variant="secondary"
              onClick={() => {
                setDrawer({ view: 'form', identityId: null });
              }}
            >
              <Plus aria-hidden="true" />
              {t('page.add')}
            </Button>
          </section>
        ) : narrow ? (
          <IdentityCards {...listProps} />
        ) : (
          <IdentityTable {...listProps} />
        )}
        <p className="text-label font-normal text-fg-muted">{t('page.whoSees')}</p>
      </div>
      <IdentityDrawer
        orgId={org.id}
        state={drawer}
        identities={items}
        settings={settings.data}
        orgLocale={orgDetail.data?.settings.locale ?? null}
        bases={bases.data}
        onState={setDrawer}
      />
      <ConfirmIdentityDialog
        kind={confirm?.kind ?? 'disable'}
        identity={confirm?.identity ?? null}
        baseNames={baseNames}
        pending={toggle.isPending || remove.isPending}
        error={confirm?.kind === 'delete' ? remove.error : toggle.error}
        onClose={() => {
          setConfirm(null);
        }}
        onConfirm={() => {
          if (confirm === null) return;
          if (confirm.kind === 'delete') remove.mutate(confirm.identity);
          else toggle.mutate({ identity: confirm.identity, enabled: false });
        }}
      />
    </div>
  );
}

export default EmailIdentitiesPage;
