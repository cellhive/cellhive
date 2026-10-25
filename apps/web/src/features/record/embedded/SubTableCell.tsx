import { cn } from '@cellhive/ui';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { CellValue } from '../../../grid/display/CellValue';
import { editsInPlace } from '../../../grid/editors/index';
import { InlineEditor } from '../components/FieldRow';

import type { GridField } from '../../../grid/types';
import type { PanelEditing } from '../use-panel-editing';
import type { RecordDto } from '@cellhive/contracts';
import type { LocaleContext } from '@cellhive/field-types';

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

/**
 * The cell's place in the window while its editor is open: the editor
 * floats over it (lists and calendars are not clipped by the sub-table's
 * scroll box) and follows it when the panel scrolls.
 */
function useCellRect(open: boolean, cell: React.RefObject<HTMLElement | null>): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const box = cell.current?.getBoundingClientRect();
      if (box !== undefined) setRect({ left: box.left, top: box.top, width: box.width });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, cell]);
  return open ? rect : null;
}

/** Values aligned right (board: quantities and amounts). */
export function isNumericField(field: GridField): boolean {
  const type = field.config?.type;
  return type === 'number' || type === 'auto_number';
}

/**
 * Whether a cell of the sub-table may be edited in place: the linked
 * table's rights (FRONTEND §4.1 through its `RecordEditController`), not a
 * link or file cell (their pickers stay in the linked record's own panel).
 */
export function editsInSubTable(field: GridField, editing: PanelEditing): boolean {
  return editing.canEdit(field) && field.link === undefined && field.config?.type !== 'attachment';
}

export interface SubTableCellProps {
  readonly field: GridField;
  readonly record: RecordDto;
  /** Edit flow of the linked table. */
  readonly editing: PanelEditing;
  readonly locale: LocaleContext;
  /** Position for the arrow keys (`data-cell="row,column"`). */
  readonly row: number;
  readonly column: number;
  /** Extra classes of the `<td>` (the sticky primary column, T421a). */
  readonly className?: string | undefined;
  /** Opens the editor at once (the row was just added). */
  readonly autoOpen?: boolean;
  /** Called once the editor opened on its own (`autoOpen`). */
  readonly onAutoOpened?: () => void;
}

/**
 * One cell of the sub-table (board "Bảng con trong chi tiết record"): the
 * value; a button opening the grid's editor in place when the viewer may
 * edit it (Enter / Tab write, Escape cancels, like the panel's fields);
 * checkboxes toggle in place. Pending writes are outlined, refused ones
 * marked red with the reason for screen readers.
 */
export function SubTableCell({
  field,
  record,
  editing,
  locale,
  row,
  column,
  className,
  autoOpen = false,
  onAutoOpened,
}: SubTableCellProps) {
  const { t } = useTranslation(['subtable', 'record']);
  const [open, setOpen] = useState(autoOpen);
  const [width, setWidth] = useState(160);
  const cell = useRef<HTMLTableCellElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const floating = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  const errorId = useId();
  const fieldId = field.field.id;
  const value = record.fields[fieldId];
  const editable = editsInSubTable(field, editing);
  const state = editing.fieldState(record.id, fieldId);
  const error = state?.status === 'error' ? state.message : null;
  const numeric = isNumericField(field);
  const rect = useCellRect(open && editable, cell);

  const opened = useRef(onAutoOpened);
  useEffect(() => {
    // Mounted with the editor open (a new row): its width, and the parent forgets the request.
    if (!autoOpen) return;
    setWidth(cell.current?.offsetWidth ?? 160);
    opened.current?.();
    // Only on mount: the request is for this cell as it first appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (open || !refocus.current) return;
    refocus.current = false;
    trigger.current?.focus();
  }, [open]);

  const outline =
    state?.status === 'pending'
      ? 'outline-dashed outline-1 -outline-offset-2 outline-accent/60'
      : error === null
        ? null
        : 'outline outline-2 -outline-offset-2 outline-danger';
  const display = (
    <CellValue
      field={field}
      value={value}
      locale={locale}
      compact
      // An editable cell is a button: no link inside it (T421b, axe `nested-interactive`).
      links={!editable}
      className={cn(numeric && 'ml-auto')}
    />
  );
  const described = error === null ? undefined : errorId;
  let content;
  let editor = null;
  if (open && editable) {
    content = (
      <div className="flex h-9 min-w-0 items-center px-2.5 max-lg:h-11" aria-hidden="true">
        {display}
      </div>
    );
    editor =
      rect === null
        ? null
        : createPortal(
            <div
              ref={floating}
              className="fixed z-[60]"
              style={{ left: rect.left, top: rect.top, width: Math.max(rect.width, 160) }}
              data-testid="subtable-editor"
            >
              <InlineEditor
                field={field}
                value={value}
                width={width}
                editing={editing}
                onCommit={(commit) => {
                  editing.commit(record.id, fieldId, commit);
                }}
                onInvalid={(issue) => {
                  editing.markInvalid(record.id, fieldId, issue);
                }}
                onClose={() => {
                  setOpen(false);
                  const active = document.activeElement;
                  refocus.current =
                    active === document.body ||
                    active === null ||
                    floating.current?.contains(active) === true;
                }}
              />
            </div>,
            document.body,
          );
  } else if (editable && editsInPlace(field)) {
    content = (
      <label className="flex h-9 items-center justify-center max-lg:h-11">
        <input
          type="checkbox"
          data-cell={`${String(row)},${String(column)}`}
          aria-label={field.field.name}
          aria-describedby={described}
          checked={value === true}
          className="size-4"
          onChange={(event) => {
            editing.commit(record.id, fieldId, {
              value: event.target.checked,
              display: event.target.checked,
              typecast: false,
            });
          }}
        />
      </label>
    );
  } else if (editable) {
    content = (
      <button
        ref={trigger}
        type="button"
        data-cell={`${String(row)},${String(column)}`}
        aria-describedby={described}
        className={cn(
          'flex h-9 w-full min-w-0 items-center px-2.5 text-left max-lg:h-11',
          'hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
          numeric && 'justify-end text-right',
          outline,
        )}
        onClick={() => {
          editing.clearError(record.id, fieldId);
          setWidth(cell.current?.offsetWidth ?? 160);
          setOpen(true);
        }}
      >
        <span className="sr-only">{`${field.field.name}: `}</span>
        {display}
        {value === null || value === undefined || value === '' ? (
          <span className="sr-only">{t('record:empty')}</span>
        ) : null}
      </button>
    );
  } else {
    content = (
      <div
        className={cn(
          'flex h-9 min-w-0 items-center px-2.5 max-lg:h-11',
          numeric && 'justify-end text-right',
          outline,
        )}
      >
        {display}
      </div>
    );
  }
  return (
    <td
      ref={cell}
      className={cn('relative min-w-0 overflow-hidden p-0', className)}
      data-testid="subtable-cell"
    >
      {content}
      {editor}
      {error === null ? null : (
        <span id={errorId} className="sr-only">
          {error}
        </span>
      )}
    </td>
  );
}
