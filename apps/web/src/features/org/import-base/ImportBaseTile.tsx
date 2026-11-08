import { Button } from '@cellhive/ui';
import { PackagePlus } from 'lucide-react';
import { Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { lazyOverlay } from '../../../lib/lazy/chunk-error';

import type { WorkspaceDto } from '@cellhive/contracts';

/** Loaded when first opened: the upload, the job and the report stay out of the page. */
const ImportBaseDialog = lazyOverlay(() => import('./ImportBaseDialog'));

/**
 * "Import base · From a .chbase file" beside "New base" on the workspace
 * page (FRONTEND §17.5): an import creates a base in this workspace, with
 * the same permission as "New base" (workspace admins, organization
 * owners/admins — the list shows it only to them). The dialog stays
 * mounted once opened, so an import still running shows again.
 */
export function ImportBaseTile({ workspace }: { readonly workspace: WorkspaceDto }) {
  const { t } = useTranslation('workspace');
  // `null` until first opened; then the dialog stays mounted (its close animates).
  const [open, setOpen] = useState<boolean | null>(null);
  const [opened, setOpened] = useState(0);
  return (
    <>
      <Button
        variant="secondary"
        className="h-full min-h-16 w-full flex-col gap-0.5 border-dashed"
        aria-label={t('import.actionLabel')}
        data-testid="import-base-open"
        onClick={() => {
          setOpened((count) => count + 1);
          setOpen(true);
        }}
      >
        <span className="flex items-center gap-2">
          <PackagePlus aria-hidden="true" />
          {t('import.action')}
        </span>
        <span className="text-label font-normal text-fg-muted">{t('import.actionHint')}</span>
      </Button>
      {open === null ? null : (
        <Suspense fallback={null}>
          <ImportBaseDialog
            workspace={workspace}
            open={open}
            opened={opened}
            onOpenChange={setOpen}
          />
        </Suspense>
      )}
    </>
  );
}
