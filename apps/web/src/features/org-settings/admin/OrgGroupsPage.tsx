import {
  Button,
  cn,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  FormField,
  Input,
  Select,
  Skeleton,
  Spinner,
} from '@cellhive/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Pencil, Plus, Trash2, UserRoundPlus, UsersRound, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useDocumentTitle } from '../../../lib/a11y/use-document-title';
import { orgAdminApi } from '../../../lib/api/org-admin';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { keys } from '../../../lib/query/keys';
import { orgGroupsQuery, orgMembersQuery } from '../../../lib/query/queries';
import { showErrorToast, showToast } from '../../../lib/toast/toast';

import { AdminPage, ConfirmDialog, groupMembersQuery, TD, TH, useSettingsOrg } from './shared';

import type { GroupDto, MeOrganization } from '@cellhive/contracts';

/** The limit of a group name (`createGroupRequestSchema`). */
const NAME_MAX = 100;

/**
 * `/o/:orgSlug/settings/groups` (FRONTEND §15.0, T830), owners/admins: the
 * groups of the organization with their member count; create (then add its
 * people), rename, delete, and add or remove members. Groups get workspace
 * memberships and base roles (base settings › Members).
 */
export function OrgGroupsPage() {
  const { t } = useTranslation('orgAdmin');
  const { org } = useSettingsOrg();
  const groups = useQuery({ ...orgGroupsQuery(org.id), staleTime: 0 });
  // `'new'`: the create dialog; a group: its rename dialog.
  const [naming, setNaming] = useState<GroupDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<GroupDto | null>(null);
  const [managing, setManaging] = useState<GroupDto | null>(null);
  useDocumentTitle(`${t('groups.title')} · ${org.name}`);
  const items = groups.data?.items ?? [];

  return (
    <AdminPage
      org={org}
      icon={UsersRound}
      title={t('groups.title')}
      subtitle={t('groups.subtitle')}
      actions={
        <Button
          data-testid="group-new"
          onClick={() => {
            setNaming('new');
          }}
        >
          <Plus aria-hidden="true" />
          {t('groups.new')}
        </Button>
      }
    >
      {groups.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : groups.isError ? (
        <ErrorAlert error={groups.error} />
      ) : items.length === 0 ? (
        <p
          className="rounded-lg border border-line bg-surface p-6 text-fg-muted"
          data-testid="groups-empty"
        >
          {t('groups.empty')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full border-collapse text-body" data-testid="group-table">
            <caption className="sr-only">{t('groups.caption')}</caption>
            <thead className="bg-surface-sunken">
              <tr>
                <th scope="col" className={TH}>
                  {t('groups.columns.name')}
                </th>
                <th scope="col" className={TH}>
                  {t('groups.columns.members')}
                </th>
                <th scope="col" className={TH}>
                  <span className="sr-only">{t('members.columns.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((group) => (
                <tr key={group.id} data-testid="group-row" data-group-id={group.id}>
                  <th scope="row" className={cn(TD, 'text-left font-medium break-words')}>
                    {group.name}
                  </th>
                  <td className={cn(TD, 'whitespace-nowrap text-fg-muted')}>
                    {t('groups.count', { count: group.member_count })}
                  </td>
                  <td className={cn(TD, 'w-0 whitespace-nowrap')}>
                    <span className="flex items-center justify-end gap-1">
                      <Button
                        variant="secondary"
                        size="toolbar"
                        aria-label={t('groups.manageOf', { name: group.name })}
                        data-testid={`group-members-${group.id}`}
                        onClick={() => {
                          setManaging(group);
                        }}
                      >
                        <UserRoundPlus aria-hidden="true" />
                        <span className="max-sm:sr-only">{t('groups.manage')}</span>
                      </Button>
                      <GroupMenu group={group} onRename={setNaming} onDelete={setDeleting} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {naming === null ? null : (
        <GroupNameDialog
          org={org}
          group={naming === 'new' ? null : naming}
          onClose={() => {
            setNaming(null);
          }}
          onCreated={setManaging}
        />
      )}
      {deleting === null ? null : (
        <DeleteGroupDialog
          org={org}
          group={deleting}
          onClose={() => {
            setDeleting(null);
          }}
        />
      )}
      {managing === null ? null : (
        <GroupMembersDialog
          org={org}
          group={managing}
          onClose={() => {
            setManaging(null);
          }}
        />
      )}
    </AdminPage>
  );
}

function GroupMenu({
  group,
  onRename,
  onDelete,
}: {
  readonly group: GroupDto;
  readonly onRename: (group: GroupDto) => void;
  readonly onDelete: (group: GroupDto) => void;
}) {
  const { t } = useTranslation('orgAdmin');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t('groups.actionsOf', { name: group.name })}
        data-testid={`group-menu-${group.id}`}
        className="inline-flex size-8 items-center justify-center rounded-md text-fg-muted hover:bg-surface-sunken hover:text-fg focus-visible:outline-2 focus-visible:outline-accent max-lg:size-control"
      >
        <MoreHorizontal aria-hidden="true" className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onSelect={() => {
            onRename(group);
          }}
        >
          <Pencil aria-hidden="true" />
          {t('groups.rename')}
        </DropdownMenuItem>
        <DropdownMenuItem
          className="text-danger [&_svg]:text-danger"
          onSelect={() => {
            onDelete(group);
          }}
        >
          <Trash2 aria-hidden="true" />
          {t('groups.delete')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "New group" (`group` null) or "Rename"; a taken name is `409 NAME_CONFLICT`, shown in the dialog. */
function GroupNameDialog({
  org,
  group,
  onClose,
  onCreated,
}: {
  readonly org: MeOrganization;
  readonly group: GroupDto | null;
  readonly onClose: () => void;
  readonly onCreated: (group: GroupDto) => void;
}) {
  const { t } = useTranslation('orgAdmin');
  const queryClient = useQueryClient();
  const [name, setName] = useState(group?.name ?? '');
  const next = name.trim();
  const save = useMutation({
    mutationFn: () =>
      group === null
        ? orgAdminApi.createGroup(org.id, next)
        : orgAdminApi.renameGroup(org.id, group.id, next),
    onSuccess: async (saved) => {
      onClose();
      showToast({
        variant: 'success',
        message: t(group === null ? 'groups.create.done' : 'groups.renameDialog.done', {
          name: saved.name,
        }),
      });
      // A new group opens its members, to add its people.
      if (group === null) onCreated(saved);
      await queryClient.invalidateQueries({ queryKey: keys.orgGroups(org.id) });
    },
  });
  const unchanged = next === '' || next === group?.name;
  return (
    <Dialog
      open
      layout="sheet"
      className="max-w-md"
      onOpenChange={(open) => {
        if (!open && !save.isPending) onClose();
      }}
      title={
        group === null
          ? t('groups.create.title')
          : t('groups.renameDialog.title', { name: group.name })
      }
      closeLabel={t('page.close')}
    >
      <form
        className="flex flex-col gap-4"
        data-testid="group-name-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!unchanged) save.mutate();
        }}
      >
        <FormField label={t('groups.create.name')}>
          {(control) => (
            <Input
              {...control}
              autoFocus
              autoComplete="off"
              maxLength={NAME_MAX}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </FormField>
        {save.isError ? <ErrorAlert error={save.error} /> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" disabled={save.isPending} onClick={onClose}>
            {t('page.cancel')}
          </Button>
          <Button type="submit" disabled={unchanged || save.isPending}>
            {save.isPending ? <Spinner /> : null}
            {group === null ? t('groups.create.submit') : t('groups.renameDialog.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteGroupDialog({
  org,
  group,
  onClose,
}: {
  readonly org: MeOrganization;
  readonly group: GroupDto;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation('orgAdmin');
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => orgAdminApi.deleteGroup(org.id, group.id),
    onSuccess: async () => {
      onClose();
      showToast({
        variant: 'success',
        message: t('groups.deleteDialog.done', { name: group.name }),
      });
      await queryClient.invalidateQueries({ queryKey: keys.orgGroups(org.id) });
    },
  });
  return (
    <ConfirmDialog
      data-testid="group-delete"
      title={t('groups.deleteDialog.title', { name: group.name })}
      description={t('groups.deleteDialog.description')}
      confirmLabel={t('groups.deleteDialog.confirm')}
      pending={remove.isPending}
      error={remove.error}
      onCancel={onClose}
      onConfirm={() => {
        remove.mutate();
      }}
    />
  );
}

/** The people of a group: add one of the organization's members, remove one. */
function GroupMembersDialog({
  org,
  group,
  onClose,
}: {
  readonly org: MeOrganization;
  readonly group: GroupDto;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation('orgAdmin');
  const queryClient = useQueryClient();
  const members = useQuery(groupMembersQuery(org.id, group.id));
  const orgMembers = useQuery(orgMembersQuery(org.id));
  const [pick, setPick] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.orgGroups(org.id) });
  const add = useMutation({
    mutationFn: (userId: string) => orgAdminApi.addGroupMember(group.id, userId),
    onSuccess: async (added) => {
      setPick('');
      showToast({
        variant: 'success',
        message: t('groups.membersDialog.added', { name: added.user.display_name }),
      });
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (user: { readonly id: string; readonly display_name: string }) =>
      orgAdminApi.removeGroupMember(group.id, user.id),
    onSuccess: async (_, user) => {
      showToast({
        variant: 'success',
        message: t('groups.membersDialog.removed', { name: user.display_name }),
      });
      await refresh();
    },
    onError: (error) => {
      showErrorToast(error);
    },
  });
  const inGroup = new Set(members.data?.items.map((item) => item.user.id));
  const candidates = (orgMembers.data?.items ?? []).filter((item) => !inGroup.has(item.user.id));

  return (
    <Dialog
      open
      layout="sheet"
      className="max-w-lg"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('groups.membersDialog.title', { name: group.name })}
      description={t('groups.membersDialog.description')}
      closeLabel={t('page.close')}
    >
      <div className="flex flex-col gap-4" data-testid="group-members">
        {members.isPending || orgMembers.isPending ? (
          <Skeleton className="h-20" />
        ) : members.isError ? (
          <ErrorAlert error={members.error} />
        ) : orgMembers.isError ? (
          <ErrorAlert error={orgMembers.error} />
        ) : (
          <>
            {candidates.length === 0 ? (
              <p className="text-fg-muted">{t('groups.membersDialog.everyone')}</p>
            ) : (
              <form
                className="flex items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (pick !== '') add.mutate(pick);
                }}
              >
                <FormField label={t('groups.membersDialog.pick')} className="min-w-0 flex-1">
                  {(control) => (
                    <Select
                      {...control}
                      value={pick}
                      data-testid="group-member-pick"
                      onChange={(event) => {
                        setPick(event.target.value);
                      }}
                    >
                      <option value="">{t('groups.membersDialog.choose')}</option>
                      {candidates.map((item) => (
                        <option key={item.user.id} value={item.user.id}>
                          {`${item.user.display_name} (${item.user.email})`}
                        </option>
                      ))}
                    </Select>
                  )}
                </FormField>
                <Button type="submit" disabled={pick === '' || add.isPending}>
                  {add.isPending ? <Spinner /> : null}
                  {t('groups.membersDialog.add')}
                </Button>
              </form>
            )}
            {add.isError ? <ErrorAlert error={add.error} /> : null}
            {members.data.items.length === 0 ? (
              <p className="text-fg-muted">{t('groups.membersDialog.empty')}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
                {members.data.items.map(({ user }) => (
                  <li
                    key={user.id}
                    className="flex items-center gap-3 px-3 py-2"
                    data-testid="group-member"
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="font-medium break-words">{user.display_name}</span>
                      <span className="text-label font-normal break-all text-fg-muted">
                        {user.email}
                      </span>
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('groups.membersDialog.removeOf', { name: user.display_name })}
                      disabled={remove.isPending && remove.variables.id === user.id}
                      onClick={() => {
                        remove.mutate(user);
                      }}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

export default OrgGroupsPage;
