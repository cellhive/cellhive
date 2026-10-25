import { Button, cn, Skeleton } from '@cellhive/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  Clock,
  Network,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { secretsApi } from '../../../../lib/api/secrets';
import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../../lib/i18n/format';
import { keys } from '../../../../lib/query/keys';
import { orgBasesQuery } from '../../../../lib/query/queries';
import { showToast } from '../../../../lib/toast/toast';
import { isHttpSecret, legacyHostsState, legacySummary, rotatingUntil } from '../model';

import { Note } from './parts';
import {
  DeleteSecretDialog,
  RotateSecretDialog,
  SecretFormDialog,
  SecretRevealDialog,
  type RevealedSecret,
} from './SecretDialogs';

import type { SecretDto, SecretWithValueDto } from '@cellhive/contracts';

/** A response with the generated value, as the reveal dialog takes it. */
function revealed(
  secret: SecretWithValueDto,
  reason: RevealedSecret['reason'],
): RevealedSecret | null {
  return secret.value === undefined ? null : { secret: { ...secret, value: secret.value }, reason };
}

/**
 * "HTTP secrets" (BACKLOG T613, CONTRACTS §24): header values (`http_header`)
 * and signing secrets (`webhook_signing`) of the organization for the
 * `http_request` / `run_n8n_workflow` steps — the same list as the Telegram
 * bots (T516: name, bases, who added it; change, delete with usages), plus
 * the kind, a generated signing secret shown once, and "New value" with a
 * 24-hour overlap.
 */
export function HttpSecretsSection({ orgId }: { readonly orgId: string }) {
  const { t } = useTranslation('orgIntegrations');
  const format = useFormatters();
  const queryClient = useQueryClient();
  const id = useId();
  const enabled = orgId !== '';
  const list = useQuery({
    queryKey: keys.orgSecrets(orgId),
    queryFn: ({ signal }) => secretsApi.list(orgId, signal),
    enabled,
  });
  const bases = useQuery({ ...orgBasesQuery(orgId), enabled });
  const baseNames = useMemo(
    () => new Map((bases.data ?? []).map((base) => [base.id, base.name] as const)),
    [bases.data],
  );
  const [editing, setEditing] = useState<'new' | SecretDto | null>(null);
  const [rotating, setRotating] = useState<SecretDto | null>(null);
  const [deleting, setDeleting] = useState<SecretDto | null>(null);
  const [reveal, setReveal] = useState<RevealedSecret | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.orgSecrets(orgId) });
  };
  // The organization's secrets include its Telegram bots (T516): this list shows the HTTP ones.
  const items = (list.data?.items ?? []).filter(isHttpSecret);
  const now = new Date();
  const scopeText = (secret: SecretDto) =>
    secret.base_scope === 'all'
      ? t('secrets.scope.all')
      : secret.base_ids
          .map((base) => baseNames.get(base) ?? t('secrets.scope.unknownBase'))
          .join(', ') || t('secrets.scope.none');
  const add = () => {
    setEditing('new');
  };

  return (
    <section
      id="http-secrets"
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4 sm:p-5"
      data-testid="http-secrets-section"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
          <h2 id={`${id}-title`} className="text-heading">
            {t('secrets.title')}
          </h2>
          <p className="max-w-[70ch] text-body text-fg-muted">{t('secrets.intro')}</p>
        </div>
        <Button data-testid="secret-add" onClick={add}>
          <Plus aria-hidden="true" />
          {t('secrets.add')}
        </Button>
      </div>
      {list.isPending ? (
        <div role="status" aria-busy="true" aria-label={t('page.loading')}>
          <Skeleton className="h-12" />
        </div>
      ) : list.isError ? (
        <ErrorAlert error={list.error} />
      ) : items.length === 0 ? (
        <p className="text-body text-fg-muted" data-testid="http-secrets-empty">
          {t('secrets.empty')}
        </p>
      ) : (
        <ul
          aria-label={t('secrets.title')}
          className="flex flex-col rounded-md border border-line"
          data-testid="http-secret-list"
        >
          {items.map((secret) => {
            const until = rotatingUntil(secret, now);
            return (
              <li
                key={secret.id}
                data-testid="http-secret-row"
                className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-3 py-2.5 first:border-t-0"
              >
                <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate font-medium text-fg">{secret.name}</span>
                    <span className="inline-flex w-fit items-center gap-1 rounded-sm bg-surface-sunken px-1.5 py-0.5 text-label font-medium whitespace-nowrap text-fg">
                      <KeyRound aria-hidden="true" className="size-3.5 shrink-0" />
                      {t(`secrets.kind.${secret.kind}`)}
                    </span>
                  </span>
                  <span className="text-label font-normal text-fg-muted">
                    {t('secrets.scopeLine', { scope: scopeText(secret) })}
                  </span>
                  <span className="text-label font-normal text-fg-muted">
                    {t('secrets.addedBy', {
                      name: secret.created_by?.name ?? t('page.unknownUser'),
                      date: format.dateTime(secret.created_at),
                    })}
                  </span>
                  {secret.allowed_hosts.length === 0 ? null : (
                    <span
                      className="text-label font-normal break-words text-fg-muted"
                      data-testid="http-secret-hosts"
                    >
                      {t('secrets.hostsLine', { hosts: secret.allowed_hosts.join(', ') })}
                    </span>
                  )}
                  {until === null ? null : (
                    <span
                      className="text-label font-normal text-fg"
                      data-testid="http-secret-rotating"
                    >
                      {t('secrets.rotatingUntil', { date: format.dateTime(until) })}
                    </span>
                  )}
                  <LegacyHosts secret={secret} now={now} />
                </div>
                <div className="flex shrink-0 flex-wrap gap-1">
                  {legacyHostsState(secret, now) === null ? null : (
                    <Button
                      variant="secondary"
                      aria-label={t('secrets.legacy.setHostsLabel', { name: secret.name })}
                      data-testid="http-secret-set-hosts"
                      onClick={() => {
                        setEditing(secret);
                      }}
                    >
                      <Network aria-hidden="true" />
                      <span className="max-sm:sr-only">{t('secrets.legacy.setHosts')}</span>
                    </Button>
                  )}
                  {secret.kind === 'webhook_signing' ? (
                    <Button
                      variant="secondary"
                      aria-label={t('secrets.rotateLabel', { name: secret.name })}
                      data-testid="http-secret-rotate"
                      onClick={() => {
                        setRotating(secret);
                      }}
                    >
                      <RefreshCw aria-hidden="true" />
                      <span className="max-sm:sr-only">{t('secrets.rotateShort')}</span>
                    </Button>
                  ) : null}
                  <Button
                    variant="secondary"
                    aria-label={t('secrets.edit', { name: secret.name })}
                    data-testid="http-secret-edit"
                    onClick={() => {
                      setEditing(secret);
                    }}
                  >
                    <Pencil aria-hidden="true" />
                    <span className="max-sm:sr-only">{t('secrets.editShort')}</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="max-lg:size-control"
                    aria-label={t('secrets.deleteLabel', { name: secret.name })}
                    data-testid="http-secret-delete"
                    onClick={() => {
                      setDeleting(secret);
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <SecretFormDialog
        orgId={orgId}
        state={editing}
        bases={bases.data}
        onClose={() => {
          setEditing(null);
        }}
        onSaved={(secret, created) => {
          setEditing(null);
          refresh();
          const shown = revealed(secret, created ? 'created' : 'rotated');
          if (shown !== null) setReveal(shown);
          else {
            showToast({
              variant: 'success',
              message: t(created ? 'secrets.toast.added' : 'secrets.toast.saved', {
                name: secret.name,
              }),
            });
          }
        }}
      />
      <RotateSecretDialog
        secret={rotating}
        onClose={() => {
          setRotating(null);
        }}
        onRotated={(secret) => {
          setRotating(null);
          refresh();
          setReveal(revealed(secret, 'rotated'));
        }}
      />
      <DeleteSecretDialog
        orgId={orgId}
        secret={deleting}
        onClose={() => {
          setDeleting(null);
        }}
        onDeleted={(secret) => {
          setDeleting(null);
          refresh();
          showToast({
            variant: 'success',
            message: t('secrets.toast.deleted', { name: secret.name }),
          });
        }}
      />
      <SecretRevealDialog
        reveal={reveal}
        onDone={() => {
          setReveal(null);
        }}
      />
    </section>
  );
}

/**
 * (T717) An HTTP secret stored before allowed hosts existed (CONTRACTS §24):
 * "Set hosts before <date>" while it is still sent to any host
 * (`legacy_hosts_until`), "Sending stopped" once that date passed.
 */
function LegacyHosts({ secret, now }: { readonly secret: SecretDto; readonly now: Date }) {
  const { t } = useTranslation('orgIntegrations');
  const format = useFormatters();
  const legacy = legacyHostsState(secret, now);
  if (legacy === null) return null;
  const stopped = legacy.state === 'stopped';
  return (
    <span className="flex flex-col gap-0.5" data-testid="http-secret-legacy">
      <span
        className={cn(
          'inline-flex w-fit items-center gap-1 rounded-sm px-1.5 py-0.5 text-label font-medium',
          stopped ? 'bg-danger/10 text-danger' : 'bg-option-3 text-fg',
        )}
        data-state={legacy.state}
      >
        {stopped ? (
          <Ban aria-hidden="true" className="size-3.5 shrink-0" />
        ) : (
          <Clock aria-hidden="true" className="size-3.5 shrink-0 text-warning" />
        )}
        {stopped
          ? t('secrets.legacy.stopped')
          : t('secrets.legacy.pending', { date: format.date(legacy.until ?? now) })}
      </span>
      <span className="text-label font-normal text-fg-muted">
        {stopped ? t('secrets.legacy.stoppedHint') : t('secrets.legacy.pendingHint')}
      </span>
    </span>
  );
}

/**
 * (T717) The banner at the top of the integrations page while at least one
 * HTTP secret has no allowed hosts (stored before the list existed): how
 * many, the first deadline, how many already stopped sending, and a link to
 * the list. Reads the same cached list as the section.
 */
export function LegacyHostsBanner({ orgId }: { readonly orgId: string }) {
  const { t } = useTranslation('orgIntegrations');
  const format = useFormatters();
  const list = useQuery({
    queryKey: keys.orgSecrets(orgId),
    queryFn: ({ signal }) => secretsApi.list(orgId, signal),
    enabled: orgId !== '',
  });
  const summary = legacySummary(list.data?.items ?? [], new Date());
  const count = summary.pending + summary.stopped;
  if (count === 0) return null;
  return (
    <Note
      tone="warning"
      icon={<TriangleAlert />}
      title={t('banner.title', { count })}
      data-testid="legacy-hosts-banner"
    >
      {summary.firstUntil === null ? null : (
        <p>{t('banner.pending', { date: format.date(summary.firstUntil) })}</p>
      )}
      {summary.stopped === 0 ? null : <p>{t('banner.stopped', { count: summary.stopped })}</p>}
      <a href="#http-secrets" className="font-medium text-accent underline">
        {t('banner.review')}
      </a>
    </Note>
  );
}
