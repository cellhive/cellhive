import { Button, cn, Dialog, Spinner } from '@cellhive/ui';
import { queryOptions, useSuspenseQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { orgAdminApi } from '../../../lib/api/org-admin';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { PAGE_GUTTER, PageHeading } from '../../../lib/layout/page-heading';
import { notFound } from '../../../lib/navigation/not-found';
import { keys } from '../../../lib/query/keys';
import { meQuery } from '../../../lib/session/session';

import type { MeOrganization } from '@cellhive/contracts';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * The organization of `/o/:orgSlug/settings/*` and the caller's user ID. The
 * layout route's guard (`orgSettings`) has let owners/admins only.
 */
export function useSettingsOrg(): { readonly org: MeOrganization; readonly userId: string } {
  const { orgSlug } = useParams();
  const { data } = useSuspenseQuery(meQuery());
  const org = data?.orgs.find((item) => item.slug === orgSlug);
  if (data === null || org === undefined) notFound();
  return { org, userId: data.user.id };
}

/** Pending invitations (`GET /orgs/:id/invitations?status=pending`): owners/admins. */
export const invitationsQuery = (orgId: string) =>
  queryOptions({
    queryKey: ['org', orgId, 'invitations'] as const,
    queryFn: ({ signal }) => orgAdminApi.pendingInvitations(orgId, signal),
  });

/** Under `keys.orgGroups`: refreshing the group list refreshes its members too. */
export const groupMembersQuery = (orgId: string, groupId: string) =>
  queryOptions({
    queryKey: [...keys.orgGroups(orgId), groupId, 'members'] as const,
    queryFn: ({ signal }) => orgAdminApi.groupMembers(groupId, signal),
  });

/** An organization settings page: heading with "Back to <org>", then the body. */
export function AdminPage({
  org,
  icon,
  title,
  subtitle,
  actions,
  narrow = false,
  children,
}: {
  readonly org: MeOrganization;
  readonly icon: LucideIcon;
  readonly title: string;
  readonly subtitle?: string;
  readonly actions?: ReactNode;
  /** A form page: a readable width instead of the full width of the tables. */
  readonly narrow?: boolean;
  readonly children: ReactNode;
}) {
  const { t } = useTranslation('orgAdmin');
  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <PageHeading
        back={{
          to: `/o/${encodeURIComponent(org.slug)}`,
          label: t('page.back', { name: org.name }),
        }}
        icon={icon}
        title={title}
        subtitle={subtitle}
        actions={actions}
      />
      <div className={cn('flex flex-col gap-6 py-6', narrow && 'max-w-3xl', PAGE_GUTTER)}>
        {children}
      </div>
    </div>
  );
}

/** A confirmation of a destructive action (`alertdialog`): what is lost, Cancel, the action. */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  pending,
  error,
  children,
  onConfirm,
  onCancel,
  'data-testid': testId,
}: {
  readonly title: string;
  readonly description: ReactNode;
  readonly confirmLabel: string;
  readonly pending: boolean;
  readonly error: unknown;
  readonly children?: ReactNode;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly 'data-testid'?: string;
}) {
  const { t } = useTranslation('orgAdmin');
  return (
    <Dialog
      open
      role="alertdialog"
      layout="sheet"
      className="max-w-lg"
      onOpenChange={(next) => {
        if (!next && !pending) onCancel();
      }}
      title={title}
      description={description}
      closeLabel={t('page.close')}
    >
      <div className="flex flex-col gap-4" data-testid={testId}>
        {children}
        {error === null ? null : <ErrorAlert error={error} />}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={pending} onClick={onCancel}>
            {t('page.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={pending}
            data-testid={testId === undefined ? undefined : `${testId}-confirm`}
            onClick={onConfirm}
          >
            {pending ? <Spinner /> : null}
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Table cell classes shared by the member, invitation and group tables. */
export const TH = 'h-[34px] px-3 text-left text-label font-medium whitespace-nowrap text-fg-muted';
export const TD = 'px-3 py-2.5 align-middle';
