import { createFieldRequestSchema, type FieldDto } from '@cellhive/contracts';
import { Button, Dialog, FormField, Input, Spinner } from '@cellhive/ui';
import { useState, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../lib/api/client';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { issueToDetail } from '../../../lib/forms/zod-form';
import { useUpdateField } from '../mutations';

import { useIssueText } from './shared';

import type { DraftIssue } from '../draft';

const nameSchema = createFieldRequestSchema.shape.name;
const NAME_PATHS = ['name'] as const;

export interface RenameFieldDialogProps {
  readonly tableId: string;
  readonly field: FieldDto;
  readonly onClose: () => void;
}

/** Rename from the header menu (`PATCH /fields/:id { name }`); a taken name is shown inline. */
export function RenameFieldDialog({ tableId, field, onClose }: RenameFieldDialogProps) {
  const { t } = useTranslation(['field', 'common']);
  const issueText = useIssueText();
  const [name, setName] = useState(field.name);
  const [issue, setIssue] = useState<DraftIssue | undefined>(undefined);
  const update = useUpdateField(tableId);
  const conflict =
    isApiError(update.error) && update.error.code === 'NAME_CONFLICT'
      ? ({ path: 'name', detail: { code: 'NAME_CONFLICT' } } as const)
      : undefined;
  const shown = issue ?? conflict;

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = nameSchema.safeParse(name, { reportInput: true });
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      setIssue(first === undefined ? undefined : { path: 'name', detail: issueToDetail(first) });
      return;
    }
    if (parsed.data === field.name) {
      onClose();
      return;
    }
    update.mutate({ fieldId: field.id, body: { name: parsed.data } }, { onSuccess: onClose });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('field:rename.title')}
      closeLabel={t('common:actions.close')}
    >
      <form noValidate className="flex flex-col gap-4" onSubmit={onSubmit}>
        <FormField label={t('field:name')} error={issueText(shown)}>
          {(control) => (
            <Input
              {...control}
              autoComplete="off"
              maxLength={255}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setIssue(undefined);
                if (update.error !== null) update.reset();
              }}
            />
          )}
        </FormField>
        {update.error !== null && conflict === undefined ? (
          <ErrorAlert error={update.error} hidePaths={NAME_PATHS} />
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" disabled={update.isPending}>
            {update.isPending ? <Spinner /> : null}
            {t('field:rename.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
