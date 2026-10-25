import { useQuery } from '@tanstack/react-query';
import { Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../lib/api/client';
import { tableQuery } from '../../../lib/query/queries';
import { showErrorToast, showToast } from '../../../lib/toast/toast';
import { RevertConversionDialog } from '../convert/RevertConversionDialog';
import { useUpdateField } from '../mutations';

import { DeleteFieldDialog } from './DeleteFieldDialog';
import { FieldDialog } from './FieldDialog';
import { FieldLimitDialog } from './FieldLimitDialog';
import { RenameFieldDialog } from './RenameFieldDialog';

import type { FieldToolsProps } from '../../../lib/schema/field-tools';
import type {
  FormulaDraft,
  FormulaPopoverComponent,
  FormulaSaveOutcome,
} from '../../../lib/schema/formula-tools';
import type { FieldDto } from '@cellhive/contracts';

/**
 * (T468) "Edit formula" of the column header: the formula popover saves
 * the field with `PATCH /fields/:id` (only `expression`, plus `style` when
 * chosen, like the dialog, T466). A formula error stays in the popover.
 */
function FormulaPopoverTool({
  tableId,
  field,
  anchor,
  Popover,
  onClose,
}: {
  readonly tableId: string;
  readonly field: FieldDto;
  readonly anchor: { x: number; y: number; width: number; height: number };
  readonly Popover: FormulaPopoverComponent;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation('field');
  const update = useUpdateField(tableId);
  const save = async (formula: FormulaDraft): Promise<FormulaSaveOutcome> => {
    const options: Record<string, unknown> = { expression: formula.expression };
    if (formula.styleTouched) options['style'] = formula.style;
    try {
      const saved = await update.mutateAsync({
        fieldId: field.id,
        body: { options },
      });
      if (saved.compute_state === 'backfilling') {
        showToast({ variant: 'info', message: t('formula.backfilling', { name: saved.name }) });
      }
      onClose();
      return { ok: true };
    } catch (error) {
      const inFormula = isApiError(error) && error.code.startsWith('FORMULA_');
      if (!inFormula) showErrorToast(error);
      return { ok: false, formError: false, error };
    }
  };
  return (
    <Suspense fallback={null}>
      <Popover tableId={tableId} field={field} anchor={anchor} onSave={save} onClose={onClose} />
    </Suspense>
  );
}

/**
 * Field configuration from the grid (T207): the dialog the grid asked for
 * (create / edit / rename / delete). The grid screen gets this component
 * from the route (`app/router.tsx`), since features do not import each other.
 */
export function FieldTools({
  tableId,
  fields,
  request,
  onClose,
  RecordFilterEditor,
  Formula,
  FormulaPopover,
  LookupEditor,
}: FieldToolsProps) {
  const [limit, setLimit] = useState<{ value: number | undefined } | null>(null);
  const table = useQuery(tableQuery(tableId));
  if (limit !== null) {
    return <FieldLimitDialog limit={limit.value} onClose={onClose} />;
  }
  if (request === null) return null;
  if (request.kind === 'create') {
    return (
      <FieldDialog
        tableId={tableId}
        index={request.index}
        fieldCount={fields.length}
        RecordFilterEditor={RecordFilterEditor}
        Formula={Formula}
        LookupEditor={LookupEditor}
        onClose={onClose}
        onLimitExceeded={(value) => {
          setLimit({ value });
        }}
      />
    );
  }
  const field = fields.find((candidate) => candidate.id === request.fieldId);
  // Deleted meanwhile (another tab): nothing left to configure.
  if (field === undefined) return null;
  switch (request.kind) {
    case 'formula':
      if (FormulaPopover !== undefined && field.type === 'formula') {
        return (
          <FormulaPopoverTool
            key={field.id}
            tableId={tableId}
            field={field}
            anchor={request.anchor}
            Popover={FormulaPopover}
            onClose={onClose}
          />
        );
      }
      return (
        <FieldDialog
          key={field.id}
          tableId={tableId}
          field={field}
          fieldCount={fields.length}
          RecordFilterEditor={RecordFilterEditor}
          Formula={Formula}
          LookupEditor={LookupEditor}
          onClose={onClose}
          onLimitExceeded={(value) => {
            setLimit({ value });
          }}
        />
      );
    case 'edit':
      return (
        <FieldDialog
          key={field.id}
          tableId={tableId}
          field={field}
          fieldCount={fields.length}
          RecordFilterEditor={RecordFilterEditor}
          Formula={Formula}
          LookupEditor={LookupEditor}
          onClose={onClose}
          onLimitExceeded={(value) => {
            setLimit({ value });
          }}
        />
      );
    case 'rename':
      return <RenameFieldDialog tableId={tableId} field={field} onClose={onClose} />;
    case 'delete':
      return <DeleteFieldDialog tableId={tableId} field={field} onClose={onClose} />;
    case 'revert':
      return (
        <RevertConversionDialog
          key={field.id}
          field={field}
          tableId={tableId}
          tableName={table.data?.name ?? ''}
          onClose={onClose}
        />
      );
  }
}

export default FieldTools;
