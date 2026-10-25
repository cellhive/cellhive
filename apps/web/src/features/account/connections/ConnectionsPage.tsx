import { Alert, Button, cn, Dialog, Skeleton, Spinner } from '@cellhive/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Unplug } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { useDocumentTitle } from '../../../lib/a11y/use-document-title';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../lib/i18n/format';
import { PAGE_GUTTER, PageHeading } from '../../../lib/layout/page-heading';
import { setupStatusQuery } from '../../../lib/session/session';

import { connectionsApi, meIdentitiesQuery } from './api';
import { isLastLoginMethod, linkErrorKey, providerNavigation } from './link-error';

import type { MeIdentity } from '@cellhive/contracts';

function DisconnectDialog({
  identity,
  onClose,
}: {
  readonly identity: MeIdentity | null;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation('account');
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: string) => connectionsApi.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: meIdentitiesQuery().queryKey }),
    onError: (error) => {
      // Already gone (another tab): show the list as it is now.
      if (!isLastLoginMethod(error)) {
        void queryClient.invalidateQueries({ queryKey: meIdentitiesQuery().queryKey });
      }
    },
  });
  const lastMethod = remove.isError && isLastLoginMethod(remove.error);
  const close = () => {
    remove.reset();
    onClose();
  };
  return (
    <Dialog
      open={identity !== null}
      role="alertdialog"
      layout="sheet"
      className="max-w-lg"
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={
        identity === null
          ? ''
          : t('connections.disconnect.title', { provider: identity.provider_name })
      }
      description={identity === null ? undefined : t('connections.disconnect.description')}
      closeLabel={t('connections.disconnect.close')}
    >
      {identity === null ? null : (
        <div className="flex flex-col gap-4">
          {lastMethod ? (
            <Alert variant="danger" data-testid="last-login-method">
              <p className="font-medium">{t('connections.lastLoginMethod.title')}</p>
              <p>{t('connections.lastLoginMethod.description')}</p>
            </Alert>
          ) : remove.isError ? (
            <ErrorAlert error={remove.error} />
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={close}>
              {lastMethod ? t('connections.disconnect.close') : t('connections.disconnect.cancel')}
            </Button>
            {lastMethod ? null : (
              <Button
                variant="danger"
                disabled={remove.isPending}
                onClick={() => {
                  remove.mutate(identity.id, { onSuccess: close });
                }}
              >
                {remove.isPending ? <Spinner /> : null}
                {t('connections.disconnect.confirm')}
              </Button>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

function IdentityRow({
  identity,
  onDisconnect,
}: {
  readonly identity: MeIdentity;
  readonly onDisconnect: (identity: MeIdentity) => void;
}) {
  const { t } = useTranslation('account');
  const format = useFormatters();
  return (
    <li
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-4 py-3 first:border-t-0"
      data-testid="identity-row"
    >
      <KeyRound aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium break-words">{identity.provider_name}</span>
        {identity.email === null ? null : (
          <span className="text-label font-normal break-all text-fg-muted">{identity.email}</span>
        )}
        <span className="text-label font-normal text-fg-muted">
          {t('connections.connectedOn', { date: format.dateTime(identity.created_at) })}
          {' · '}
          {identity.last_login_at === null
            ? t('connections.neverUsed')
            : t('connections.lastSignIn', { date: format.dateTime(identity.last_login_at) })}
        </span>
      </div>
      <Button
        variant="secondary"
        size="sm"
        className="max-lg:h-control"
        aria-label={t('connections.disconnect.button', { provider: identity.provider_name })}
        onClick={() => {
          onDisconnect(identity);
        }}
      >
        <Unplug aria-hidden="true" />
        {t('connections.disconnect.action')}
      </Button>
    </li>
  );
}

/**
 * `/account/connections` (T715, CONTRACTS §27.3): the caller's OIDC
 * identities, "Connect <provider>" (`POST …/start`, then the provider) and
 * "Disconnect" with a confirmation. `?error=<CODE>` from the link callback
 * shows its translated message, never the raw value.
 */
export function ConnectionsPage() {
  const { t } = useTranslation('account');
  useDocumentTitle(t('connections.title'));
  const [searchParams, setSearchParams] = useSearchParams();
  const linkError = linkErrorKey(searchParams.get('error'));
  const dismissLinkError = () => {
    setSearchParams(
      (params) => {
        params.delete('error');
        return params;
      },
      { replace: true },
    );
  };
  const identities = useQuery(meIdentitiesQuery());
  const setup = useQuery(setupStatusQuery());
  const providers = setup.data?.auth_config.providers ?? [];
  const [disconnecting, setDisconnecting] = useState<MeIdentity | null>(null);
  const linkedHeading = useId();
  const connectHeading = useId();
  const start = useMutation({
    mutationFn: connectionsApi.startLink,
    onSuccess: ({ authorization_url }) => {
      providerNavigation.open(authorization_url);
    },
  });
  // After a successful start the browser is on its way to the provider.
  const starting = start.isPending || start.isSuccess;
  const linked = new Set(identities.data?.items.map((item) => item.provider));
  const connectable = providers.filter((provider) => !linked.has(provider.slug));

  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <PageHeading
        icon={KeyRound}
        title={t('connections.title')}
        subtitle={t('connections.subtitle')}
      />
      <div className={cn('flex max-w-3xl flex-col gap-6 py-6', PAGE_GUTTER)}>
        {linkError === null ? null : (
          <Alert variant="danger" data-testid="link-error">
            <p>{t(linkError)}</p>
            <Button
              variant="link"
              className="w-fit max-lg:min-h-control"
              onClick={dismissLinkError}
            >
              {t('connections.dismiss')}
            </Button>
          </Alert>
        )}
        <section aria-labelledby={linkedHeading} className="flex flex-col gap-3">
          <h2 id={linkedHeading} className="text-heading">
            {t('connections.linkedHeading')}
          </h2>
          {identities.isPending ? (
            <div role="status" aria-busy="true" aria-label={t('connections.loading')}>
              <Skeleton className="h-16" />
            </div>
          ) : identities.isError ? (
            <ErrorAlert error={identities.error} />
          ) : identities.data.items.length === 0 ? (
            <p className="text-body text-fg-muted">{t('connections.empty')}</p>
          ) : (
            <ul className="flex flex-col rounded-lg border border-line bg-surface">
              {identities.data.items.map((identity) => (
                <IdentityRow
                  key={identity.id}
                  identity={identity}
                  onDisconnect={setDisconnecting}
                />
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby={connectHeading} className="flex flex-col gap-3">
          <h2 id={connectHeading} className="text-heading">
            {t('connections.connectHeading')}
          </h2>
          <p className="text-body text-fg-muted">{t('connections.connectHint')}</p>
          {start.isError ? <ErrorAlert error={start.error} /> : null}
          {providers.length === 0 ? (
            <p className="text-body text-fg-muted">{t('connections.noProviders')}</p>
          ) : connectable.length === 0 ? (
            <p className="text-body text-fg-muted">{t('connections.allConnected')}</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {connectable.map((provider) => (
                <li key={provider.slug}>
                  <Button
                    variant="secondary"
                    disabled={starting || identities.isPending}
                    onClick={() => {
                      start.mutate(provider.slug);
                    }}
                  >
                    {starting && start.variables === provider.slug ? <Spinner /> : null}
                    {t('connections.connect', { provider: provider.name })}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <DisconnectDialog
        identity={disconnecting}
        onClose={() => {
          setDisconnecting(null);
        }}
      />
    </div>
  );
}

export default ConnectionsPage;
