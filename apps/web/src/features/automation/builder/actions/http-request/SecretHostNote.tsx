import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { secretsApi } from '../../../../../lib/api/secrets';
import { useFormatters } from '../../../../../lib/i18n/format';
import { keys } from '../../../../../lib/query/keys';
import { useBuilderEnv } from '../../components/env';
import { Note } from '../../components/panels/common';

import { literalUrlTarget, secretHostVerdict, type SecretHostVerdict } from './secret-hosts';

import type { HttpRequestValue } from '@cellhive/contracts';

/**
 * (T717) The allowed hosts of the chosen secret against the step URL, for
 * organization owners/admins — the only ones the API shows the hosts to
 * (`GET /orgs/:id/secrets`; the base list has names only). `null` for anyone
 * else, while loading, or with no secret chosen: the server's
 * `SECRET_HOST_NOT_ALLOWED` on save still lands on the secret field.
 */
export function useSecretHostVerdict(
  secretId: string | null,
  url: HttpRequestValue | undefined,
  /** The integrations page for owners/admins (`useIntegrationsPath`), else `null`. */
  integrations: string | null,
): SecretHostVerdict | null {
  const env = useBuilderEnv();
  const enabled = integrations !== null && secretId !== null && url !== undefined;
  const list = useQuery({
    queryKey: keys.orgSecrets(env.orgId),
    queryFn: ({ signal }) => secretsApi.list(env.orgId, signal),
    enabled,
    staleTime: 30_000,
  });
  if (!enabled) return null;
  const secret = list.data?.items.find((item) => item.id === secretId);
  return secret === undefined ? null : secretHostVerdict(secret, url, new Date());
}

/** `host` or `host:port` when the URL uses another port than 80/443. */
function targetLabel(url: HttpRequestValue | undefined, host: string): string {
  const target = literalUrlTarget(url);
  if (target === null || target.port === 80 || target.port === 443) return host;
  return `${host}:${String(target.port)}`;
}

/**
 * What the builder says under a secret of an HTTP step (BACKLOG T717,
 * ADR-36 §4): the hosts it is sent to; a warning before saving when the
 * literal URL is not one of them (the save would be refused); the deadline
 * of a secret stored before lists existed, or that it stopped sending.
 */
export function SecretHostNote({
  id,
  verdict,
  url,
  integrations,
  testId,
}: {
  readonly id: string;
  readonly verdict: SecretHostVerdict;
  readonly url: HttpRequestValue | undefined;
  readonly integrations: string | null;
  readonly testId: string;
}) {
  const { t } = useTranslation('automationHttp');
  const format = useFormatters();
  const link =
    integrations === null ? null : (
      <Link to={integrations} className="text-accent underline">
        {t('secret.openIntegrations')}
      </Link>
    );
  switch (verdict.kind) {
    case 'allowed':
    case 'unchecked':
      return (
        <p
          id={id}
          className="text-label font-normal break-words text-fg-muted"
          data-testid={testId}
          data-verdict={verdict.kind}
        >
          {t('secretHosts.sentTo', { hosts: verdict.hosts.join(', ') })}
          {verdict.kind === 'unchecked' ? ` ${t('secretHosts.unchecked')}` : null}
        </p>
      );
    case 'not_listed': {
      if (verdict.plainHttp) {
        return (
          <div id={id} data-testid={testId} data-verdict="plain_http">
            <Note tone="warning" title={t('secretHosts.plainHttpTitle')}>
              {t('secretHosts.plainHttp', {
                host: verdict.host,
                port: String(literalUrlTarget(url)?.port ?? 80),
              })}{' '}
              {link}
            </Note>
          </div>
        );
      }
      const host = targetLabel(url, verdict.host);
      return (
        <div id={id} data-testid={testId} data-verdict={verdict.kind}>
          <Note
            tone="warning"
            title={
              verdict.ip ? t('secretHosts.ipTitle') : t('secretHosts.notListedTitle', { host })
            }
          >
            {t('secretHosts.notListed', { hosts: verdict.hosts.join(', '), host })} {link}
          </Note>
        </div>
      );
    }
    case 'legacy':
      return (
        <div id={id} data-testid={testId} data-verdict={verdict.kind}>
          <Note tone="warning" title={t('secretHosts.legacyTitle')}>
            {t('secretHosts.legacy', { date: format.date(verdict.until) })} {link}
          </Note>
        </div>
      );
    case 'legacy_expired':
      return (
        <div id={id} data-testid={testId} data-verdict={verdict.kind}>
          <Note tone="danger" title={t('secretHosts.expiredTitle')}>
            {t('secretHosts.expired')} {link}
          </Note>
        </div>
      );
  }
}
