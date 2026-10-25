import { createViewRequestSchema, type ViewDto } from '@cellhive/contracts';
import { Button, Dialog, FormField, Input, Spinner } from '@cellhive/ui';
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../lib/api/client';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { translateDetail } from '../../../lib/errors/translate';
import { issueToDetail } from '../../../lib/forms/zod-form';
import { useUpdateView } from '../mutations';

const nameSchema = createViewRequestSchema.shape.name;
const NAME_PATHS = ['name'] as const;

export interface RenameViewDialogProps {
  readonly view: ViewDto;
  readonly onClose: () => void;
}

/**
 * `PATCH /views/:id { name }`; a name taken in the group is shown under the
 * input. The dialog opens with the current name selected.
 */
export function RenameViewDialog({ view, onClose }: RenameViewDialogProps) {
  const { t, i18n } = useTranslation(['view', 'common', 'errors']);
  const [name, setName] = useState(view.name);
  const [issue, setIssue] = useState<string | undefined>(undefined);
  const update = useUpdateView(view.table_id);
  // The old name starts selected: typing replaces it (QA S3).
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.select();
  }, []);
  const conflict =
    isApiError(update.error) && update.error.code === 'NAME_CONFLICT'
      ? t('errors:codes.NAME_CONFLICT')
      : undefined;

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = nameSchema.safeParse(name, { reportInput: true });
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      setIssue(first === undefined ? undefined : translateDetail(i18n, issueToDetail(first)));
      return;
    }
    if (parsed.data === view.name) {
      onClose();
      return;
    }
    update.mutate({ viewId: view.id, body: { name: parsed.data } }, { onSuccess: onClose });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('view:rename.title')}
      closeLabel={t('common:actions.close')}
    >
      <form noValidate className="flex flex-col gap-4" onSubmit={onSubmit}>
        <FormField label={t('view:rename.name')} error={issue ?? conflict}>
          {(control) => (
            <Input
              {...control}
              ref={input}
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
            {t('view:rename.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
