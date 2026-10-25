import { Button, Dialog, FormField, Input, Spinner } from '@cellhive/ui';
import { CircleX, Link2, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { isApiError } from '../../../lib/api/client';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { ComputedDependents } from '../../../lib/schema/ComputedDependents';

import type { TableDto, TrashedTableDto } from '@cellhive/contracts';

export interface PurgeTableDialogProps {
  readonly baseId: string;
  readonly table: TrashedTableDto;
  /** Active tables of the base ("in <table>" of the partner fields). */
  readonly tables: readonly TableDto[];
  readonly pending: boolean;
  readonly error: unknown;
  readonly onCancel: () => void;
  readonly onConfirm: (confirmName: string) => void;
}

/** The server compares the typed name exactly after NFC and trimming (CONTRACTS §13). */
export function confirmsName(typed: string, name: string): boolean {
  return typed.normalize('NFC').trim() === name.normalize('NFC');
}

/**
 * (T469; board "S4b · Thùng rác base, xoá vĩnh viễn bảng") Destructive
 * confirmation of "Delete permanently" of a table of the base trash: what
 * goes for good, the link fields of other tables deleted with it (never
 * restorable: `LINK_TABLE_PURGED`), the formula/lookup fields that keep
 * showing `#REF!`, and the table name to type before the red button works.
 * Base admins only (the page is theirs).
 */
export function PurgeTableDialog({
  baseId,
  table,
  tables,
  pending,
  error,
  onCancel,
  onConfirm,
}: PurgeTableDialogProps) {
  const { t, i18n } = useTranslation(['trash', 'common']);
  const [typed, setTyped] = useState('');
  const hintId = useId();
  const numbers = new Intl.NumberFormat(i18n.language);
  const ready = confirmsName(typed, table.name);
  const mismatch =
    isApiError(error) && error.errors.some((item) => item.code === 'CONFIRM_NAME_MISMATCH');
  const partners = table.partner_fields;
  const tableName = (id: string) => tables.find((item) => item.id === id)?.name;
  const submit = () => {
    if (ready && !pending) onConfirm(typed);
  };
  return (
    <Dialog
      open
      role="alertdialog"
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
      title={t('trash:tables.purge.title', { name: table.name })}
      description={
        <>
          {t('trash:tables.purge.description', {
            count: table.field_count,
            formatted: numbers.format(table.field_count),
          })}{' '}
          <strong className="font-semibold text-fg">{t('trash:tables.purge.irreversible')}</strong>
        </>
      }
      closeLabel={t('trash:purge.cancel')}
      className="max-w-[640px]"
      layout="sheet"
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        data-testid="purge-table-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {partners.length > 0 ? (
          <section aria-labelledby={`${hintId}-links`} className="flex flex-col gap-1.5">
            <h4
              id={`${hintId}-links`}
              className="flex items-center gap-1.5 text-label font-semibold text-fg"
            >
              <CircleX aria-hidden="true" className="size-4 shrink-0 text-danger" />
              {t('trash:tables.purge.partners', {
                count: partners.length,
                formatted: numbers.format(partners.length),
              })}
            </h4>
            <ul
              className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface"
              data-testid="purge-table-partners"
            >
              {partners.map((field) => {
                const where = tableName(field.table_id);
                return (
                  <li key={field.id} className="flex items-center gap-3 px-3 py-2">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-fg-muted">
                      <Link2 aria-hidden="true" className="size-4" />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-body">
                        <span className="font-medium text-fg">{field.name}</span>
                        {where === undefined ? null : (
                          <span className="text-fg-muted">
                            {' '}
                            {t('common:dependents.inTable', { table: where })}
                          </span>
                        )}
                      </span>
                      <span className="text-label font-normal text-fg-muted">
                        {field.in_trash
                          ? t('trash:tables.purge.partnerInTrash')
                          : t(`trash:tables.purge.partnerKind.${field.kind}`)}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
        <ComputedDependents
          baseId={baseId}
          dependents={table.computed_fields}
          token="#REF!"
          data-testid="purge-table-computed"
        />
        <FormField
          label={
            <Trans
              t={t}
              i18nKey="trash:tables.purge.typeName"
              values={{ name: table.name }}
              components={{ strong: <strong className="font-semibold text-fg" /> }}
            />
          }
          error={mismatch ? t('trash:tables.purge.mismatch') : undefined}
        >
          {(control) => (
            <Input
              {...control}
              autoComplete="off"
              spellCheck={false}
              value={typed}
              data-testid="purge-table-name"
              onChange={(event) => {
                setTyped(event.target.value);
              }}
            />
          )}
        </FormField>
        {error !== null && error !== undefined && !mismatch ? <ErrorAlert error={error} /> : null}
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 text-label font-normal text-fg-muted">
            {t('trash:tables.purge.adminsOnly')}
          </span>
          <Button variant="secondary" disabled={pending} onClick={onCancel}>
            {t('trash:purge.cancel')}
          </Button>
          <Button
            type="submit"
            variant="danger"
            disabled={!ready || pending}
            data-testid="purge-table-confirm"
          >
            {pending ? <Spinner /> : <Trash2 aria-hidden="true" />}
            {t('trash:tables.purge.confirm')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
