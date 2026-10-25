import { Button } from '@cellhive/ui';
import { LockKeyhole } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * `409 SCHEMA_LOCKED` (FRONTEND §4.1): the table structure is changing,
 * editing is locked; the refused write is retried every 5 s (3 times) and
 * editing opens again when the schema changes or the user asks.
 */
export function SchemaLockedBanner({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation('grid');
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-line bg-surface-sunken px-4 py-2 text-body"
    >
      <LockKeyhole aria-hidden="true" className="size-4 shrink-0 text-warning" />
      <p className="min-w-0 flex-1">{t('edit.schemaLocked')}</p>
      <Button size="sm" variant="secondary" onClick={onRetry}>
        {t('edit.unlock')}
      </Button>
    </div>
  );
}
