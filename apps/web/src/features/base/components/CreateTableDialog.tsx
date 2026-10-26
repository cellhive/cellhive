import { MAX_SCHEMA_NAME_LENGTH } from '@cellhive/contracts';
import { Button, Dialog, FormField, Input, Spinner } from '@cellhive/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { api } from '../../../lib/api';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { keys } from '../../../lib/query/keys';

export interface CreateTableDialogProps {
  readonly baseId: string;
  /** Tables the base has now: the default name numbers the new one after them. */
  readonly tableCount: number;
  readonly onClose: () => void;
}

/**
 * "New table" of the base sidebar and of an empty base, base admins only
 * (`canManageSchema` without a table; the API answers `403` to others): a
 * name → `POST /bases/:id/tables`, which makes the primary `Name` field and
 * a grid view, then opens the table. A name in use shows `409 NAME_CONFLICT`.
 */
export function CreateTableDialog({ baseId, tableCount, onClose }: CreateTableDialogProps) {
  const { t } = useTranslation(['base', 'common']);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(() => t('base:tables.defaultName', { n: tableCount + 1 }));
  const create = useMutation({
    mutationFn: () => api.tables.create(baseId, { name: name.trim() }),
    onSuccess: async (table) => {
      await queryClient.invalidateQueries({ queryKey: keys.tables(baseId) });
      await navigate(`/b/${encodeURIComponent(baseId)}/t/${encodeURIComponent(table.id)}`);
      onClose();
    },
  });
  const empty = name.trim() === '';
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !create.isPending) onClose();
      }}
      title={t('base:tables.new')}
      closeLabel={t('common:actions.close')}
      className="max-w-md"
    >
      <form
        className="flex flex-col gap-4"
        data-testid="create-table-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (!empty) create.mutate();
        }}
      >
        <FormField label={t('base:tables.name')} hint={t('base:tables.createHint')}>
          {(control) => (
            <Input
              {...control}
              autoFocus
              onFocus={(event) => {
                event.currentTarget.select();
              }}
              maxLength={MAX_SCHEMA_NAME_LENGTH}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </FormField>
        {create.isError ? <ErrorAlert error={create.error} /> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" disabled={create.isPending} onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" disabled={empty || create.isPending}>
            {create.isPending ? <Spinner /> : null}
            {t('base:tables.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export default CreateTableDialog;
