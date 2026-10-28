import {
  Button,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  FormField,
  Input,
  Spinner,
} from '@cellhive/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { baseAdminApi } from '../../../lib/api/base-admin';
import { workspaceAdminApi } from '../../../lib/api/workspace-admin';
import { BaseIcon } from '../../../lib/brand/BaseIcon';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../lib/i18n/format';
import { canCreateBase, isOrgAdmin } from '../../../lib/permissions/org';
import { keys } from '../../../lib/query/keys';
import { showErrorToast, showToast } from '../../../lib/toast/toast';
import { basePath, orgPath } from '../hooks';

import type { MeOrganization, WorkspaceDto } from '@cellhive/contracts';

/** The limit of `updateWorkspaceRequestSchema` (SPEC §13.1). */
const NAME_MAX = 100;

/**
 * "⋯" of the workspace page: rename (workspace admins, organization
 * owners/admins) and delete (organization owners/admins; the API refuses a
 * workspace that still has bases, in the trash too, and the dialog says so).
 */
export function WorkspaceActions({
  org,
  workspace,
}: {
  readonly org: MeOrganization;
  readonly workspace: WorkspaceDto;
}) {
  const { t } = useTranslation('workspace');
  const [open, setOpen] = useState<'rename' | 'delete' | null>(null);
  // Who may rename is who may create bases here (SPEC §14.1).
  if (!canCreateBase(org.role, workspace.role)) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('menu', { name: workspace.name })}
            data-testid="workspace-menu"
          >
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() => {
              setOpen('rename');
            }}
          >
            <Pencil aria-hidden="true" />
            {t('rename.action')}
          </DropdownMenuItem>
          {isOrgAdmin(org.role) ? (
            <DropdownMenuItem
              className="text-danger [&_svg]:text-danger"
              onSelect={() => {
                setOpen('delete');
              }}
            >
              <Trash2 aria-hidden="true" />
              {t('delete.action')}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {open === 'rename' ? (
        <RenameDialog
          org={org}
          workspace={workspace}
          onClose={() => {
            setOpen(null);
          }}
        />
      ) : null}
      {open === 'delete' ? (
        <DeleteDialog
          org={org}
          workspace={workspace}
          onClose={() => {
            setOpen(null);
          }}
        />
      ) : null}
    </>
  );
}

function RenameDialog({
  org,
  workspace,
  onClose,
}: {
  readonly org: MeOrganization;
  readonly workspace: WorkspaceDto;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation(['workspace', 'common']);
  const queryClient = useQueryClient();
  const [name, setName] = useState(workspace.name);
  const save = useMutation({
    mutationFn: () => workspaceAdminApi.rename(org.id, workspace.id, { name: name.trim() }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(keys.workspace(workspace.id), updated);
      await queryClient.invalidateQueries({ queryKey: keys.workspaces(org.id) });
      showToast({ variant: 'success', message: t('workspace:rename.saved') });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !save.isPending) onClose();
      }}
      title={t('workspace:rename.title')}
      closeLabel={t('common:actions.close')}
      className="max-w-md"
    >
      <form
        className="flex flex-col gap-4"
        data-testid="rename-workspace-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() !== '') save.mutate();
        }}
      >
        <FormField label={t('workspace:rename.name')}>
          {(control) => (
            <Input
              {...control}
              autoFocus
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
            {t('common:actions.cancel')}
          </Button>
          <Button
            type="submit"
            disabled={name.trim() === '' || name.trim() === workspace.name || save.isPending}
          >
            {save.isPending ? <Spinner /> : null}
            {t('workspace:rename.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteDialog({
  org,
  workspace,
  onClose,
}: {
  readonly org: MeOrganization;
  readonly workspace: WorkspaceDto;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation(['workspace', 'common']);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const remove = useMutation({
    mutationFn: () => workspaceAdminApi.remove(org.id, workspace.id),
    onSuccess: async () => {
      await navigate(orgPath(org), { replace: true });
      queryClient.removeQueries({ queryKey: keys.workspace(workspace.id) });
      await queryClient.invalidateQueries({ queryKey: keys.workspaces(org.id) });
      showToast({
        variant: 'success',
        message: t('workspace:delete.deleted', { name: workspace.name }),
      });
    },
  });
  return (
    <Dialog
      open
      role="alertdialog"
      onOpenChange={(next) => {
        if (!next && !remove.isPending) onClose();
      }}
      title={t('workspace:delete.title', { name: workspace.name })}
      description={t('workspace:delete.description')}
      closeLabel={t('common:actions.close')}
      className="max-w-md"
    >
      <div className="flex flex-col gap-4" data-testid="delete-workspace-dialog">
        {remove.isError ? <ErrorAlert error={remove.error} /> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" disabled={remove.isPending} onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={remove.isPending}
            data-testid="delete-workspace-confirm"
            onClick={() => {
              remove.mutate();
            }}
          >
            {remove.isPending ? <Spinner /> : null}
            {t('workspace:delete.submit')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Bases of the workspace in the trash that the caller may restore (the API
 * lists all of them for workspace and organization admins, their own for
 * others). Nothing shows while there are none. Under `keys.bases`, so
 * deleting or restoring a base anywhere refreshes it.
 */
export function DeletedBases({ workspace }: { readonly workspace: WorkspaceDto }) {
  const { t } = useTranslation('workspace');
  const format = useFormatters();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: [...keys.bases(workspace.id), 'with-deleted'],
    queryFn: ({ signal }) => workspaceAdminApi.basesWithDeleted(workspace.id, signal),
  });
  const [pending, setPending] = useState<string | null>(null);
  const deleted = (data?.items ?? []).filter((base) => base.deleted_at !== null);
  if (deleted.length === 0) return null;

  const restore = async (base: (typeof deleted)[number]) => {
    setPending(base.id);
    try {
      await baseAdminApi.restore(base.id);
      await queryClient.invalidateQueries({ queryKey: keys.bases(workspace.id) });
      showToast({
        variant: 'success',
        message: t('trash.restored', { name: base.name }),
        actions: [
          {
            label: t('trash.open'),
            primary: true,
            onClick: () => {
              void navigate(basePath(base));
            },
          },
        ],
      });
    } catch (error) {
      showErrorToast(error);
    } finally {
      setPending(null);
    }
  };

  return (
    <section aria-labelledby="deleted-bases-heading" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="deleted-bases-heading" className="text-heading">
          {t('trash.title')}
        </h2>
        <p className="text-label font-normal text-fg-muted">{t('trash.hint')}</p>
      </div>
      <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
        {deleted.map((base) => (
          <li
            key={base.id}
            className="flex flex-wrap items-center gap-3 px-4 py-3"
            data-testid={`deleted-base-${base.id}`}
          >
            <BaseIcon base={base} size="sm" className="grayscale" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">{base.name}</span>
              <span className="text-label font-normal text-fg-muted">
                {t('trash.deletedAt', { date: format.dateTime(base.deleted_at ?? '') })}
              </span>
            </span>
            <Button
              variant="secondary"
              disabled={pending !== null}
              aria-label={t('trash.restoreName', { name: base.name })}
              onClick={() => {
                void restore(base);
              }}
            >
              {pending === base.id ? <Spinner /> : null}
              {t('trash.restore')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
