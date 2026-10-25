import { API_TOKEN_STATUSES, type ApiTokenStatus, type OrgApiTokenDto } from '@cellhive/contracts';
import { Button, FormField, Select, Skeleton } from '@cellhive/ui';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { orgBasesQuery, orgMembersQuery } from '../../../../lib/query/queries';
import { orgTokensQuery, type OrgTokenFilters } from '../api';

import { RevokeTokenDialog } from './dialogs';
import { Section } from './parts';
import { TokenList } from './TokenList';

/**
 * "All tokens" for organization owners/admins (CONTRACTS §26.4): every
 * member's tokens (metadata only), filtered by member and status, revoke.
 */
export function OrgTokens({ orgId }: { readonly orgId: string }) {
  const { t } = useTranslation('apiTokens');
  const [filters, setFilters] = useState<OrgTokenFilters>({});
  const list = useInfiniteQuery({
    ...orgTokensQuery(orgId, filters),
    placeholderData: keepPreviousData,
  });
  const members = useQuery(orgMembersQuery(orgId));
  const bases = useQuery(orgBasesQuery(orgId));
  const baseNames = useMemo(
    () => new Map((bases.data ?? []).map((base) => [base.id, base.name] as const)),
    [bases.data],
  );
  const [revoking, setRevoking] = useState<OrgApiTokenDto | null>(null);
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const now = new Date();

  return (
    <Section title={t('all.title')} intro={t('all.intro')} data-testid="org-tokens">
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label={t('all.member')}>
          {(control) => (
            <Select
              {...control}
              value={filters.user_id ?? ''}
              data-testid="org-tokens-member"
              onChange={(event) => {
                const value = event.target.value;
                setFilters((current) => ({
                  ...current,
                  user_id: value === '' ? undefined : value,
                }));
              }}
            >
              <option value="">{t('all.anyMember')}</option>
              {(members.data?.items ?? []).map((member) => (
                <option key={member.user.id} value={member.user.id}>
                  {member.user.display_name}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label={t('all.status')}>
          {(control) => (
            <Select
              {...control}
              value={filters.status ?? ''}
              data-testid="org-tokens-status"
              onChange={(event) => {
                const value = event.target.value;
                setFilters((current) => ({
                  ...current,
                  status: value === '' ? undefined : (value as ApiTokenStatus),
                }));
              }}
            >
              <option value="">{t('all.anyStatus')}</option>
              {API_TOKEN_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(`list.status.${status}`)}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      </div>
      {list.isPending ? (
        <div role="status" aria-busy="true" aria-label={t('page.loading')}>
          <Skeleton className="h-16" />
        </div>
      ) : list.isError ? (
        <ErrorAlert error={list.error} />
      ) : items.length === 0 ? (
        <p className="text-body text-fg-muted" data-testid="org-tokens-empty">
          {t('all.empty')}
        </p>
      ) : (
        <TokenList
          tokens={items}
          baseNames={baseNames}
          now={now}
          onRevoke={(token) => {
            setRevoking(token as OrgApiTokenDto);
          }}
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
      <RevokeTokenDialog
        orgId={orgId}
        token={revoking}
        onClose={() => {
          setRevoking(null);
        }}
      />
    </Section>
  );
}
