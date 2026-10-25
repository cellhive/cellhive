import { Button, cn, Input, Select, Skeleton, Spinner } from '@cellhive/ui';
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
  type InfiniteData,
} from '@tanstack/react-query';
import { Eye, Info, Search, User, Users } from 'lucide-react';
import { lazy, Suspense, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { useDocumentTitle } from '../../../../lib/a11y/use-document-title';
import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { PAGE_GUTTER, PageHeading } from '../../../../lib/layout/page-heading';
import { baseQuery, orgMembersQuery } from '../../../../lib/query/queries';
import { rolesQuery } from '../../../../lib/query/roles';
import { showToast } from '../../../../lib/toast/toast';
import { principalKeys, principalsQuery, useIsNarrow, useRoleMutations } from '../../hooks';
import { fullAccessOf, NO_ROLE, roleChangeOf, sortRoles, type FullAccessReason } from '../../model';
import { ConfirmDialog, Note } from '../../parts';
import { useRoleName } from '../../role-name';

import type { BasePrincipalDto, BasePrincipalList, RoleDto } from '@cellhive/contracts';

/** (T713) The member access panel: its own chunk, loaded when it is opened. */
const AccessPanel = lazy(() => import('../access-panel/AccessPanel'));

/** Typing pause before the search is sent. */
const SEARCH_DEBOUNCE_MS = 300;

function principalKey(principal: Pick<BasePrincipalDto, 'principal_type' | 'principal_id'>) {
  return `${principal.principal_type}:${principal.principal_id}`;
}

interface RowProps {
  readonly principal: BasePrincipalDto;
  readonly roles: readonly RoleDto[];
  readonly fullAccess: FullAccessReason | null;
  /** The role being saved for this row (`NO_ROLE` while removing), else `undefined`. */
  readonly pending: string | undefined;
  readonly onPick: (principal: BasePrincipalDto, value: string) => void;
  /** (T713) Opens the effective access of a person. */
  readonly onView: (principal: BasePrincipalDto) => void;
}

/**
 * `/b/:baseId/settings/members` (T712, FRONTEND §17): the organization's
 * active members and groups (`GET /bases/:id/principals`, T711) with their
 * role in the base as a select — "No access" removes the assignment after a
 * confirmation (`alertdialog`). A note explains how access is decided (a
 * direct role wins over group roles; several groups add up) and that
 * organization owners/admins, workspace admins and the base owner always
 * have full access (those rows show it instead of a select, T713: told by
 * the server). "View access" opens a person's effective access (T713,
 * read-only). Base admins only.
 */
export function MembersPage() {
  const { t } = useTranslation('baseSettings');
  const { baseId = '' } = useParams();
  const queryClient = useQueryClient();
  const { data: base } = useSuspenseQuery(baseQuery(baseId));
  const roles = useQuery(rolesQuery(baseId));
  const orgMembers = useQuery(orgMembersQuery(base.organization_id));
  const mutations = useRoleMutations(baseId);
  const roleName = useRoleName();
  const narrow = useIsNarrow();
  const searchId = useId();
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [pending, setPending] = useState<ReadonlyMap<string, string>>(new Map());
  const [removing, setRemoving] = useState<BasePrincipalDto | null>(null);
  const [viewing, setViewing] = useState<BasePrincipalDto | null>(null);
  useDocumentTitle(`${t('members.title')} · ${base.name}`);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQ(typed.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [typed]);

  // The rows of the previous search stay while the next one loads: a skeleton
  // would unmount the role select the keyboard is on (focus lost, WCAG 2.4.3).
  const list = useInfiniteQuery({
    ...principalsQuery(baseId, q),
    placeholderData: keepPreviousData,
  });
  const searching = list.isPlaceholderData;
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const sortedRoles = sortRoles(roles.data?.items ?? []);

  const mark = (principal: BasePrincipalDto, value: string | undefined) => {
    setPending((current) => {
      const next = new Map(current);
      if (value === undefined) next.delete(principalKey(principal));
      else next.set(principalKey(principal), value);
      return next;
    });
  };
  /** The principal's row shows `roleId` at once; the refetch that follows confirms it. */
  const store = (principal: BasePrincipalDto, roleId: string | null) => {
    queryClient.setQueriesData<InfiniteData<BasePrincipalList>>(
      { queryKey: principalKeys.all(baseId) },
      (data) =>
        data === undefined
          ? data
          : {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                items: page.items.map((item) =>
                  principalKey(item) === principalKey(principal)
                    ? { ...item, role_id: roleId as BasePrincipalDto['role_id'] }
                    : item,
                ),
              })),
            },
    );
  };
  const target = (principal: BasePrincipalDto) => ({
    principal_type: principal.principal_type,
    principal_id: principal.principal_id,
  });

  const onPick = (principal: BasePrincipalDto, value: string) => {
    const change = roleChangeOf(principal.role_id, value);
    if (change.kind === 'none') return;
    if (change.kind === 'remove') {
      setRemoving(principal);
      return;
    }
    const role = sortedRoles.find((item) => item.id === change.roleId);
    mark(principal, change.roleId);
    mutations.assign.mutate(
      { ...target(principal), role_id: change.roleId as RoleDto['id'] },
      {
        onSuccess: () => {
          store(principal, change.roleId);
          showToast({
            variant: 'success',
            message: t('members.assigned', {
              name: principal.name,
              role: role === undefined ? '' : roleName(role),
            }),
          });
        },
        onError: (error) => {
          showToast({ variant: 'error', error });
        },
        onSettled: () => {
          mark(principal, undefined);
        },
      },
    );
  };

  const confirmRemove = () => {
    if (removing === null) return;
    const principal = removing;
    mark(principal, NO_ROLE);
    mutations.unassign.mutate(target(principal), {
      onSuccess: () => {
        store(principal, null);
        setRemoving(null);
        showToast({ variant: 'success', message: t('members.removed', { name: principal.name }) });
      },
      onSettled: () => {
        mark(principal, undefined);
      },
    });
  };

  const rows = items.map((principal) => ({
    principal,
    fullAccess: fullAccessOf(principal, { orgMembers: orgMembers.data?.items }),
    pending: pending.get(principalKey(principal)),
  }));

  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <PageHeading
        back={{
          to: `/b/${encodeURIComponent(base.id)}`,
          label: t('page.back', { name: base.name }),
        }}
        icon={Users}
        title={t('members.title')}
        subtitle={t('members.subtitle', { base: base.name })}
      />
      <div className={cn('flex flex-col gap-4 py-6', PAGE_GUTTER)}>
        <Note icon={<Info />} title={t('members.rules.title')} data-testid="members-rules">
          <ul className="list-disc pl-4">
            <li>{t('members.rules.direct')}</li>
            <li>{t('members.rules.groups')}</li>
            <li>{t('members.rules.full')}</li>
          </ul>
        </Note>
        <div className="flex max-w-md flex-col gap-1">
          <label htmlFor={searchId} className="text-label text-fg">
            {t('members.search.label')}
          </label>
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-muted"
            />
            <Input
              id={searchId}
              type="search"
              autoComplete="off"
              className="pl-8"
              placeholder={t('members.search.placeholder')}
              value={typed}
              data-testid="members-search"
              onChange={(event) => {
                setTyped(event.target.value);
              }}
            />
          </div>
        </div>
        {list.isPending || roles.isPending ? (
          <div className="flex flex-col gap-2" data-testid="members-loading">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : roles.isError ? (
          <ErrorAlert error={roles.error} />
        ) : items.length === 0 ? (
          <p
            className="rounded-lg border border-line bg-surface p-6 text-body text-fg-muted"
            data-testid="members-empty"
          >
            {q === '' ? t('members.empty') : t('members.noMatch', { q })}
          </p>
        ) : (
          <>
            {narrow ? (
              <PrincipalCards
                rows={rows}
                roles={sortedRoles}
                busy={searching}
                onPick={onPick}
                onView={setViewing}
              />
            ) : (
              <PrincipalTable
                rows={rows}
                roles={sortedRoles}
                busy={searching}
                onPick={onPick}
                onView={setViewing}
              />
            )}
            {list.hasNextPage ? (
              <Button
                variant="secondary"
                className="w-fit"
                disabled={list.isFetchingNextPage}
                data-testid="members-more"
                onClick={() => {
                  void list.fetchNextPage();
                }}
              >
                {list.isFetchingNextPage ? <Spinner /> : null}
                {t('members.more')}
              </Button>
            ) : null}
          </>
        )}
      </div>
      {viewing === null ? null : (
        <Suspense fallback={null}>
          <AccessPanel
            baseId={base.id}
            orgId={base.organization_id}
            userId={viewing.principal_id}
            name={viewing.name}
            onClose={() => {
              setViewing(null);
            }}
          />
        </Suspense>
      )}
      {removing === null ? null : (
        <ConfirmDialog
          data-testid="member-remove"
          title={t('members.remove.title', { name: removing.name })}
          description={t(
            removing.principal_type === 'group' ? 'members.remove.group' : 'members.remove.user',
            { name: removing.name, base: base.name },
          )}
          confirmLabel={t('members.remove.confirm')}
          pending={mutations.unassign.isPending}
          error={mutations.unassign.error}
          onCancel={() => {
            setRemoving(null);
            mutations.unassign.reset();
          }}
          onConfirm={confirmRemove}
        />
      )}
    </div>
  );
}

function PrincipalName({ principal }: { readonly principal: BasePrincipalDto }) {
  const { t } = useTranslation('baseSettings');
  const Icon = principal.principal_type === 'group' ? Users : User;
  return (
    <span className="flex min-w-0 items-start gap-2.5">
      <span
        aria-hidden="true"
        className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-fg-muted"
      >
        <Icon className="size-4" />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium break-words text-fg">{principal.name}</span>
        <span className="text-label font-normal break-all text-fg-muted">
          {principal.principal_type === 'group' ? t('members.type.group') : principal.email}
        </span>
      </span>
    </span>
  );
}

/** (T713) "View access" of a person (groups have no access of their own to show). */
function ViewAccess({ principal, onView }: Pick<RowProps, 'principal' | 'onView'>) {
  const { t } = useTranslation('baseSettings');
  if (principal.principal_type !== 'user') return null;
  return (
    <Button
      variant="ghost"
      size="toolbar"
      aria-label={t('members.viewAccessOf', { name: principal.name })}
      data-testid={`member-access-${principal.principal_id}`}
      onClick={() => {
        onView(principal);
      }}
    >
      <Eye aria-hidden="true" />
      <span aria-hidden="true">{t('members.viewAccess')}</span>
    </Button>
  );
}

function RoleControl({ principal, roles, fullAccess, pending, onPick }: Omit<RowProps, 'onView'>) {
  const { t } = useTranslation('baseSettings');
  const roleName = useRoleName();
  if (fullAccess !== null) {
    return (
      <span
        className="inline-flex w-fit items-center rounded-md bg-accent-soft px-2 py-1 text-label text-fg"
        data-testid={`full-access-${principal.principal_id}`}
      >
        {t(`members.fullAccess.${fullAccess}`)}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <Select
        aria-label={t('members.roleOf', { name: principal.name })}
        data-testid={`member-role-${principal.principal_id}`}
        className="min-w-44"
        // Not disabled while saving: the focus stays on the select (keyboard users).
        aria-busy={pending !== undefined || undefined}
        value={pending ?? principal.role_id ?? NO_ROLE}
        onChange={(event) => {
          if (pending === undefined) onPick(principal, event.target.value);
        }}
      >
        <option value={NO_ROLE}>{t('members.noAccess')}</option>
        {roles.map((role) => (
          <option key={role.id} value={role.id}>
            {roleName(role)}
          </option>
        ))}
      </Select>
      {pending === undefined ? null : (
        <>
          <Spinner />
          <span className="sr-only">{t('members.saving')}</span>
        </>
      )}
    </span>
  );
}

interface ListProps {
  readonly rows: readonly Omit<RowProps, 'roles' | 'onPick' | 'onView'>[];
  readonly roles: readonly RoleDto[];
  /** The rows of the previous search, shown while the next one loads. */
  readonly busy: boolean;
  readonly onPick: RowProps['onPick'];
  readonly onView: RowProps['onView'];
}

const TH = 'h-[34px] px-3 text-left text-label font-medium whitespace-nowrap text-fg-muted';
const TD = 'px-3 py-2.5 align-middle';

/** ≥ 768 px: one row per person or group. */
function PrincipalTable({ rows, roles, busy, onPick, onView }: ListProps) {
  const { t } = useTranslation('baseSettings');
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table
        className="w-full border-collapse text-body"
        aria-busy={busy || undefined}
        data-testid="member-table"
      >
        <caption className="sr-only">{t('members.caption')}</caption>
        <thead className="bg-surface-sunken">
          <tr>
            <th scope="col" className={TH}>
              {t('members.columns.name')}
            </th>
            <th scope="col" className={TH}>
              {t('members.columns.type')}
            </th>
            <th scope="col" className={TH}>
              {t('members.columns.role')}
            </th>
            <th scope="col" className={TH}>
              <span className="sr-only">{t('members.columns.access')}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row) => (
            <tr
              key={principalKey(row.principal)}
              data-testid="member-row"
              data-principal-id={row.principal.principal_id}
            >
              <th scope="row" className={cn(TD, 'text-left font-normal')}>
                <PrincipalName principal={row.principal} />
              </th>
              <td className={cn(TD, 'whitespace-nowrap text-fg-muted')}>
                {t(`members.type.${row.principal.principal_type}`)}
              </td>
              <td className={cn(TD, 'w-0 whitespace-nowrap')}>
                <RoleControl {...row} roles={roles} onPick={onPick} />
              </td>
              <td className={cn(TD, 'w-0 whitespace-nowrap')}>
                <ViewAccess principal={row.principal} onView={onView} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** < 768 px: one card per person or group (the table becomes cards, FRONTEND §9.4). */
function PrincipalCards({ rows, roles, busy, onPick, onView }: ListProps) {
  const { t } = useTranslation('baseSettings');
  return (
    <ul
      aria-label={t('members.caption')}
      aria-busy={busy || undefined}
      className="flex flex-col gap-3"
      data-testid="member-cards"
    >
      {rows.map((row) => (
        <li
          key={principalKey(row.principal)}
          data-testid="member-row"
          data-principal-id={row.principal.principal_id}
          className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
        >
          <PrincipalName principal={row.principal} />
          <RoleControl {...row} roles={roles} onPick={onPick} />
          <span className="-ml-2">
            <ViewAccess principal={row.principal} onView={onView} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export default MembersPage;
