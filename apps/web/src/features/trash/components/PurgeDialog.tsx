import { Alert, Button, Checkbox, Dialog, Spinner } from '@cellhive/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/** What the user asked to delete for good. */
export interface PurgeRequest {
  readonly ids: readonly string[];
  /** Sub-records deleted together with these records and still in the trash (T405). */
  readonly branchSize: number;
}

export interface PurgeDialogProps {
  readonly request: PurgeRequest | null;
  readonly pending: boolean;
  readonly onCancel: () => void;
  /** `branch`: the sub-records deleted together go too. */
  readonly onConfirm: (branch: boolean) => void;
}

/**
 * Destructive confirmation of "Delete permanently" in the trash (T408,
 * FRONTEND §10.4): says how many records go and that it cannot be undone;
 * records deleted with their sub-records offer to take the branch too
 * (off by default: the sub-records then stay in the trash as roots). The
 * caller gives each request its own `key`, so the choice starts fresh.
 */
export function PurgeDialog({ request, pending, onCancel, onConfirm }: PurgeDialogProps) {
  const { t } = useTranslation('trash');
  const [branch, setBranch] = useState(false);
  const count = request?.ids.length ?? 0;
  const branchSize = request?.branchSize ?? 0;
  const close = () => {
    if (pending) return;
    setBranch(false);
    onCancel();
  };
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t('purge.title', { count })}
      description={t('purge.description', { count })}
      closeLabel={t('purge.cancel')}
    >
      <div className="flex flex-col gap-4" data-testid="purge-dialog">
        <Alert variant="danger" role="note">
          {t('purge.irreversible')}
        </Alert>
        {branchSize > 0 ? (
          <Checkbox
            label={t('purge.branch', { count: branchSize })}
            hint={t('purge.branchHint')}
            checked={branch}
            disabled={pending}
            onChange={(event) => {
              setBranch(event.target.checked);
            }}
          />
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={pending} onClick={close}>
            {t('purge.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={pending}
            data-testid="purge-confirm"
            onClick={() => {
              onConfirm(branchSize > 0 && branch);
            }}
          >
            {pending ? <Spinner /> : null}
            {t('purge.confirm', { count: count + (branch ? branchSize : 0) })}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
