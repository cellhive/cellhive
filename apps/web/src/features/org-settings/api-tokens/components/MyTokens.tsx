import { Button, Skeleton } from '@cellhive/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Ban, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { orgBasesQuery } from '../../../../lib/query/queries';
import { myTokensQuery } from '../api';

import { CreateTokenDialog } from './CreateTokenDialog';
import {
  RenameTokenDialog,
  RevokeTokenDialog,
  TokenRevealDialog,
  type RevealedToken,
} from './dialogs';
import { McpConnectDialog } from './mcp';
import { Note, Section } from './parts';
import { TokenList } from './TokenList';

import type { ApiTokenDto, ApiTokenPolicy, McpPolicy } from '@cellhive/contracts';

/**
 * "Mine": the caller's tokens in the organization — create (shown once),
 * rename, revoke, and "Connect via MCP" while the organization allows MCP.
 */
export function MyTokens({
  orgId,
  policy,
  mcp,
}: {
  readonly orgId: string;
  readonly policy: ApiTokenPolicy;
  readonly mcp: McpPolicy;
}) {
  const { t } = useTranslation('apiTokens');
  const list = useInfiniteQuery(myTokensQuery(orgId));
  const bases = useQuery(orgBasesQuery(orgId));
  const baseNames = useMemo(
    () => new Map((bases.data ?? []).map((base) => [base.id, base.name] as const)),
    [bases.data],
  );
  const [creating, setCreating] = useState(false);
  // The created token's value: component state only, dropped when the dialog closes.
  const [reveal, setReveal] = useState<RevealedToken | null>(null);
  const [renaming, setRenaming] = useState<ApiTokenDto | null>(null);
  const [revoking, setRevoking] = useState<ApiTokenDto | null>(null);
  const [connecting, setConnecting] = useState<ApiTokenDto | null>(null);
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const now = new Date();

  return (
    <Section
      title={t('mine.title')}
      intro={t('mine.intro')}
      data-testid="my-tokens"
      action={
        <Button
          data-testid="token-create"
          disabled={!policy.enabled}
          onClick={() => {
            setCreating(true);
          }}
        >
          <Plus aria-hidden="true" />
          {t('mine.create')}
        </Button>
      }
    >
      {policy.enabled ? null : (
        <Note tone="warning" icon={<Ban />} data-testid="tokens-disabled">
          {t('mine.disabled')}
        </Note>
      )}
      {list.isPending ? (
        <div role="status" aria-busy="true" aria-label={t('page.loading')}>
          <Skeleton className="h-16" />
        </div>
      ) : list.isError ? (
        <ErrorAlert error={list.error} />
      ) : items.length === 0 ? (
        <p className="text-body text-fg-muted" data-testid="tokens-empty">
          {t('mine.empty')}
        </p>
      ) : (
        <TokenList
          tokens={items}
          baseNames={baseNames}
          now={now}
          onRename={(token) => {
            setRenaming(token);
          }}
          onRevoke={(token) => {
            setRevoking(token);
          }}
          onConnect={
            mcp.enabled
              ? (token) => {
                  setConnecting(token);
                }
              : undefined
          }
        />
      )}
      {list.hasNextPage ? (
        <Button
          variant="secondary"
          className="w-fit"
          disabled={list.isFetchingNextPage}
          onClick={() => {
            void list.fetchNextPage();
          }}
        >
          {t('page.loadMore')}
        </Button>
      ) : null}
      <CreateTokenDialog
        orgId={orgId}
        open={creating}
        maxLifetimeDays={policy.max_lifetime_days}
        mcp={mcp}
        onClose={() => {
          setCreating(false);
        }}
        onCreated={(created) => {
          setCreating(false);
          setReveal(created);
        }}
      />
      <TokenRevealDialog
        reveal={reveal}
        onDone={() => {
          setReveal(null);
        }}
      />
      <RenameTokenDialog
        orgId={orgId}
        token={renaming}
        onClose={() => {
          setRenaming(null);
        }}
      />
      <RevokeTokenDialog
        orgId={orgId}
        token={revoking}
        onClose={() => {
          setRevoking(null);
        }}
      />
      {mcp.enabled ? (
        <McpConnectDialog
          token={connecting}
          onClose={() => {
            setConnecting(null);
          }}
        />
      ) : null}
    </Section>
  );
}
