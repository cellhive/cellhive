import { Button, Skeleton } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { Database, Plus } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { canCreateBase } from '../../../lib/permissions/org';
import { basesQuery } from '../api';
import { basePath } from '../hooks';

import type { MeOrganization, WorkspaceDto } from '@cellhive/contracts';

/** Loaded when first opened: react-hook-form and zod stay out of the app shell (T700). */
const CreateBaseDialog = lazy(async () => ({
  default: (await import('./CreateBaseDialog')).CreateBaseDialog,
}));

/** Bases of one workspace as cards, with "New base" when allowed. */
export function WorkspaceBaseList({
  org,
  workspace,
}: {
  org: MeOrganization;
  workspace: WorkspaceDto;
}) {
  const { t } = useTranslation('org');
  // `null` until first opened; then the dialog stays mounted (its close animates).
  const [creating, setCreating] = useState<boolean | null>(null);
  const { data, isPending, isError, error } = useQuery(basesQuery(workspace.id));
  const allowed = canCreateBase(org.role, workspace.role);
  return (
    <div className="flex flex-col gap-3">
      {isPending ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : isError ? (
        <ErrorAlert error={error} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {data.items.map((base) => (
            <li key={base.id}>
              <Link
                to={basePath(base)}
                // Lifts a little under the pointer (motion pass).
                className="flex h-full flex-col gap-1 rounded-lg border border-line bg-surface p-4 transition-[border-color,box-shadow,transform] duration-(--motion-enter) ease-(--ease-enter) hover:border-line-strong hover:shadow-sm motion-safe:hover:-translate-y-px"
              >
                <span className="flex items-center gap-2 font-medium">
                  <Database aria-hidden="true" className="size-4 shrink-0 text-accent" />
                  <span className="truncate">{base.name}</span>
                </span>
                {base.description === null ? null : (
                  <span className="line-clamp-2 text-fg-muted">{base.description}</span>
                )}
              </Link>
            </li>
          ))}
          {allowed ? (
            <li>
              <Button
                variant="secondary"
                className="h-full min-h-16 w-full border-dashed"
                aria-label={t('workspace.newBaseIn', { workspace: workspace.name })}
                onClick={() => {
                  setCreating(true);
                }}
              >
                <Plus aria-hidden="true" />
                {t('workspace.newBase')}
              </Button>
            </li>
          ) : null}
        </ul>
      )}
      {!isPending && !isError && data.items.length === 0 && !allowed ? (
        <p className="text-fg-muted">{t('workspace.noBases')}</p>
      ) : null}
      {allowed && creating !== null ? (
        <Suspense fallback={null}>
          <CreateBaseDialog workspace={workspace} open={creating} onOpenChange={setCreating} />
        </Suspense>
      ) : null}
    </div>
  );
}
