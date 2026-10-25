import { Button, Dialog } from '@cellhive/ui';
import { useTranslation } from 'react-i18next';

import { useFormatters } from '../../../lib/i18n/format';

export interface FieldLimitDialogProps {
  /** `errors[].params.limit` of `422 FIELD_LIMIT_EXCEEDED`, when the server sent it. */
  readonly limit: number | undefined;
  readonly onClose: () => void;
}

/**
 * The table already has the most active fields allowed
 * (`MAX_FIELDS_PER_TABLE`, FRONTEND §4.3): explain and suggest deleting
 * unused fields. Nothing is retried.
 */
export function FieldLimitDialog({ limit, onClose }: FieldLimitDialogProps) {
  const { t } = useTranslation(['field', 'common']);
  const format = useFormatters();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('field:limit.title')}
      description={
        limit === undefined
          ? t('field:limit.descriptionUnknown')
          : t('field:limit.description', { count: limit, formatted: format.number(limit) })
      }
      closeLabel={t('common:actions.close')}
    >
      <p className="text-body text-fg">{t('field:limit.hint')}</p>
      <div className="flex justify-end">
        <Button onClick={onClose}>{t('field:limit.ok')}</Button>
      </div>
    </Dialog>
  );
}
