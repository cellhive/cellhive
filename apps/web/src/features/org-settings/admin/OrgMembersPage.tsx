import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Select,
  Skeleton,
  Spinner,
} from '@cellhive/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info, KeyRound, MoreHorizontal, UserMinus, UserPlus, Users } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useDocumentTitle } from '../../../lib/a11y/use-document-title';
import { orgAdminApi } from '../../../lib/api/org-admin';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../lib/i18n/format';
import { keys } from '../../../lib/query/keys';
import { orgMembersQuery } from '../../../lib/query/queries';
import { showErrorToast, showToast } from '../../../lib/toast/toast';
import { Note } from '../api-tokens/components/parts';

import {
  InvitationsSection,
  InviteDialog,
  PasswordResetDialog,
  RemoveMemberDialog,
} from './member-dialogs';
import { AdminPage, TD, TH, useSettingsOrg } from './shared';

import type { OrgMemberDto, OrgMemberList, OrgRoleName } from '@cellhive/contracts';

const ROLES: readonly OrgRoleName[] = ['owner', 'admin', 'member'];

interface Allowed {
  /** Roles the caller may pick for the member; `null`: shown as text. */
  readonly roles: readonly OrgRoleName[] | null;
  readonly reset: boolean;
  readonly remove: boolean;
  readonly lastOwner: boolean;
}

/**
 * What the caller may do to `member` (SPEC §13.1, `OrgMemberService`): only
 * owners change or remove an owner or make someone an owner, never the last
 * owner; the own row is read-only here. A password reset link is refused
 * for owners (they own this organization, `403`) — other refusals (another
 * organization) come from the API.
 */
function allowedFor(
  member: OrgMemberDto,
  caller: { readonly role: OrgRoleName; readonly userId: string },
  owners: number,
): Allowed {
  const self = member.user.id === caller.userId;
  const lastOwner = member.role === 'owner' && owners <= 1;
  const ownerLocked = member.role === 'owner' && (caller.role !== 'owner' || lastOwner);
  return {
    roles: self || ownerLocked ? null : caller.role === 'owner' ? ROLES : ['admin', 'member'],
    reset: !self && member.role !== 'owner',
    remove: !self && !ownerLocked,
    lastOwner,
  };
}

/**
 * `/o/:orgSlug/settings/members` (FRONTEND §15.0, T830), owners/admins: the
 * members with their organization role (a select where the API allows a
 * change), "Remove from organization" and "Create password reset link"
 * (shown once), "Invite people" (the link is shown once — often there is no
 * SMTP) and the pending invitations.
 */
export function OrgMembersPage() {
  // `apiTokens` holds the strings of the shared "Copy" field: loaded with the page.
  const { t } = useTranslation(['orgAdmin', 'apiTokens']);
  const { org, userId } = useSettingsOrg();
  const queryClient = useQueryClient();
  const format = useFormatters();
  const members = useQuery({ ...orgMembersQuery(org.id), staleTime: 0 });
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<OrgMemberDto | null>(null);
  const [resetting, setResetting] = useState<OrgMemberDto | null>(null);
  useDocumentTitle(`${t('members.title')} · ${org.name}`);

  const setRole = useMutation({
    mutationFn: (input: { readonly member: OrgMemberDto; readonly role: OrgRoleName }) =>
      orgAdminApi.setMemberRole(org.id, input.member.user.id, input.role),
    onSuccess: (updated) => {
      queryClient.setQueryData<OrgMemberList>(keys.orgMembers(org.id), (data) =>
        data === undefined
          ? data
          : {
              ...data,
              items: data.items.map((item) => (item.user.id === updated.user.id ? updated : item)),
            },
      );
      showToast({
        variant: 'success',
        message: t('members.roleChanged', {
          name: updated.user.display_name,
          role: t(`roles.${updated.role}`),
        }),
      });
    },
    onError: (error) => {
      showErrorToast(error);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.orgMembers(org.id) }),
  });

  const items = members.data?.items ?? [];
  const owners = items.filter((item) => item.role === 'owner').length;
  const caller = { role: org.role, userId };

  return (
    <AdminPage
      org={org}
      icon={Users}
      title={t('members.title')}
      subtitle={t('members.subtitle', { org: org.name })}
      actions={
        <Button
          data-testid="invite-open"
          onClick={() => {
            setInviting(true);
          }}
        >
          <UserPlus aria-hidden="true" />
          {t('members.invite')}
        </Button>
      }
    >
      <Note tone="neutral" icon={<Info />}>
        {t('members.rules')}
      </Note>
      {members.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : members.isError ? (
        <ErrorAlert error={members.error} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full border-collapse text-body" data-testid="org-member-table">
            <caption className="sr-only">{t('members.caption')}</caption>
            <thead className="bg-surface-sunken">
              <tr>
                <th scope="col" className={TH}>
                  {t('members.columns.name')}
                </th>
                <th scope="col" className={TH}>
                  {t('members.columns.role')}
                </th>
                <th scope="col" className={cn(TH, 'max-sm:hidden')}>
                  {t('members.columns.joined')}
                </th>
                <th scope="col" className={TH}>
                  <span className="sr-only">{t('members.columns.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((member) => {
                const allowed = allowedFor(member, caller, owners);
                const pending =
                  setRole.isPending && setRole.variables.member.user.id === member.user.id
                    ? setRole.variables.role
                    : undefined;
                return (
                  <tr
                    key={member.user.id}
                    data-testid="org-member-row"
                    data-user-id={member.user.id}
                  >
                    <th scope="row" className={cn(TD, 'text-left font-normal')}>
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="flex flex-wrap items-center gap-2 font-medium break-words text-fg">
                          {member.user.display_name}
                          {member.user.id === userId ? (
                            <span className="rounded-sm bg-accent-soft px-1.5 text-label font-normal">
                              {t('members.you')}
                            </span>
                          ) : null}
                        </span>
                        <span className="text-label font-normal break-all text-fg-muted">
                          {member.user.email}
                        </span>
                      </span>
                    </th>
                    <td className={cn(TD, 'w-0 whitespace-nowrap')}>
                      {allowed.roles === null ? (
                        <span className="flex flex-col">
                          <span>{t(`roles.${member.role}`)}</span>
                          {allowed.lastOwner ? (
                            <span className="text-label font-normal text-fg-muted">
                              {t('members.onlyOwner')}
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        <span className="flex items-center gap-2">
                          <Select
                            aria-label={t('members.roleOf', { name: member.user.display_name })}
                            data-testid={`org-member-role-${member.user.id}`}
                            className="min-w-36"
                            // Not disabled while saving: the focus stays on the select.
                            aria-busy={pending !== undefined || undefined}
                            value={pending ?? member.role}
                            onChange={(event) => {
                              const role = event.target.value as OrgRoleName;
                              if (pending === undefined && role !== member.role) {
                                setRole.mutate({ member, role });
                              }
                            }}
                          >
                            {allowed.roles.map((role) => (
                              <option key={role} value={role}>
                                {t(`roles.${role}`)}
                              </option>
                            ))}
                          </Select>
                          {pending === undefined ? null : <Spinner />}
                        </span>
                      )}
                    </td>
                    <td className={cn(TD, 'whitespace-nowrap text-fg-muted max-sm:hidden')}>
                      {format.date(member.joined_at)}
                    </td>
                    <td className={cn(TD, 'w-0 text-right')}>
                      {allowed.reset || allowed.remove ? (
                        <MemberMenu
                          member={member}
                          allowed={allowed}
                          onReset={setResetting}
                          onRemove={setRemoving}
                        />
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <InvitationsSection org={org} />
      {inviting ? (
        <InviteDialog
          org={org}
          onClose={() => {
            setInviting(false);
          }}
        />
      ) : null}
      {removing === null ? null : (
        <RemoveMemberDialog
          org={org}
          member={removing}
          // Owners and admins other than the removed member may take over their bases.
          heirs={items.filter(
            (item) => item.role !== 'member' && item.user.id !== removing.user.id,
          )}
          defaultHeir={userId}
          onClose={() => {
            setRemoving(null);
          }}
        />
      )}
      {resetting === null ? null : (
        <PasswordResetDialog
          org={org}
          member={resetting}
          onClose={() => {
            setResetting(null);
          }}
        />
      )}
    </AdminPage>
  );
}

function MemberMenu({
  member,
  allowed,
  onReset,
  onRemove,
}: {
  readonly member: OrgMemberDto;
  readonly allowed: Allowed;
  readonly onReset: (member: OrgMemberDto) => void;
  readonly onRemove: (member: OrgMemberDto) => void;
}) {
  const { t } = useTranslation('orgAdmin');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t('members.actionsOf', { name: member.user.display_name })}
        data-testid={`org-member-menu-${member.user.id}`}
        className="inline-flex size-8 items-center justify-center rounded-md text-fg-muted hover:bg-surface-sunken hover:text-fg focus-visible:outline-2 focus-visible:outline-accent max-lg:size-control"
      >
        <MoreHorizontal aria-hidden="true" className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {allowed.reset ? (
          <DropdownMenuItem
            onSelect={() => {
              onReset(member);
            }}
          >
            <KeyRound aria-hidden="true" />
            {t('members.resetPassword')}
          </DropdownMenuItem>
        ) : null}
        {allowed.remove ? (
          <DropdownMenuItem
            className="text-danger [&_svg]:text-danger"
            onSelect={() => {
              onRemove(member);
            }}
          >
            <UserMinus aria-hidden="true" />
            {t('members.remove')}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default OrgMembersPage;
