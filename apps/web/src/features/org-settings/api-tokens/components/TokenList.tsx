import { Button, cn } from '@cellhive/ui';
import { Ban, CircleAlert, CircleCheck, Pencil, Plug, Trash2, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useFormatters } from '../../../../lib/i18n/format';
import { canUseMcp, maskedToken, scopeKey, tokenStatus, tokenWarning } from '../model';

import type { ApiTokenDto, OrgApiTokenDto } from '@cellhive/contracts';

type Token = ApiTokenDto | OrgApiTokenDto;

const STATUS_STYLE = {
  active: { icon: CircleCheck, className: 'bg-option-2 text-on-option-2' },
  revoked: { icon: Ban, className: 'bg-option-0 text-on-option-0' },
  expired: { icon: CircleAlert, className: 'bg-danger/10 text-danger' },
} as const;

/**
 * The rows of a token list (BACKLOG T714): name, `cht_xxxxxxxx…`, scopes,
 * bases, expiry (a warning under 7 days or once expired), last use, status,
 * and the actions — "Connect via MCP" only with `onConnect` (MCP on) and on
 * active tokens that can open the endpoint. Rows wrap into cards on narrow screens.
 */
export function TokenList({
  tokens,
  baseNames,
  now,
  onRename,
  onRevoke,
  onConnect,
}: {
  readonly tokens: readonly Token[];
  readonly baseNames: ReadonlyMap<string, string>;
  readonly now: Date;
  readonly onRename?: (token: Token) => void;
  readonly onConnect?: ((token: Token) => void) | undefined;
  readonly onRevoke: (token: Token) => void;
}) {
  const { t } = useTranslation('apiTokens');
  const format = useFormatters();
  return (
    <ul
      aria-label={t('list.label')}
      className="flex flex-col rounded-md border border-line"
      data-testid="token-list"
    >
      {tokens.map((token) => {
        const status = tokenStatus(token, now);
        const StatusIcon = STATUS_STYLE[status].icon;
        const warning = tokenWarning(token, now);
        const bases =
          token.base_ids === null
            ? t('list.allBases')
            : token.base_ids.map((id) => baseNames.get(id) ?? t('list.unknownBase')).join(', ');
        const expiry =
          token.expires_at === null
            ? t('list.noExpiry')
            : t(status === 'expired' ? 'list.expired' : 'list.expires', {
                date: format.dateTime(token.expires_at),
              });
        return (
          <li
            key={token.id}
            data-testid="token-row"
            data-token-id={token.id}
            className="flex flex-wrap items-start gap-x-4 gap-y-2 border-t border-line px-3 py-3 first:border-t-0"
          >
            <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="min-w-0 font-medium break-words text-fg" data-testid="token-name">
                  {token.name}
                </span>
                <span
                  className={cn(
                    'inline-flex w-fit items-center gap-1 rounded-sm px-1.5 py-0.5 text-label font-medium whitespace-nowrap',
                    STATUS_STYLE[status].className,
                  )}
                  data-testid="token-status"
                >
                  <StatusIcon aria-hidden="true" className="size-3.5 shrink-0" />
                  {t(`list.status.${status}`)}
                </span>
              </span>
              <code className="w-fit font-mono text-mono text-fg-muted" data-testid="token-prefix">
                {maskedToken(token.token_prefix)}
              </code>
              {'user' in token ? (
                <span className="text-label font-normal text-fg-muted" data-testid="token-owner">
                  {t('list.owner', { name: token.user.display_name })}
                </span>
              ) : null}
              <span className="flex flex-wrap gap-1" aria-label={t('list.scopes')} role="list">
                {token.scopes.map((scope) => (
                  <span
                    key={scope}
                    role="listitem"
                    className="rounded-sm bg-surface-sunken px-1.5 py-0.5 text-label font-medium text-fg"
                  >
                    {t(scopeKey(scope))}
                  </span>
                ))}
              </span>
              <span className="text-label font-normal text-fg-muted">
                {t('list.bases')}: {bases}
              </span>
              <span className="text-label font-normal text-fg-muted">
                {status === 'revoked' && token.revoked_at !== null
                  ? t('list.revokedOn', { date: format.dateTime(token.revoked_at) })
                  : expiry}
                {' · '}
                <span data-testid="token-last-used">
                  {t('list.lastUsed', {
                    value:
                      token.last_used_at === null
                        ? t('list.never')
                        : format.relative(token.last_used_at, now),
                  })}
                </span>
              </span>
              {warning === null ? null : (
                <span
                  className="inline-flex items-center gap-1 text-label font-medium text-fg"
                  data-testid="token-warning"
                >
                  <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-warning" />
                  {t(`list.warning.${warning}`)}
                </span>
              )}
            </div>
            {status === 'revoked' ? null : (
              <div className="flex shrink-0 flex-wrap gap-1">
                {onConnect !== undefined && canUseMcp(token, now) ? (
                  <Button
                    variant="secondary"
                    aria-label={t('mcp.connect.actionLabel', { name: token.name })}
                    data-testid="token-connect-mcp"
                    onClick={() => {
                      onConnect(token);
                    }}
                  >
                    <Plug aria-hidden="true" />
                    <span className="max-sm:sr-only">{t('mcp.connect.action')}</span>
                  </Button>
                ) : null}
                {onRename === undefined ? null : (
                  <Button
                    variant="secondary"
                    aria-label={t('list.renameLabel', { name: token.name })}
                    data-testid="token-rename"
                    onClick={() => {
                      onRename(token);
                    }}
                  >
                    <Pencil aria-hidden="true" />
                    <span className="max-sm:sr-only">{t('list.rename')}</span>
                  </Button>
                )}
                <Button
                  variant="secondary"
                  aria-label={t('list.revokeLabel', { name: token.name })}
                  data-testid="token-revoke"
                  onClick={() => {
                    onRevoke(token);
                  }}
                >
                  <Trash2 aria-hidden="true" />
                  <span className="max-sm:sr-only">{t('list.revoke')}</span>
                </Button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
