import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useDocumentTitle } from '../../../lib/a11y/use-document-title';
import { orgPath, useRouteOrg, useRouteWorkspace } from '../hooks';

import { DeletedBases, WorkspaceActions } from './WorkspaceAdmin';
import { WorkspaceBaseList } from './WorkspaceBaseList';

/** `/o/:orgSlug/w/:workspaceId`: the bases of one workspace, its "⋯" (rename, delete) and its bases in the trash. */
export function WorkspacePage() {
  const { t } = useTranslation('org');
  const org = useRouteOrg();
  const workspace = useRouteWorkspace(org);
  useDocumentTitle(workspace.name);
  return (
    <div className="flex flex-col gap-6 p-6 lg:p-8">
      <nav aria-label={t('workspace.breadcrumb')}>
        <ol className="flex items-center gap-2 text-fg-muted">
          <li>
            <Link to={orgPath(org)} className="hover:underline">
              {org.name}
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="text-fg">
            {workspace.name}
          </li>
        </ol>
      </nav>
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="text-title break-words">{workspace.name}</h1>
          <p className="text-fg-muted">{t('workspace.subtitle')}</p>
        </div>
        <WorkspaceActions org={org} workspace={workspace} />
      </div>
      <WorkspaceBaseList org={org} workspace={workspace} />
      <DeletedBases workspace={workspace} />
    </div>
  );
}

export default WorkspacePage;
