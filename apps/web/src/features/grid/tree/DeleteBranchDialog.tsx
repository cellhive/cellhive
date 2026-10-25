import { Button, cn, Dialog } from '@cellhive/ui';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { TreeDeleteRequest } from './use-grid-tree';
import type { SubrecordDeleteMode } from '@cellhive/contracts';

/** The default fate of the sub-records: they become roots. */
const PROMOTE: SubrecordDeleteMode = 'promote';

export interface DeleteBranchDialogProps {
  readonly request: TreeDeleteRequest | null;
  readonly tableName: string;
  /** The chosen fate of the sub-records, `null` when cancelled. */
  readonly onResolve: (children: SubrecordDeleteMode | null) => void;
}

/**
 * Deleting records of a tree (T417, SPEC §5.7, BACKLOG S4 open question
 * #11): the usual confirmation; when the records have sub-records it also
 * asks what happens to them — "keep them as top-level records" (the
 * default, `promote`) or "delete the whole branch" (`delete`: restored
 * together from the trash).
 */
export function DeleteBranchDialog({ request, tableName, onResolve }: DeleteBranchDialogProps) {
  const { t } = useTranslation(['tree', 'grid']);
  const [mode, setMode] = useState<SubrecordDeleteMode>('promote');
  const [busy, setBusy] = useState(false);
  const groupId = useId();
  const count = request?.ids.length ?? 0;
  const children = request?.children ?? 0;
  const option = (value: SubrecordDeleteMode, label: string, hint: string) => (
    <label
      className={cn(
        'flex min-h-control cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5',
        mode === value ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-sunken',
      )}
    >
      <input
        type="radio"
        name={groupId}
        value={value}
        checked={mode === value}
        className="mt-0.5 size-4 shrink-0"
        onChange={() => {
          setMode(value);
        }}
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-body font-medium text-fg">{label}</span>
        <span className="text-label font-normal text-fg-muted">{hint}</span>
      </span>
    </label>
  );
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open && !busy) {
          setMode('promote');
          onResolve(null);
        }
      }}
      title={t('grid:actions.confirmTitle', { count })}
      description={t('grid:actions.confirmDescription', { count, table: tableName })}
      closeLabel={t('grid:actions.cancel')}
    >
      {children > 0 ? (
        <fieldset className="mb-4 flex flex-col gap-2" data-testid="tree-delete-choice">
          <legend className="mb-2 text-body font-medium text-fg">
            {count > 1
              ? t('tree:delete.legendMany', { count: children })
              : t('tree:delete.legendOne', { count: children })}
          </legend>
          {option('promote', t('tree:delete.promote'), t('tree:delete.promoteHint'))}
          {option(
            'delete',
            t('tree:delete.branch'),
            t('tree:delete.branchHint', { count: children }),
          )}
        </fieldset>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            setMode('promote');
            onResolve(null);
          }}
        >
          {t('grid:actions.cancel')}
        </Button>
        <Button
          variant="danger"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            const chosen = children > 0 ? mode : PROMOTE;
            setMode(PROMOTE);
            onResolve(chosen);
            setBusy(false);
          }}
        >
          {children > 0 && mode === 'delete'
            ? t('tree:delete.confirmBranch')
            : t('grid:actions.confirmDelete', { count })}
        </Button>
      </div>
    </Dialog>
  );
}
