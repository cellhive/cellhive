import { Button, cn, Dialog, FormField, Input, Select, Skeleton, Spinner } from '@cellhive/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { orgAdminApi } from '../../../lib/api/org-admin';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../lib/i18n/format';
import { keys } from '../../../lib/query/keys';
import { showToast } from '../../../lib/toast/toast';
import { CopyField, Note, Section } from '../api-tokens/components/parts';

import { ConfirmDialog, invitationsQuery, TD, TH } from './shared';

import type {
  CreatedInvitation,
  InvitationDto,
  InvitationRole,
  MeOrganization,
  OrgMemberDto,
  PasswordResetLink,
} from '@cellhive/contracts';

const INVITATION_ROLES: readonly InvitationRole[] = ['member', 'admin'];

/** "Pending invitations": email, role, expiry and "Revoke" (`alertdialog`). */
export function InvitationsSection({ org }: { readonly org: MeOrganization }) {
  const { t } = useTranslation('orgAdmin');
  const queryClient = useQueryClient();
  const format = useFormatters();
  const invitations = useQuery(invitationsQuery(org.id));
  const [revoking, setRevoking] = useState<InvitationDto | null>(null);
  const revoke = useMutation({
    mutationFn: (invitation: InvitationDto) => orgAdminApi.revokeInvitation(org.id, invitation.id),
    onSuccess: async () => {
      setRevoking(null);
      showToast({ variant: 'success', message: t('invitations.revoked') });
      await queryClient.invalidateQueries({ queryKey: invitationsQuery(org.id).queryKey });
    },
  });
  const items = invitations.data?.items ?? [];
  return (
    <Section
      title={t('invitations.title')}
      intro={t('invitations.intro')}
      data-testid="invitations"
    >
      {invitations.isPending ? (
        <Skeleton className="h-12" />
      ) : invitations.isError ? (
        <ErrorAlert error={invitations.error} />
      ) : items.length === 0 ? (
        <p className="text-fg-muted" data-testid="invitations-empty">
          {t('invitations.empty')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full border-collapse text-body">
            <caption className="sr-only">{t('invitations.caption')}</caption>
            <thead className="bg-surface-sunken">
              <tr>
                <th scope="col" className={TH}>
                  {t('invitations.columns.email')}
                </th>
                <th scope="col" className={TH}>
                  {t('invitations.columns.role')}
                </th>
                <th scope="col" className={cn(TH, 'max-sm:hidden')}>
                  {t('invitations.columns.expires')}
                </th>
                <th scope="col" className={TH}>
                  <span className="sr-only">{t('invitations.revoke')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((invitation) => (
                <tr key={invitation.id} data-testid="invitation-row">
                  <th scope="row" className={cn(TD, 'text-left font-normal break-all')}>
                    {invitation.email}
                  </th>
                  <td className={cn(TD, 'whitespace-nowrap')}>{t(`roles.${invitation.role}`)}</td>
                  <td className={cn(TD, 'whitespace-nowrap text-fg-muted max-sm:hidden')}>
                    {format.dateTime(invitation.expires_at)}
                  </td>
                  <td className={cn(TD, 'w-0 text-right')}>
                    <Button
                      variant="ghost"
                      size="toolbar"
                      aria-label={t('invitations.revokeOf', { email: invitation.email })}
                      onClick={() => {
                        setRevoking(invitation);
                      }}
                    >
                      {t('invitations.revoke')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {revoking === null ? null : (
        <ConfirmDialog
          data-testid="invitation-revoke"
          title={t('invitations.revokeTitle', { email: revoking.email })}
          description={t('invitations.revokeDescription')}
          confirmLabel={t('invitations.revoke')}
          pending={revoke.isPending}
          error={revoke.error}
          onCancel={() => {
            setRevoking(null);
            revoke.reset();
          }}
          onConfirm={() => {
            revoke.mutate(revoking);
          }}
        />
      )}
    </Section>
  );
}

/**
 * "Invite people" (`POST /orgs/:id/invitations`): email and role, then the
 * invitation link, shown **once** with "Copy" — often the server has no
 * SMTP, so the inviter sends it. The link lives only in this dialog's state.
 */
export function InviteDialog({
  org,
  onClose,
}: {
  readonly org: MeOrganization;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation('orgAdmin');
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InvitationRole>('member');
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const invite = useMutation({
    mutationFn: () => orgAdminApi.invite(org.id, { email: email.trim(), role }),
    onSuccess: async (result) => {
      setCreated(result);
      await queryClient.invalidateQueries({ queryKey: invitationsQuery(org.id).queryKey });
    },
  });
  return (
    <Dialog
      open
      layout="sheet"
      className="max-w-lg"
      onOpenChange={(next) => {
        if (!next && !invite.isPending) onClose();
      }}
      title={
        created === null ? t('invite.title') : t('invite.createdTitle', { email: created.email })
      }
      description={created === null ? t('invite.description', { org: org.name }) : undefined}
      closeLabel={t('page.close')}
    >
      {created === null ? (
        <form
          className="flex flex-col gap-4"
          data-testid="invite-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (email.trim() !== '') invite.mutate();
          }}
        >
          <FormField label={t('invite.email')}>
            {(control) => (
              <Input
                {...control}
                type="email"
                autoComplete="off"
                autoFocus
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                }}
              />
            )}
          </FormField>
          <FormField label={t('invite.role')}>
            {(control) => (
              <Select
                {...control}
                value={role}
                onChange={(event) => {
                  setRole(event.target.value as InvitationRole);
                }}
              >
                {INVITATION_ROLES.map((item) => (
                  <option key={item} value={item}>
                    {t(`roles.${item}`)}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          {invite.isError ? <ErrorAlert error={invite.error} /> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              {t('page.cancel')}
            </Button>
            <Button type="submit" disabled={email.trim() === '' || invite.isPending}>
              {invite.isPending ? <Spinner /> : null}
              {t('invite.submit')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-4" data-testid="invite-created">
          <Note tone="warning" icon={<TriangleAlert />} title={t('invite.once')}>
            {created.email_sent ? t('invite.emailSent') : t('invite.noEmail')}
          </Note>
          <CopyField
            label={t('invite.link')}
            value={created.invite_url}
            data-testid="invite-link"
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setCreated(null);
                setEmail('');
                invite.reset();
              }}
            >
              {t('invite.another')}
            </Button>
            <Button onClick={onClose}>{t('page.done')}</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/**
 * "Create password reset link" (`POST /orgs/:id/members/:userId/password-reset`):
 * what it does, then the one-time link shown **once**. The API refuses
 * (`403`) a member who also belongs to another organization or owns one:
 * the server CLI resets those.
 */
export function PasswordResetDialog({
  org,
  member,
  onClose,
}: {
  readonly org: MeOrganization;
  readonly member: OrgMemberDto;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation('orgAdmin');
  const format = useFormatters();
  const [link, setLink] = useState<PasswordResetLink | null>(null);
  const create = useMutation({
    mutationFn: () => orgAdminApi.passwordResetLink(org.id, member.user.id),
    onSuccess: setLink,
  });
  const name = member.user.display_name;
  return (
    <Dialog
      open
      layout="sheet"
      className="max-w-lg"
      onOpenChange={(next) => {
        if (!next && !create.isPending) onClose();
      }}
      title={t('reset.title', { name })}
      description={t('reset.description')}
      closeLabel={t('page.close')}
    >
      <div className="flex flex-col gap-4" data-testid="password-reset">
        {link === null ? (
          <>
            {create.isError ? (
              <ErrorAlert
                error={create.error}
                overrides={{ PERMISSION_DENIED: 'orgAdmin:reset.denied' }}
              />
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" disabled={create.isPending} onClick={onClose}>
                {t('page.cancel')}
              </Button>
              <Button
                disabled={create.isPending}
                data-testid="password-reset-create"
                onClick={() => {
                  create.mutate();
                }}
              >
                {create.isPending ? <Spinner /> : null}
                {t('reset.create')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <Note tone="warning" icon={<TriangleAlert />}>
              {t('reset.once', { name, date: format.dateTime(link.expires_at) })}
            </Note>
            <CopyField label={t('reset.label')} value={link.reset_url} data-testid="reset-link" />
            <div className="flex justify-end">
              <Button onClick={onClose}>{t('page.done')}</Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

/**
 * "Remove from organization" (`DELETE /orgs/:id/members/:userId`): what the
 * member loses, and who takes over the bases they own (`transfer_bases_to`,
 * an owner/admin; the caller by default, always allowed by the API).
 */
export function RemoveMemberDialog({
  org,
  member,
  heirs,
  defaultHeir,
  onClose,
}: {
  readonly org: MeOrganization;
  readonly member: OrgMemberDto;
  readonly heirs: readonly OrgMemberDto[];
  readonly defaultHeir: string;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation('orgAdmin');
  const queryClient = useQueryClient();
  const [heir, setHeir] = useState(defaultHeir);
  const remove = useMutation({
    mutationFn: () => orgAdminApi.removeMember(org.id, member.user.id, heir),
    onSuccess: async () => {
      onClose();
      showToast({
        variant: 'success',
        message: t('remove.done', { name: member.user.display_name }),
      });
      await queryClient.invalidateQueries({ queryKey: keys.orgMembers(org.id) });
    },
  });
  return (
    <ConfirmDialog
      data-testid="member-remove"
      title={t('remove.title', { name: member.user.display_name, org: org.name })}
      description={t('remove.description')}
      confirmLabel={t('remove.confirm')}
      pending={remove.isPending}
      error={remove.error}
      onCancel={onClose}
      onConfirm={() => {
        remove.mutate();
      }}
    >
      <FormField label={t('remove.transferTo')} hint={t('remove.transferHint')}>
        {(control) => (
          <Select
            {...control}
            value={heir}
            onChange={(event) => {
              setHeir(event.target.value);
            }}
          >
            {heirs.map((item) => (
              <option key={item.user.id} value={item.user.id}>
                {`${item.user.display_name} (${item.user.email})`}
              </option>
            ))}
          </Select>
        )}
      </FormField>
    </ConfirmDialog>
  );
}
