import { Button, Skeleton } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { FolderPlus, Settings } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useDocumentTitle } from '../../../lib/a11y/use-document-title';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { canCreateWorkspace } from '../../../lib/permissions/org';
import { workspacesQuery } from '../api';
import { orgPath, useRouteOrg, workspacePath } from '../hooks';

import { WorkspaceBaseList } from './WorkspaceBaseList';

/** Loaded when first opened: react-hook-form and zod stay out of the app shell (T700). */
const CreateWorkspaceDialog = lazy(async () => ({
  default: (await import('./CreateWorkspaceDialog')).CreateWorkspaceDialog,
}));

/** `/o/:orgSlug`: every workspace of the organization with its bases. */
export function OrgHomePage() {
  const { t } = useTranslation('org');
  const org = useRouteOrg();
  // `null` until first opened; then the dialog stays mounted (its close animates).
  const [creating, setCreating] = useState<boolean | null>(null);
  const { data, isPending, isError, error } = useQuery(workspacesQuery(org.id));
  const allowed = canCreateWorkspace(org.role);
  useDocumentTitle(org.name);

  return (
    <div className="flex flex-col gap-8 p-6 lg:p-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-title">{org.name}</h1>
          <p className="text-fg-muted">{t('home.subtitle')}</p>
        </div>
        {allowed ? (
          <div className="flex flex-wrap gap-2">
            {/* T830: members, groups, email, share links… of the organization (FRONTEND §15.0). */}
            <Button variant="secondary" asChild>
              <Link to={`${orgPath(org)}/settings`} data-testid="org-settings-open">
                <Settings aria-hidden="true" />
                {t('home.settings')}
              </Link>
            </Button>
            <Button
              onClick={() => {
                setCreating(true);
              }}
            >
              <FolderPlus aria-hidden="true" />
              {t('home.newWorkspace')}
            </Button>
          </div>
        ) : null}
      </div>

      {isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-20" />
        </div>
      ) : isError ? (
        <ErrorAlert error={error} />
      ) : data.items.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-line-strong p-6">
          <h2 className="text-heading">{t('home.emptyTitle')}</h2>
          <p className="text-fg-muted">{allowed ? t('home.emptyAdmin') : t('home.emptyMember')}</p>
          {allowed ? (
            <Button
              onClick={() => {
                setCreating(true);
              }}
            >
              <FolderPlus aria-hidden="true" />
              {t('home.newWorkspace')}
            </Button>
          ) : null}
        </div>
      ) : (
        data.items.map((workspace) => (
          <section
            key={workspace.id}
            className="flex flex-col gap-3"
            aria-labelledby={workspace.id}
          >
            <h2 id={workspace.id} className="text-heading">
              <Link to={workspacePath(org, workspace)} className="hover:underline">
                {workspace.name}
              </Link>
            </h2>
            <WorkspaceBaseList org={org} workspace={workspace} />
          </section>
        ))
      )}
      {allowed && creating !== null ? (
        <Suspense fallback={null}>
          <CreateWorkspaceDialog org={org} open={creating} onOpenChange={setCreating} />
        </Suspense>
      ) : null}
    </div>
  );
}

export default OrgHomePage;
