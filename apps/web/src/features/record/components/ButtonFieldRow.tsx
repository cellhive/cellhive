import { Tooltip } from '@cellhive/ui';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { ButtonControl } from '../../../grid/display/ButtonControl';
import { buttonKey, buttonViewOf } from '../../../lib/buttons/model';

import type { GridField } from '../../../grid/types';
import type { ButtonClicks } from '../../../lib/buttons/use-button-clicks';
import type { RecordDto } from '@cellhive/contracts';

export interface ButtonFieldRowProps {
  readonly field: GridField;
  readonly record: RecordDto;
  readonly recordTitle: string;
  readonly clicks: Pick<ButtonClicks, 'press' | 'running'>;
  /** Phones: a 44 px button across the row (board "S5 · Button field - 375 px"). */
  readonly narrow: boolean;
}

/**
 * A button field in the record panel (T525): its name, and the button in
 * the state the server gave for the reader — pressed with a click, Enter or
 * Space; disabled says why in a tooltip (hover and keyboard focus) and in
 * its accessible description. No cell history: a button stores nothing.
 */
export function ButtonFieldRow({
  field,
  record,
  recordTitle,
  clicks,
  narrow,
}: ButtonFieldRowProps) {
  const { t } = useTranslation('grid');
  const labelId = useId();
  const reasonId = useId();
  const column = field.button;
  if (column === undefined) return null;
  const view = buttonViewOf(
    record.fields[field.field.id],
    clicks.running.has(buttonKey(record.id, field.field.id)),
  );
  const reason = view.state === 'disabled' ? t(`button.reason.${view.reason}`) : null;
  const control = (
    <ButtonControl
      label={column.label}
      color={column.color}
      view={view}
      size={narrow ? 'lg' : 'md'}
      aria-describedby={reason === null ? undefined : reasonId}
      data-testid="record-button"
      data-state={view.state}
      onClick={() => {
        clicks.press({
          field: { id: field.field.id, name: field.field.name },
          column,
          record,
          recordTitle,
        });
      }}
    />
  );
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      data-testid="record-field"
      className="grid grid-cols-[minmax(0,1fr)] items-center gap-y-0.5 sm:min-h-9 sm:grid-cols-[minmax(7rem,10rem)_minmax(0,1fr)_1.75rem] sm:items-start sm:gap-x-4"
    >
      <div className="flex min-w-0 items-center px-2 text-label font-normal text-fg-muted sm:px-0 sm:pt-2 sm:text-body">
        <span id={labelId} className="truncate">
          {field.field.name}
        </span>
      </div>
      <div className="flex min-w-0 px-2 py-1 lg:py-1">
        {reason === null ? control : <Tooltip content={reason}>{control}</Tooltip>}
        {reason === null ? null : (
          <span id={reasonId} className="sr-only">
            {reason}
          </span>
        )}
      </div>
    </div>
  );
}
