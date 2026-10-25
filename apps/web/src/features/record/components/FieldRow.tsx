import { Button, cn, Tooltip } from '@cellhive/ui';
import { History, Lock } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { CellValue } from '../../../grid/display/CellValue';
import { CellEditor, editsInPlace } from '../../../grid/editors/index';
import { linkTargetDeleted } from '../../../lib/links/values';
import { locksFieldValues } from '../../../lib/schema/conversion';

import type { EditorCommit, EditorDraft, EditorIssue } from '../../../grid/editors/types';
import type { GridField } from '../../../grid/types';
import type { AnchorRect } from '../../../lib/records/detail';
import type { FieldState, PanelEditing } from '../use-panel-editing';
import type { RecordDto } from '@cellhive/contracts';
import type { LocaleContext } from '@cellhive/field-types';

/** Height of the editor input: the row of the panel. */
const EDITOR_HEIGHT = 36;

export interface InlineEditorProps {
  readonly field: GridField;
  readonly value: unknown;
  readonly width: number;
  readonly editing: PanelEditing;
  readonly onCommit: (commit: EditorCommit) => void;
  readonly onInvalid: (issue: EditorIssue) => void;
  readonly onClose: () => void;
}

/**
 * A `grid/editors` editor inside the panel (T203 editors, reused): Enter /
 * Tab write, Escape cancels, leaving the editor writes the last draft (a
 * draft that cannot be written marks the field, like a click outside a
 * grid cell).
 */
export function InlineEditor({
  field,
  value,
  width,
  editing,
  onCommit,
  onInvalid,
  onClose,
}: InlineEditorProps) {
  const wrapper = useRef<HTMLDivElement>(null);
  const draft = useRef<EditorDraft | null>(null);
  const done = useRef(false);
  const config = field.config;
  if (config === null) return null;
  const finish = (action: () => void) => {
    if (done.current) return;
    done.current = true;
    action();
    onClose();
  };
  return (
    <div
      ref={wrapper}
      className="relative z-10"
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && wrapper.current?.contains(next) === true) return;
        const last = draft.current;
        finish(() => {
          if (last === null) return;
          if (last.ok) onCommit(last.commit);
          else onInvalid(last.issue);
        });
      }}
    >
      <CellEditor
        field={field.field}
        config={config}
        value={value}
        initialInput={undefined}
        cellHeight={EDITOR_HEIGHT}
        cellWidth={width}
        context={editing.editorContext}
        onDraft={(next) => {
          draft.current = next;
        }}
        onCommit={(commit) => {
          finish(() => {
            onCommit(commit);
          });
        }}
        onCancel={() => {
          finish(() => undefined);
        }}
      />
    </div>
  );
}

/**
 * Renders the link picker of a link field (T413) for the record, under
 * `anchor` (the value's box); `close` ends it (the value button takes the
 * focus back).
 */
export type OpenLinkPicker = (
  field: GridField,
  record: RecordDto,
  anchor: AnchorRect,
  close: () => void,
) => ReactNode;

export interface FieldRowProps {
  readonly field: GridField;
  readonly record: RecordDto;
  readonly editing: PanelEditing;
  readonly locale: LocaleContext;
  readonly onHistory: (fieldId: string, anchor: AnchorRect) => void;
  /** Under the value: the S4 linked-record sub-grid goes here (FRONTEND §10.2). */
  readonly below?: ReactNode;
  /**
   * Whether the name carries the read-only mark; default: when the value
   * cannot be edited here. A field written outside the cell editor (the
   * sub-record parent, T417) passes whether that other way is open.
   */
  readonly readOnly?: boolean;
  /** The link picker of link fields (T413); absent: link fields are read-only here. */
  readonly openLinks?: OpenLinkPicker | undefined;
}

function stateClass(state: FieldState): string | false {
  if (state?.status === 'pending') return 'outline-dashed outline-1 outline-accent/60';
  if (state?.status === 'error') return 'outline outline-2 outline-danger';
  return false;
}

/**
 * One field of the record panel (design "Chi tiết record và lịch sử"):
 * name on the left, value on the right (a button that opens the editor
 * when the user may edit it), and a history button for the cell. Phones
 * (T322a): the name right above its value, the history button at the end
 * of the value's row (small, with a 44 px hit area).
 */
export function FieldRow({
  field,
  record,
  editing,
  locale,
  onHistory,
  below,
  readOnly,
  openLinks,
}: FieldRowProps) {
  const { t } = useTranslation('record');
  const labelId = useId();
  const valueId = useId();
  const errorId = useId();
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(280);
  // The editor closed with the focus in it (Enter / Escape): the value button takes it back.
  const refocus = useRef(false);
  const valueBox = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const fieldId = field.field.id;
  const value = record.fields[fieldId];
  const canEdit = editing.canEdit(field) && (field.link === undefined || openLinks !== undefined);
  const converting = locksFieldValues(field.field);
  const [linkAnchor, setLinkAnchor] = useState<AnchorRect | null>(null);
  // The picker closed: the value button takes the focus back (an effect: refs are not read in render).
  const [linkClosed, setLinkClosed] = useState(0);
  useEffect(() => {
    if (linkClosed > 0) trigger.current?.focus();
  }, [linkClosed]);
  const state = editing.fieldState(record.id, fieldId);
  const inPlace = editsInPlace(field);

  useEffect(() => {
    if (!refocus.current || open) return;
    refocus.current = false;
    trigger.current?.focus();
  }, [open]);

  // A link to a table in the trash reads empty and takes no links (T421a): it says why.
  const empty = (
    <span className="text-fg-subtle">
      {linkTargetDeleted(field.field) ? t('linkTargetDeleted') : t('empty')}
    </span>
  );
  const error = state?.status === 'error' ? state.message : null;
  const startEditing = () => {
    editing.clearError(record.id, fieldId);
    setWidth(valueBox.current?.offsetWidth ?? 280);
    if (field.link !== undefined) {
      // Link (T413): the picker opens under the value (a sheet on phones).
      const rect = valueBox.current?.getBoundingClientRect();
      setLinkAnchor(
        rect === undefined
          ? { x: 0, y: 0, width: 0, height: 0 }
          : { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      );
      return;
    }
    setOpen(true);
  };

  let content: ReactNode;
  // Rights may go (offline, lock) while the editor is open: it is not shown then.
  if (open && canEdit && field.link === undefined) {
    content = (
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
          // Only when the editor had the focus (Enter / Escape), not on a click elsewhere.
          const active = document.activeElement;
          refocus.current = active === document.body || valueBox.current?.contains(active) === true;
        }}
      />
    );
  } else if (canEdit && inPlace) {
    content = (
      <label className="inline-flex min-h-control items-center gap-2 px-2 lg:min-h-9">
        <input
          type="checkbox"
          checked={value === true}
          aria-labelledby={labelId}
          aria-describedby={error === null ? undefined : errorId}
          className="size-4 accent-accent"
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
  } else if (canEdit) {
    content = (
      <button
        ref={trigger}
        type="button"
        aria-labelledby={`${labelId} ${valueId}`}
        aria-describedby={error === null ? undefined : errorId}
        className={cn(
          // 44 px touch targets below 1024 px (T322a), 36 px rows above.
          'flex min-h-control w-full min-w-0 items-center rounded-md px-2 py-1 text-left lg:min-h-9 lg:py-1.5',
          'hover:bg-surface-sunken focus-visible:bg-surface-sunken',
          stateClass(state),
        )}
        onClick={startEditing}
      >
        <span id={valueId} className="min-w-0 flex-1">
          {/* No links inside the button (axe nested-interactive, target-size; T421b, T470). */}
          <CellValue field={field} value={value} locale={locale} empty={empty} links={false} />
        </span>
      </button>
    );
  } else {
    content = (
      <div
        className={cn(
          'flex min-h-8 min-w-0 items-center px-2 py-1 lg:min-h-9 lg:py-1.5',
          stateClass(state),
        )}
        aria-describedby={error === null ? undefined : errorId}
      >
        <CellValue field={field} value={value} locale={locale} empty={empty} />
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      data-testid="record-field"
      className={cn(
        // Phone: the name right above the value (2 px), the history button on the value's
        // row; the next field is further away (the list's gap). Wider: name | value |
        // history, 36 px rows without separators (design board).
        'group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1 gap-y-0.5',
        'sm:min-h-9 sm:grid-cols-[minmax(7rem,10rem)_minmax(0,1fr)_auto] sm:items-start sm:gap-x-4 sm:gap-y-0',
      )}
    >
      <div className="col-span-2 flex min-w-0 items-center gap-1 px-2 text-label font-normal text-fg-muted sm:col-span-1 sm:px-0 sm:pt-2 sm:text-body">
        <span id={labelId} className="truncate">
          {field.field.name}
        </span>
        {!(readOnly ?? !canEdit) ? null : (
          <span title={t(converting ? 'converting' : 'readOnly')} className="inline-flex">
            <Lock aria-hidden="true" className="size-3 shrink-0 text-fg-subtle" />
            <span className="sr-only">{t(converting ? 'converting' : 'readOnly')}</span>
          </span>
        )}
      </div>
      <div ref={valueBox} className="min-w-0">
        {content}
        {linkAnchor === null || !canEdit || openLinks === undefined
          ? null
          : openLinks(field, record, linkAnchor, () => {
              setLinkAnchor(null);
              setLinkClosed((count) => count + 1);
            })}
        {state?.status === 'pending' ? <span className="sr-only">{t('saving')}</span> : null}
        {error === null ? null : (
          <p id={errorId} className="px-2 pt-1 text-label font-normal text-danger">
            {error}
          </p>
        )}
        {below}
      </div>
      {/*
        The cell history: shown on hover or focus of the row (always on phones: no hover).
        28 px drawn, 44 px to touch (T322a): the hit area grows through a pseudo-element.
      */}
      <Tooltip content={t('fieldHistory', { field: field.field.name })}>
        <Button
          variant="ghost"
          size={null}
          data-testid="field-history"
          className={cn(
            'relative size-7 text-fg-muted before:absolute before:-inset-2 sm:mt-1 sm:before:inset-0',
            'sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100 sm:focus-visible:opacity-100',
          )}
          aria-label={t('fieldHistory', { field: field.field.name })}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            onHistory(fieldId, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
          }}
        >
          <History aria-hidden="true" />
        </Button>
      </Tooltip>
    </div>
  );
}
