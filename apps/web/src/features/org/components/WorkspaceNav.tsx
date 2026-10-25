import { Button, cn, Skeleton } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Database, Plus } from 'lucide-react';
import { lazy, Suspense, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router';

import { canCreateWorkspace } from '../../../lib/permissions/org';
import { basesQuery, workspacesQuery } from '../api';
import { basePath, workspacePath } from '../hooks';

import type { MeOrganization, WorkspaceDto } from '@cellhive/contracts';

/** Loaded when first opened: react-hook-form and zod stay out of the app shell (T700). */
const CreateWorkspaceDialog = lazy(async () => ({
  default: (await import('./CreateWorkspaceDialog')).CreateWorkspaceDialog,
}));

const linkClasses = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-body text-fg hover:bg-surface-sunken',
    isActive && 'bg-accent-soft font-medium',
  );

/**
 * (T524) Extra "…" menu of a base row, given by the app shell (features do
 * not import each other, FRONTEND §1.2): mute the base's notifications.
 */
export type BaseMenuRenderer = (base: { id: string; name: string }) => ReactNode;

function WorkspaceBases({
  workspace,
  id,
  baseMenu,
}: {
  workspace: WorkspaceDto;
  id: string;
  baseMenu: BaseMenuRenderer | undefined;
}) {
  const { t } = useTranslation('common');
  const { data, isPending, isError } = useQuery(basesQuery(workspace.id));
  if (isPending) {
    return (
      <div id={id} className="flex flex-col gap-1 py-1 pl-8">
        <Skeleton className="h-6" />
      </div>
    );
  }
  if (isError) {
    return (
      <p id={id} className="py-1 pl-8 text-label font-normal text-fg-muted">
        {t('nav.loadFailed')}
      </p>
    );
  }
  if (data.items.length === 0) {
    return (
      <p id={id} className="py-1 pl-8 text-label font-normal text-fg-muted">
        {t('nav.noBases')}
      </p>
    );
  }
  return (
    <ul id={id} className="flex flex-col gap-0.5 py-0.5 pl-6">
      {data.items.map((base) => (
        <li key={base.id} className="group/base relative flex">
          <NavLink
            to={basePath(base)}
            className={(state) => cn(linkClasses(state), baseMenu !== undefined && 'pr-9')}
          >
            <Database aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
            <span className="truncate">{base.name}</span>
          </NavLink>
          {baseMenu?.({ id: base.id, name: base.name })}
        </li>
      ))}
    </ul>
  );
}

function WorkspaceItem({
  org,
  workspace,
  baseMenu,
}: {
  org: MeOrganization;
  workspace: WorkspaceDto;
  baseMenu: BaseMenuRenderer | undefined;
}) {
  const { t } = useTranslation('common');
  const [expanded, setExpanded] = useState(true);
  const listId = useId();
  return (
    <li>
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-label={t(expanded ? 'nav.collapse' : 'nav.expand', { name: workspace.name })}
          onClick={() => {
            setExpanded((value) => !value);
          }}
        >
          <ChevronRight
            aria-hidden="true"
            className={cn('transition-transform', expanded && 'rotate-90')}
          />
        </Button>
        <NavLink end to={workspacePath(org, workspace)} className={linkClasses}>
          <span className="truncate">{workspace.name}</span>
        </NavLink>
      </div>
      {expanded ? <WorkspaceBases workspace={workspace} id={listId} baseMenu={baseMenu} /> : null}
    </li>
  );
}

/** Sidebar tree: workspaces of the organization → their bases (FRONTEND §2). */
export function WorkspaceNav({
  org,
  baseMenu,
}: {
  org: MeOrganization;
  baseMenu?: BaseMenuRenderer | undefined;
}) {
  const { t } = useTranslation('common');
  // `null` until first opened; then the dialog stays mounted (its close animates).
  const [creating, setCreating] = useState<boolean | null>(null);
  const { data, isPending, isError } = useQuery(workspacesQuery(org.id));
  const headingId = useId();
  return (
    <nav aria-labelledby={headingId} className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 px-2">
        <h2 id={headingId} className="text-label text-fg-muted">
          {t('nav.workspaces')}
        </h2>
        {canCreateWorkspace(org.role) ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t('nav.createWorkspace')}
            onClick={() => {
              setCreating(true);
            }}
          >
            <Plus aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {isPending ? (
        <div className="flex flex-col gap-2 px-2">
          <Skeleton className="h-6" />
          <Skeleton className="h-6" />
        </div>
      ) : isError ? (
        <p className="px-2 text-label font-normal text-fg-muted">{t('nav.loadFailed')}</p>
      ) : data.items.length === 0 ? (
        <p className="px-2 text-label font-normal text-fg-muted">{t('nav.noWorkspaces')}</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {data.items.map((workspace) => (
            <WorkspaceItem key={workspace.id} org={org} workspace={workspace} baseMenu={baseMenu} />
          ))}
        </ul>
      )}
      {creating === null ? null : (
        <Suspense fallback={null}>
          <CreateWorkspaceDialog org={org} open={creating} onOpenChange={setCreating} />
        </Suspense>
      )}
    </nav>
  );
}
