import { Button, cn, Skeleton, Spinner } from '@cellhive/ui';
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { Info, ShieldCheck, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, useBlocker, useParams, useSearchParams } from 'react-router';

import { useDocumentTitle } from '../../../../lib/a11y/use-document-title';
import { rolesApi } from '../../../../lib/api/roles';
import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { PAGE_GUTTER, PageHeading } from '../../../../lib/layout/page-heading';
import { dashboardsQuery } from '../../../../lib/query/dashboards';
import { keys } from '../../../../lib/query/keys';
import {
  baseQuery,
  fieldsQuery,
  orgMembersQuery,
  tablesQuery,
} from '../../../../lib/query/queries';
import { rolesQuery } from '../../../../lib/query/roles';
import { showToast } from '../../../../lib/toast/toast';
import { principalKeys, useIsNarrow } from '../../hooks';
import { isSystemRole, sortRoles } from '../../model';
import { ConfirmDialog, Note } from '../../parts';
import { useRoleName } from '../../role-name';

import {
  configToSave,
  dashboardPermOf,
  draftIssues,
  draftOf,
  isReadOnlyRole,
  placeAdjustments,
  sameConfig,
  withDashboards,
  withTable,
  type DraftIssue,
  type EditorTable,
  type FilterState,
} from './model';
import { BaseRuleSection } from './parts/BaseRuleSection';
import { DashboardSection } from './parts/DashboardSection';
import { TableDetail, type FilterKey } from './parts/TableDetail';
import { TableMatrix } from './parts/TableMatrix';
import { recordRuleSummary } from './summary';

import type { RuleFilterEditorComponent } from '../../../../lib/permissions/rule-filter-editor';
import type { RoleAdjustmentDto, RoleDto, RoleList } from '@cellhive/contracts';
import type { RoleConfig, TableRule } from '@cellhive/permissions';

interface Editing {
  readonly roleId: string;
  /** `updated_at` of the role the baseline comes from. */
  readonly updatedAt: string;
  readonly baseline: RoleConfig;
  readonly draft: RoleConfig;
}

export interface RoleEditorPageProps {
  /** The record rule editor (the view filter builder), from the route (FRONTEND §1.2). */
  readonly RuleFilterEditor: RuleFilterEditorComponent;
}

function permLabel(
  t: (key: string) => string,
  value: RoleAdjustmentDto['from'],
  fieldLevel: boolean,
): string {
  if (Array.isArray(value)) {
    return value.length === 0
      ? t('editor.records.ops.none')
      : value.map((operation) => t(`editor.records.ops.${operation}`)).join(', ');
  }
  return t(fieldLevel ? `editor.fieldLevels.${value}` : `editor.tableLevels.${value}`);
}

/**
 * `/b/:baseId/settings/roles/:roleId` (T713, FRONTEND §17.4; board "Roles",
 * Lark layout — S6-research §2.1, §4): the permissions of one role. General
 * permissions (`base_rule`), the table matrix (a `radiogroup` per table),
 * and per table (`?table=`) its views, records (the view filter builder with
 * user variables and link fields) and fields (the field grid). The draft is
 * saved whole (`PATCH` replaces the config); the server's adjustments show
 * beside the table or field they changed with their reason. A sticky
 * "Unsaved changes · Save / Cancel" bar, and leaving with unsaved changes
 * asks first. Editor/reader system roles show their ceiling (levels above it
 * are off with the reason); the admin role is read-only. Base admins only.
 */
export function RoleEditorPage({ RuleFilterEditor }: RoleEditorPageProps) {
  const { t } = useTranslation(['baseSettings', 'toolbar']);
  const { baseId = '', roleId = '' } = useParams();
  const [search] = useSearchParams();
  const tableParam = search.get('table');
  const queryClient = useQueryClient();
  const { data: base } = useSuspenseQuery(baseQuery(baseId));
  const roles = useQuery(rolesQuery(baseId));
  const tables = useQuery(tablesQuery(baseId));
  const dashboards = useQuery(dashboardsQuery(baseId));
  const fieldLists = useQueries({
    queries: (tables.data?.items ?? []).map((table) => fieldsQuery(table.id)),
  });
  const members = useQuery(orgMembersQuery(base.organization_id));
  const roleName = useRoleName();
  const narrow = useIsNarrow();
  const role = roles.data?.items.find((item) => item.id === roleId);

  const fieldsReady =
    tables.data !== undefined && fieldLists.every((list) => list.data !== undefined);
  const tablesKey = fieldsReady
    ? tables.data.items
        .map(
          (table, index) =>
            `${table.id}:${(fieldLists[index]?.data.items ?? []).map((f) => f.id).join(',')}`,
        )
        .join(';')
    : null;
  const editorTables = useMemo<EditorTable[] | null>(() => {
    if (tablesKey === null || tables.data === undefined) return null;
    return tables.data.items.map((table, index) => ({
      id: table.id,
      name: table.name,
      fields: fieldLists[index]?.data?.items ?? [],
    }));
    // `tablesKey` names every table and field: the list changes only with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tablesKey]);

  const [editing, setEditing] = useState<Editing | null>(null);
  const [filters, setFilters] = useState<ReadonlyMap<string, FilterState>>(new Map());
  const [editOpen, setEditOpen] = useState<ReadonlySet<string>>(new Set());
  const [epoch, setEpoch] = useState(0);
  const [adjustments, setAdjustments] = useState<readonly RoleAdjustmentDto[]>([]);
  const kind = role?.kind ?? 'custom';
  const dirty = editing !== null && !sameConfig(editing.draft, editing.baseline, kind);

  // The draft starts from the stored role; a change made elsewhere (another tab, a
  // `permission.changed`) replaces it only while nothing is unsaved here. Adjusted while
  // rendering (React "storing information from previous renders"), not in an effect.
  if (role !== undefined && editorTables !== null) {
    const next = reconcile(editing, role, editorTables);
    if (next !== editing) setEditing(next);
  }

  useDocumentTitle(
    `${role === undefined ? t('editor.title') : roleName(role)} · ${t('roles.title')} · ${base.name}`,
  );

  // Unsaved changes: ask before leaving the page or closing the tab (`?table=` stays).
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [dirty]);

  const restart = () => {
    setFilters(new Map());
    setEditOpen(new Set());
    setEpoch((value) => value + 1);
  };

  const save = useMutation({
    mutationFn: (config: RoleConfig) => rolesApi.update(baseId, roleId, { config }),
    onSuccess: (saved) => {
      if (editorTables !== null) {
        const config = draftOf(saved.config, saved.kind, editorTables);
        setEditing({
          roleId: saved.id,
          updatedAt: saved.updated_at,
          baseline: config,
          draft: config,
        });
      }
      const { adjustments: made, ...stored } = saved;
      setAdjustments(made);
      restart();
      queryClient.setQueryData<RoleList>(keys.roles(baseId), (list) =>
        list === undefined
          ? list
          : { ...list, items: list.items.map((item) => (item.id === saved.id ? stored : item)) },
      );
      void queryClient.invalidateQueries({ queryKey: keys.roles(baseId) });
      void queryClient.invalidateQueries({ queryKey: principalKeys.all(baseId) });
      showToast({
        variant: 'success',
        message:
          made.length === 0
            ? t('editor.saved', { name: roleName(saved) })
            : t('editor.savedAdjusted', { name: roleName(saved), count: made.length }),
      });
    },
  });

  const placed = useMemo(() => placeAdjustments(adjustments), [adjustments]);
  const issues = useMemo(
    () =>
      editing === null ? new Map<string, DraftIssue[]>() : draftIssues(editing.draft, filters),
    [editing, filters],
  );
  const users = useMemo(
    () =>
      new Map(
        (members.data?.items ?? []).map((member) => [
          member.user.id as string,
          member.user.display_name || member.user.email,
        ]),
      ),
    [members.data],
  );

  const root = `/b/${encodeURIComponent(baseId)}/settings/roles`;
  const here = `${root}/${encodeURIComponent(roleId)}`;
  const tableHref = (tableId: string) => `${here}?table=${encodeURIComponent(tableId)}`;

  const tableName = (id: string) =>
    editorTables?.find((table) => table.id === id)?.name ?? t('editor.summary.unknownTable');
  const fieldName = (tableId: string, fieldId: string) =>
    editorTables
      ?.find((table) => table.id === tableId)
      ?.fields.find((field) => field.id === fieldId)?.name ?? t('editor.summary.unknownField');
  const reasonText = (adjustment: RoleAdjustmentDto) =>
    t(`editor.reasons.${adjustment.reason}`, {
      table: tableName(adjustment.table_id),
      field:
        adjustment.field_id === null ? '' : fieldName(adjustment.table_id, adjustment.field_id),
      from: permLabel(t, adjustment.from, adjustment.field_id !== null),
      to: permLabel(t, adjustment.to, adjustment.field_id !== null),
    });

  const loading =
    roles.isPending || tables.isPending || !fieldsReady || (role !== undefined && editing === null);
  const failed =
    roles.error ?? tables.error ?? fieldLists.find((list) => list.error !== null)?.error;

  const setRule = (tableId: string, rule: TableRule) => {
    setEditing((current) =>
      current === null ? current : { ...current, draft: withTable(current.draft, tableId, rule) },
    );
  };
  const ruleOf = (tableId: string): TableRule | undefined =>
    editing?.draft.tables[tableId as keyof RoleConfig['tables']];

  const header = (
    <PageHeading
      back={{ to: root, label: t('editor.backToRoles') }}
      icon={ShieldCheck}
      title={role === undefined ? t('editor.title') : roleName(role)}
      subtitle={role === undefined ? undefined : <Assigned role={role} />}
    />
  );

  let body;
  if (failed) {
    body = <ErrorAlert error={failed} />;
  } else if (!roles.isPending && role === undefined) {
    body = (
      <Note icon={<Info />} data-testid="role-missing">
        {t('editor.missing')}{' '}
        <Link to={root} className="text-accent underline underline-offset-4">
          {t('editor.backToRoles')}
        </Link>
      </Note>
    );
  } else if (loading || editing === null || editorTables === null || role === undefined) {
    body = (
      <div className="flex flex-col gap-2" data-testid="role-editor-loading">
        <Skeleton className="h-24" />
        <Skeleton className="h-40" />
      </div>
    );
  } else {
    const detailTable =
      tableParam === null ? undefined : editorTables.find((table) => table.id === tableParam);
    const detailRule = detailTable === undefined ? undefined : ruleOf(detailTable.id);
    body = (
      <>
        {isReadOnlyRole(role.kind) ? (
          <Note icon={<Info />} data-testid="role-read-only">
            {t('editor.ceiling.system_admin')}
          </Note>
        ) : isSystemRole(role) ? (
          <Note icon={<Info />} data-testid="role-ceiling">
            {t(`editor.ceiling.${role.kind}`)}
          </Note>
        ) : null}
        {adjustments.length === 0 ? null : (
          <Note
            icon={<Sparkles />}
            title={t('editor.adjusted.title', { count: adjustments.length })}
            data-testid="adjustments"
          >
            <ul className="list-disc pl-4">
              {adjustments.map((adjustment) => (
                <li
                  key={`${adjustment.table_id}:${adjustment.field_id ?? ''}:${adjustment.reason}`}
                >
                  {reasonText(adjustment)}
                </li>
              ))}
            </ul>
          </Note>
        )}
        {detailTable !== undefined && detailRule !== undefined ? (
          <TableDetail
            kind={role.kind}
            table={detailTable}
            rule={detailRule}
            orgId={base.organization_id}
            backHref={here}
            RuleFilterEditor={RuleFilterEditor}
            filterEpoch={epoch}
            editConditionsOpen={editOpen.has(detailTable.id)}
            onEditConditionsOpen={(open) => {
              setEditOpen((current) => {
                const next = new Set(current);
                if (open) next.add(detailTable.id);
                else next.delete(detailTable.id);
                return next;
              });
            }}
            onChange={(rule) => {
              setRule(detailTable.id, rule);
            }}
            onFilterState={(key: FilterKey, state) => {
              setFilters((current) => {
                const next = new Map(current);
                if (state === null) next.delete(`${detailTable.id}:${key}`);
                else next.set(`${detailTable.id}:${key}`, state);
                return next;
              });
            }}
            summary={recordRuleSummary(detailRule, {
              t,
              fields: new Map(detailTable.fields.map((field) => [field.id as string, field])),
              users,
            })}
            issues={issues.get(detailTable.id) ?? []}
            tableAdjustments={placed.tables.get(detailTable.id) ?? []}
            fieldAdjustments={
              new Map(
                detailTable.fields.map((field) => [
                  field.id as string,
                  placed.fields.get(`${detailTable.id}:${field.id}`) ?? [],
                ]),
              )
            }
            reasonText={reasonText}
          />
        ) : (
          <>
            <BaseRuleSection
              value={editing.draft.base_rule}
              disabled={isReadOnlyRole(role.kind)}
              onChange={(baseRule) => {
                setEditing((current) =>
                  current === null
                    ? current
                    : { ...current, draft: { ...current.draft, base_rule: baseRule } },
                );
              }}
            />
            <section className="flex flex-col gap-3" aria-labelledby="role-tables-title">
              <div className="flex flex-col gap-0.5">
                <h2 id="role-tables-title" className="text-body font-semibold text-fg">
                  {t('editor.matrix.title')}
                </h2>
                <p className="text-label text-fg-muted">
                  {t(role.kind === 'custom' ? 'editor.matrix.hint' : 'editor.matrix.hintSystem')}
                </p>
              </div>
              <TableMatrix
                kind={role.kind}
                narrow={narrow}
                detailHref={tableHref}
                reasonText={reasonText}
                rows={editorTables.flatMap((table) => {
                  const rule = ruleOf(table.id);
                  return rule === undefined
                    ? []
                    : [
                        {
                          table,
                          rule,
                          adjustments: placed.tables.get(table.id) ?? [],
                          fieldAdjustments: placed.fieldCounts.get(table.id) ?? 0,
                          issues: issues.get(table.id) ?? [],
                        },
                      ];
                })}
                onLevel={(tableId, perm) => {
                  const rule = ruleOf(tableId);
                  if (rule !== undefined) setRule(tableId, { ...rule, perm });
                }}
              />
            </section>
            <DashboardSection
              kind={role.kind}
              dashboards={dashboards.data?.items}
              error={dashboards.error}
              levelOf={(dashboardId) => dashboardPermOf(editing.draft, role.kind, dashboardId)}
              onChange={(ids, perm) => {
                setEditing((current) =>
                  current === null
                    ? current
                    : { ...current, draft: withDashboards(current.draft, ids, perm) },
                );
              }}
            />
          </>
        )}
      </>
    );
  }

  const blocked = issues.size > 0;
  return (
    <div className="flex min-h-full flex-col bg-canvas">
      {header}
      <div className="flex min-w-0 flex-1">
        <RoleNav roles={roles.data?.items ?? []} root={root} />
        <div
          className={cn('flex min-w-0 flex-1 flex-col gap-4 py-6', PAGE_GUTTER)}
          data-testid="role-editor"
        >
          {body}
        </div>
      </div>
      {dirty ? (
        <div
          className="sticky bottom-0 z-10 border-t border-line bg-surface shadow-lg"
          data-testid="unsaved-bar"
        >
          <div
            className={cn('flex flex-wrap items-center justify-between gap-3 py-3', PAGE_GUTTER)}
          >
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-body font-medium text-fg" role="status">
                {t('editor.unsaved.label')}
              </span>
              {blocked ? (
                <span className="text-label text-danger">
                  {t('editor.unsaved.blocked', { count: issues.size })}
                </span>
              ) : null}
              {save.error === null ? null : <ErrorAlert error={save.error} />}
            </div>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                data-testid="role-cancel"
                disabled={save.isPending}
                onClick={() => {
                  setEditing({ ...editing, draft: editing.baseline });
                  save.reset();
                  restart();
                }}
              >
                {t('editor.unsaved.cancel')}
              </Button>
              <Button
                data-testid="role-save"
                disabled={save.isPending || blocked}
                onClick={() => {
                  save.mutate(configToSave(editing.draft, kind));
                }}
              >
                {save.isPending ? <Spinner /> : null}
                {t('editor.unsaved.save')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {blocker.state === 'blocked' ? (
        <ConfirmDialog
          data-testid="role-leave"
          title={t('editor.leave.title')}
          description={t('editor.leave.description')}
          confirmLabel={t('editor.leave.confirm')}
          onCancel={() => {
            blocker.reset();
          }}
          onConfirm={() => {
            blocker.proceed();
          }}
        />
      ) : null}
    </div>
  );
}

function Assigned({ role }: { readonly role: RoleDto }) {
  const { t } = useTranslation('baseSettings');
  if (role.assignments.length === 0) return t('roles.nobody');
  const names = role.assignments.slice(0, 3).map((item) => item.name);
  const more = role.assignments.length - names.length;
  return t('editor.assignedTo', {
    names:
      more > 0 ? t('roles.namesMore', { names: names.join(', '), count: more }) : names.join(', '),
  });
}

/** ≥ 1280 px: the roles of the base beside the editor (board "Roles"; Lark layout). */
function RoleNav({ roles, root }: { readonly roles: readonly RoleDto[]; readonly root: string }) {
  const { t } = useTranslation('baseSettings');
  const roleName = useRoleName();
  if (roles.length === 0) return null;
  return (
    <nav
      aria-label={t('editor.roleNav')}
      className="hidden w-64 shrink-0 border-r border-line bg-surface px-2 py-4 xl:block"
      data-testid="role-nav"
    >
      <ul className="flex flex-col gap-0.5">
        {sortRoles(roles).map((role) => (
          <li key={role.id}>
            <NavLink
              to={`${root}/${encodeURIComponent(role.id)}`}
              className={({ isActive }) =>
                cn(
                  'flex min-h-10 flex-col justify-center rounded-md px-2.5 py-1.5 text-body text-fg hover:bg-surface-sunken',
                  isActive && 'bg-accent-soft font-medium',
                )
              }
            >
              <span className="flex items-center gap-1.5">
                <span className="truncate">{roleName(role)}</span>
                {isSystemRole(role) ? (
                  <span className="rounded border border-line-strong px-1 text-label leading-4 font-normal text-fg-muted">
                    {t('roles.builtIn')}
                  </span>
                ) : null}
              </span>
              <span className="truncate text-label font-normal text-fg-muted">
                {role.assignments.length === 0
                  ? t('roles.nobody')
                  : role.assignments.map((item) => item.name).join(', ')}
              </span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export default RoleEditorPage;

/**
 * The editing state for the stored `role`: a fresh draft for another role,
 * or when the role changed elsewhere and nothing is unsaved here; tables
 * created meanwhile join the draft and the baseline. The same object when
 * nothing changes (so rendering does not loop).
 */
function reconcile(
  current: Editing | null,
  role: RoleDto,
  tables: readonly EditorTable[],
): Editing | null {
  const fresh = (): Editing => {
    const config = draftOf(role.config, role.kind, tables);
    return { roleId: role.id, updatedAt: role.updated_at, baseline: config, draft: config };
  };
  if (current === null || current.roleId !== role.id) return fresh();
  const unsaved = !sameConfig(current.draft, current.baseline, role.kind);
  if (current.updatedAt !== role.updated_at && !unsaved) return fresh();
  const missing = tables.filter((table) => !(table.id in current.draft.tables));
  if (missing.length === 0) return current;
  const stored = draftOf(role.config, role.kind, tables);
  let { draft, baseline } = current;
  for (const table of missing) {
    const rule = stored.tables[table.id as keyof RoleConfig['tables']];
    if (rule === undefined) continue;
    draft = withTable(draft, table.id, rule);
    baseline = withTable(baseline, table.id, rule);
  }
  return { ...current, draft, baseline };
}
