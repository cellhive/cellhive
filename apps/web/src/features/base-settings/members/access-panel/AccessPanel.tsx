import { Dialog, Skeleton } from '@cellhive/ui';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { rolesApi } from '../../../../lib/api/roles';
import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { dashboardsQuery } from '../../../../lib/query/dashboards';
import { keys } from '../../../../lib/query/keys';
import { fieldsQuery, orgGroupsQuery, tablesQuery } from '../../../../lib/query/queries';
import { rolesQuery } from '../../../../lib/query/roles';
import { Note } from '../../parts';
import { useRoleName } from '../../role-name';

import type { MemberAccessDto, TableAccess } from '@cellhive/contracts';

const BASE_RULES = ['copy', 'download', 'share_link'] as const;

export interface AccessPanelProps {
  readonly baseId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly onClose: () => void;
}

/** `GET /bases/:id/members/:userId/access?counts=true`; under the base key, so `permission.changed` refetches it. */
const memberAccessQuery = (baseId: string, userId: string) => ({
  queryKey: [...keys.base(baseId), 'member-access', userId] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) => rolesApi.memberAccess(baseId, userId, signal),
});

function Source({ data, orgId, baseId }: { data: MemberAccessDto; orgId: string; baseId: string }) {
  const { t } = useTranslation('baseSettings');
  const roleName = useRoleName();
  const roles = useQuery(rolesQuery(baseId));
  const groups = useQuery({ ...orgGroupsQuery(orgId), enabled: data.source.group_ids.length > 0 });
  const roleNames = data.source.role_ids.map((id) => {
    const role = roles.data?.items.find((item) => item.id === id);
    return role === undefined ? id : roleName(role);
  });
  const groupNames = data.source.group_ids.map(
    (id) => groups.data?.items.find((group) => group.id === id)?.name ?? id,
  );
  return (
    <p className="text-body text-fg" data-testid="access-source">
      {t(`access.source.${data.source.kind}`, {
        roles: roleNames.join(', '),
        groups: groupNames.join(', '),
      })}
    </p>
  );
}

function TableEntry({
  name,
  access,
  counts,
  fields,
}: {
  readonly name: string;
  readonly access: TableAccess;
  readonly counts: NonNullable<MemberAccessDto['counts']>[`tbl_${string}`] | undefined;
  readonly fields: readonly { id: string; name: string }[] | undefined;
}) {
  const { t } = useTranslation('baseSettings');
  const hidden = (fields ?? []).filter((field) => !(field.id in access.fields));
  const readOnly = (fields ?? []).filter(
    (field) => (access.fields as Record<string, string | undefined>)[field.id] === 'read',
  );
  const operations = access.operations.map((operation) => t(`editor.records.ops.${operation}`));
  return (
    <li
      className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-3"
      data-testid="access-table"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium text-fg">{name}</span>
        <span className="text-label text-fg-muted">{t(`editor.tableLevels.${access.perm}`)}</span>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-label">
        <dt className="text-fg-muted">{t('access.operations')}</dt>
        <dd className="text-fg">
          {operations.length === 0 ? t('editor.records.ops.none') : operations.join(', ')}
        </dd>
        <dt className="text-fg-muted">{t('access.readScope')}</dt>
        <dd className="text-fg">{t(`access.scopes.${access.read_scope}`)}</dd>
        <dt className="text-fg-muted">{t('access.records')}</dt>
        <dd className="text-fg" data-testid="access-counts">
          {counts === undefined
            ? t('access.notCounted')
            : counts === null
              ? t('access.countTimeout')
              : t('access.counts', { readable: counts.readable, editable: counts.editable })}
        </dd>
        <dt className="text-fg-muted">{t('access.hidden')}</dt>
        <dd className="text-fg">
          {hidden.length === 0 ? t('access.none') : hidden.map((field) => field.name).join(', ')}
        </dd>
        <dt className="text-fg-muted">{t('access.readOnly')}</dt>
        <dd className="text-fg">
          {readOnly.length === 0
            ? t('access.none')
            : readOnly.map((field) => field.name).join(', ')}
        </dd>
      </dl>
    </li>
  );
}

/**
 * (T815) The dashboards the member reads: every one for a base admin, else
 * those of `access.dashboards` (names from the caller's — an admin's — list
 * of the base's dashboards), then the ones they cannot open.
 */
function DashboardAccess({
  baseId,
  isAdmin,
  readable,
}: {
  readonly baseId: string;
  readonly isAdmin: boolean;
  readonly readable: Readonly<Record<string, 'read_only'>>;
}) {
  const { t } = useTranslation('baseSettings');
  const dashboards = useQuery(dashboardsQuery(baseId));
  const all = dashboards.data?.items ?? [];
  const reads = all.filter((dashboard) => readable[dashboard.id] === 'read_only');
  const denied = all.filter((dashboard) => readable[dashboard.id] !== 'read_only');
  let body;
  if (isAdmin) {
    body = <p className="text-body text-fg">{t('access.allDashboards')}</p>;
  } else if (dashboards.isPending) {
    body = <Skeleton className="h-6" />;
  } else if (dashboards.isError) {
    body = <ErrorAlert error={dashboards.error} />;
  } else {
    body = (
      <>
        {reads.length === 0 ? (
          <p className="text-body text-fg">{t('access.noDashboards')}</p>
        ) : (
          <ul className="flex flex-col gap-1" data-testid="access-dashboards-list">
            {reads.map((dashboard) => (
              <li
                key={dashboard.id}
                className="rounded-lg border border-line bg-surface px-3 py-2 text-body text-fg"
              >
                {dashboard.name}
              </li>
            ))}
          </ul>
        )}
        {denied.length === 0 ? null : (
          <p className="text-label text-fg-muted" data-testid="access-denied-dashboards">
            {t('access.noAccessDashboards', {
              names: denied.map((dashboard) => dashboard.name).join(', '),
            })}
          </p>
        )}
      </>
    );
  }
  // A base without dashboards: nothing to say.
  if (dashboards.isSuccess && all.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" data-testid="access-dashboards">
      <h3 className="text-label font-medium text-fg-muted">{t('access.dashboards')}</h3>
      {body}
    </section>
  );
}

/**
 * The effective access of one member (T713, Quyết định S6 #12; board
 * "Roles" — no "S6 · Member access" board yet): where it comes from (role,
 * groups, admin rights), the general permissions and, per table, the
 * level, operations, read scope with how many records they read and edit,
 * hidden and read-only fields. Read-only, and said to be no preview of the
 * whole app. A drawer from 768 px, a bottom sheet below.
 */
export function AccessPanel({ baseId, orgId, userId, name, onClose }: AccessPanelProps) {
  const { t } = useTranslation('baseSettings');
  const access = useQuery(memberAccessQuery(baseId, userId));
  const tables = useQuery(tablesQuery(baseId));
  const visible = Object.keys(access.data?.access?.tables ?? {});
  const fieldLists = useQueries({
    queries: visible.map((tableId) => fieldsQuery(tableId)),
  });
  const data = access.data;
  const tableName = (id: string) => tables.data?.items.find((table) => table.id === id)?.name ?? id;
  const denied = (tables.data?.items ?? []).filter((table) => !visible.includes(table.id));

  return (
    <Dialog
      open
      layout="drawer"
      className="max-w-lg"
      title={t('access.title', { name })}
      description={t('access.description')}
      closeLabel={t('page.close')}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div className="flex flex-col gap-4" data-testid="access-panel">
        <Note icon={<Info />}>{t('access.notPreview')}</Note>
        {access.isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-24" />
          </div>
        ) : access.isError || data === undefined ? (
          <ErrorAlert error={access.error} />
        ) : (
          <>
            <section className="flex flex-col gap-1">
              <h3 className="text-label font-medium text-fg-muted">{t('access.sourceTitle')}</h3>
              <Source data={data} orgId={orgId} baseId={baseId} />
            </section>
            {data.access === null ? null : (
              <>
                <section className="flex flex-col gap-1">
                  <h3 className="text-label font-medium text-fg-muted">{t('access.baseRule')}</h3>
                  <p className="text-body text-fg" data-testid="access-base-rule">
                    {BASE_RULES.map((rule) =>
                      t(
                        data.access?.base_rule[rule] === true ? 'access.allowed' : 'access.denied',
                        {
                          what: t(`editor.baseRule.${rule}.label`),
                        },
                      ),
                    ).join(' · ')}
                  </p>
                </section>
                <section className="flex flex-col gap-2">
                  <h3 className="text-label font-medium text-fg-muted">{t('access.tables')}</h3>
                  {data.access.is_admin ? (
                    <p className="text-body text-fg">{t('access.allTables')}</p>
                  ) : null}
                  <ul className="flex flex-col gap-2">
                    {visible.map((tableId, index) => {
                      const tableAccess =
                        data.access?.tables[tableId as keyof typeof data.access.tables];
                      if (tableAccess === undefined) return null;
                      return (
                        <TableEntry
                          key={tableId}
                          name={tableName(tableId)}
                          access={tableAccess}
                          counts={data.counts?.[tableId as keyof typeof data.counts]}
                          fields={fieldLists[index]?.data?.items}
                        />
                      );
                    })}
                  </ul>
                  {denied.length === 0 ? null : (
                    <p className="text-label text-fg-muted" data-testid="access-denied-tables">
                      {t('access.noAccessTables', {
                        names: denied.map((table) => table.name).join(', '),
                      })}
                    </p>
                  )}
                </section>
                <DashboardAccess
                  baseId={baseId}
                  isAdmin={data.access.is_admin}
                  readable={data.access.dashboards}
                />
              </>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

export default AccessPanel;
