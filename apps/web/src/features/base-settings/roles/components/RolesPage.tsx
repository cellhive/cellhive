import { Button, buttonVariants, cn, Skeleton } from '@cellhive/ui';
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { Pencil, Plus, ShieldCheck, SlidersHorizontal, Trash2, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { useDocumentTitle } from '../../../../lib/a11y/use-document-title';
import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { PAGE_GUTTER, PageHeading } from '../../../../lib/layout/page-heading';
import { baseQuery } from '../../../../lib/query/queries';
import { rolesQuery } from '../../../../lib/query/roles';
import { showToast } from '../../../../lib/toast/toast';
import { useIsNarrow, useRoleMutations } from '../../hooks';
import { assignmentCounts, isSystemRole, sortRoles } from '../../model';
import { ConfirmDialog, Note } from '../../parts';
import { useRoleName } from '../../role-name';

import { RoleNameDialog } from './RoleNameDialog';

import type { RoleDto } from '@cellhive/contracts';

/** Names shown beside the counts before "+N". */
const NAMES_SHOWN = 3;

type Editing = { readonly mode: 'create' } | { readonly mode: 'rename'; readonly role: RoleDto };

/**
 * `/b/:baseId/settings/roles` (T712, FRONTEND §17): the roles of the base in
 * `position` order — the system roles (admin, editor, reader) with their
 * label and a short description, then the custom ones — with who holds
 * them; create (a name), rename and delete custom roles; "Permissions" opens
 * the role editor (T713, `roles/:roleId`). A role still assigned is not deleted: the dialog lists who
 * holds it (`ROLE_IN_USE`). Base admins only (route guard `baseSettings`).
 */
export function RolesPage() {
  const { t } = useTranslation('baseSettings');
  const { baseId = '' } = useParams();
  const { data: base } = useSuspenseQuery(baseQuery(baseId));
  const roles = useQuery(rolesQuery(baseId));
  const mutations = useRoleMutations(baseId);
  const roleName = useRoleName();
  const narrow = useIsNarrow();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const focusId = useRef<string | null>(null);
  useDocumentTitle(`${t('roles.title')} · ${base.name}`);

  const items = sortRoles(roles.data?.items ?? []);
  const deleting = deletingId === null ? undefined : items.find((role) => role.id === deletingId);

  // A created role gets the focus (and scrolls into view) once its row is there.
  useEffect(() => {
    if (focusId.current === null) return;
    const row = document.getElementById(`role-${focusId.current}`);
    if (row === null) return;
    row.focus();
    focusId.current = null;
  }, [roles.data, narrow]);

  const closeEditing = () => {
    setEditing(null);
    mutations.create.reset();
    mutations.rename.reset();
  };
  const closeDeleting = () => {
    setDeletingId(null);
    mutations.remove.reset();
  };

  const actions = {
    onRename: (role: RoleDto) => {
      setEditing({ mode: 'rename', role });
    },
    onDelete: (role: RoleDto) => {
      setDeletingId(role.id);
    },
  };

  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <PageHeading
        back={{
          to: `/b/${encodeURIComponent(base.id)}`,
          label: t('page.back', { name: base.name }),
        }}
        icon={ShieldCheck}
        title={t('roles.title')}
        subtitle={t('roles.subtitle', { base: base.name })}
        actions={
          <Button
            data-testid="role-create"
            onClick={() => {
              setEditing({ mode: 'create' });
            }}
          >
            <Plus aria-hidden="true" />
            {t('roles.create.action')}
          </Button>
        }
      />
      <div className={cn('flex flex-col gap-4 py-6', PAGE_GUTTER)}>
        <Note icon={<Users />} data-testid="roles-note">
          {t('roles.note')}{' '}
          <Link
            to={`/b/${encodeURIComponent(base.id)}/settings/members`}
            className="text-accent underline underline-offset-4"
          >
            {t('roles.toMembers')}
          </Link>
        </Note>
        {roles.isPending ? (
          <div className="flex flex-col gap-2" data-testid="roles-loading">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : roles.isError ? (
          <ErrorAlert error={roles.error} />
        ) : narrow ? (
          <RoleCards baseId={base.id} items={items} roleName={roleName} {...actions} />
        ) : (
          <RoleTable baseId={base.id} items={items} roleName={roleName} {...actions} />
        )}
      </div>

      {editing === null ? null : editing.mode === 'create' ? (
        <RoleNameDialog
          mode="create"
          pending={mutations.create.isPending}
          error={mutations.create.error}
          onEdit={() => {
            if (mutations.create.error !== null) mutations.create.reset();
          }}
          onClose={closeEditing}
          onSubmit={(name) => {
            mutations.create.mutate(name, {
              onSuccess: (role) => {
                closeEditing();
                focusId.current = role.id;
                showToast({ variant: 'success', message: t('roles.created', { name: role.name }) });
              },
            });
          }}
        />
      ) : (
        <RoleNameDialog
          mode="rename"
          initialName={editing.role.name}
          pending={mutations.rename.isPending}
          error={mutations.rename.error}
          onEdit={() => {
            if (mutations.rename.error !== null) mutations.rename.reset();
          }}
          onClose={closeEditing}
          onSubmit={(name) => {
            mutations.rename.mutate(
              { roleId: editing.role.id, name },
              {
                onSuccess: (role) => {
                  closeEditing();
                  showToast({
                    variant: 'success',
                    message: t('roles.renamed', { name: role.name }),
                  });
                },
              },
            );
          }}
        />
      )}

      {deleting === undefined ? null : deleting.assignments.length > 0 ? (
        <ConfirmDialog
          data-testid="role-in-use"
          title={t('roles.inUse.title', { name: roleName(deleting) })}
          description={t('roles.inUse.description')}
          onCancel={closeDeleting}
        >
          <ul
            className="flex max-h-64 flex-col divide-y divide-line overflow-y-auto rounded-lg border border-line"
            aria-label={t('roles.inUse.listLabel', { name: roleName(deleting) })}
            data-testid="role-in-use-list"
            tabIndex={0}
          >
            {deleting.assignments.map((item) => (
              <li
                key={`${item.principal_type}:${item.principal_id}`}
                className="flex flex-col px-3 py-2"
              >
                <span className="text-body text-fg">{item.name}</span>
                <span className="text-label font-normal text-fg-muted">
                  {item.principal_type === 'group'
                    ? t('members.type.group')
                    : (item.email ?? t('members.type.user'))}
                </span>
              </li>
            ))}
          </ul>
          <Link
            to={`/b/${encodeURIComponent(base.id)}/settings/members`}
            className="w-fit text-body text-accent underline underline-offset-4"
          >
            {t('roles.toMembers')}
          </Link>
        </ConfirmDialog>
      ) : (
        <ConfirmDialog
          data-testid="role-delete"
          title={t('roles.delete.title', { name: roleName(deleting) })}
          description={t('roles.delete.description')}
          confirmLabel={t('roles.delete.confirm')}
          pending={mutations.remove.isPending}
          // ROLE_IN_USE (assigned meanwhile): the refetched role turns this into the list above.
          error={mutations.remove.error}
          onCancel={closeDeleting}
          onConfirm={() => {
            const name = roleName(deleting);
            mutations.remove.mutate(deleting.id, {
              onSuccess: () => {
                closeDeleting();
                showToast({ variant: 'success', message: t('roles.deleted', { name }) });
              },
            });
          }}
        />
      )}
    </div>
  );
}

interface ListProps {
  readonly baseId: string;
  readonly items: readonly RoleDto[];
  readonly roleName: (role: RoleDto) => string;
  readonly onRename: (role: RoleDto) => void;
  readonly onDelete: (role: RoleDto) => void;
}

function RoleTitle({ role, roleName }: { role: RoleDto; roleName: (role: RoleDto) => string }) {
  const { t } = useTranslation('baseSettings');
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium break-words text-fg">{roleName(role)}</span>
        {isSystemRole(role) ? (
          <span className="rounded border border-line-strong px-1 text-label leading-4 font-normal text-fg-muted">
            {t('roles.builtIn')}
          </span>
        ) : null}
      </span>
      {isSystemRole(role) ? (
        <span className="text-label font-normal text-fg-muted">
          {t(`roles.system.${role.kind}.description`)}
        </span>
      ) : null}
    </span>
  );
}

function Assigned({ role }: { role: RoleDto }) {
  const { t } = useTranslation('baseSettings');
  const counts = assignmentCounts(role.assignments);
  if (role.assignments.length === 0) {
    return <span className="text-fg-muted">{t('roles.nobody')}</span>;
  }
  const parts = [
    counts.users > 0 ? t('roles.people', { count: counts.users }) : null,
    counts.groups > 0 ? t('roles.groups', { count: counts.groups }) : null,
  ].filter((part) => part !== null);
  const names = role.assignments.slice(0, NAMES_SHOWN).map((item) => item.name);
  const more = role.assignments.length - names.length;
  return (
    <span className="flex min-w-0 flex-col gap-0.5" data-testid={`role-assigned-${role.id}`}>
      <span className="text-fg">{parts.join(' · ')}</span>
      <span className="text-label font-normal break-words text-fg-muted">
        {more > 0
          ? t('roles.namesMore', { names: names.join(', '), count: more })
          : names.join(', ')}
      </span>
    </span>
  );
}

function RoleActions({
  role,
  baseId,
  roleName,
  onRename,
  onDelete,
}: { role: RoleDto } & ListProps) {
  const { t } = useTranslation('baseSettings');
  const name = roleName(role);
  const editor = (
    <Link
      to={`/b/${encodeURIComponent(baseId)}/settings/roles/${encodeURIComponent(role.id)}`}
      className={buttonVariants({ variant: 'ghost', size: 'toolbar' })}
      aria-label={t('roles.permissions.label', { name })}
      data-testid={`role-permissions-${role.id}`}
    >
      <SlidersHorizontal aria-hidden="true" />
      <span className="max-lg:sr-only" aria-hidden="true">
        {t('roles.permissions.action')}
      </span>
    </Link>
  );
  if (isSystemRole(role)) return <span className="flex justify-end gap-1">{editor}</span>;
  return (
    <span className="flex justify-end gap-1">
      {editor}
      <Button
        variant="ghost"
        size="toolbar"
        aria-label={t('roles.rename.label', { name })}
        data-testid={`role-rename-${role.id}`}
        onClick={() => {
          onRename(role);
        }}
      >
        <Pencil aria-hidden="true" />
        <span className="max-lg:sr-only" aria-hidden="true">
          {t('roles.rename.action')}
        </span>
      </Button>
      <Button
        variant="ghost"
        size="toolbar"
        className="text-danger"
        aria-label={t('roles.delete.label', { name })}
        data-testid={`role-delete-${role.id}`}
        onClick={() => {
          onDelete(role);
        }}
      >
        <Trash2 aria-hidden="true" />
        <span className="max-lg:sr-only" aria-hidden="true">
          {t('roles.delete.action')}
        </span>
      </Button>
    </span>
  );
}

const TH = 'h-[34px] px-3 text-left text-label font-medium whitespace-nowrap text-fg-muted';
const TD = 'px-3 py-3 align-top';

/** ≥ 768 px: one row per role. */
function RoleTable(props: ListProps) {
  const { t } = useTranslation('baseSettings');
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full border-collapse text-body" data-testid="role-table">
        <caption className="sr-only">{t('roles.caption')}</caption>
        <thead className="bg-surface-sunken">
          <tr>
            <th scope="col" className={TH}>
              {t('roles.columns.role')}
            </th>
            <th scope="col" className={TH}>
              {t('roles.columns.assigned')}
            </th>
            <th scope="col" className={cn(TH, 'text-right')}>
              <span className="sr-only">{t('roles.columns.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {props.items.map((role) => (
            <tr
              key={role.id}
              id={`role-${role.id}`}
              tabIndex={-1}
              data-testid="role-row"
              data-role-id={role.id}
              className="focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
            >
              <th scope="row" className={cn(TD, 'w-[45%] text-left font-normal')}>
                <RoleTitle role={role} roleName={props.roleName} />
              </th>
              <td className={TD}>
                <Assigned role={role} />
              </td>
              <td className={cn(TD, 'w-0 whitespace-nowrap')}>
                <RoleActions role={role} {...props} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** < 768 px: one card per role, the same facts stacked. */
function RoleCards(props: ListProps) {
  const { t } = useTranslation('baseSettings');
  return (
    <ul aria-label={t('roles.caption')} className="flex flex-col gap-3" data-testid="role-cards">
      {props.items.map((role) => (
        <li
          key={role.id}
          id={`role-${role.id}`}
          tabIndex={-1}
          data-testid="role-row"
          data-role-id={role.id}
          className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 focus-visible:outline-2 focus-visible:outline-accent"
        >
          <div className="flex items-start justify-between gap-3">
            <RoleTitle role={role} roleName={props.roleName} />
            <RoleActions role={role} {...props} />
          </div>
          <Assigned role={role} />
        </li>
      ))}
    </ul>
  );
}

export default RolesPage;
