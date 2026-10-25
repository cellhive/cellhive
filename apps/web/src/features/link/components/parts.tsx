import { Button, cn, Skeleton } from '@cellhive/ui';
import { Check, Filter, Lock, Plus, RotateCw, Search, TriangleAlert } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { highlightParts } from '../model/highlight';

import type { DisplayValue } from '../use-candidates';

/**
 * Pieces shared by the link picker's popover, dialog and full-screen sheet
 * (T413, board "S4 · Chọn bản ghi liên kết" and the picker cards of
 * "Trạng thái trống, đang tải, lỗi").
 */

/** The primary modifier as a key name ("⌘" on Apple platforms, else "Ctrl"). */
export function modKey(): string {
  return /Mac|iPhone|iPad/u.test(navigator.platform) ? '⌘' : 'Ctrl';
}

/** A title with the matches of the search in the accent color (no accents, any case). */
export function Highlighted({ text, search }: { text: string; search: string }) {
  return (
    <>
      {highlightParts(text, search).map((part, index) =>
        part.match ? (
          <mark key={index} className="bg-transparent font-semibold text-accent">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

/** The second line of a candidate: its display values (codes in mono), 12 px muted. */
export function DisplayLine({
  values,
  className,
}: {
  values: readonly DisplayValue[];
  className?: string;
}) {
  if (values.length === 0) return null;
  // One line "KH-1049 · Hà Nội" (board): the values flow inline and only the end is cut,
  // never each value on its own ("KH…", T421a).
  return (
    <span
      data-testid="link-display-line"
      className={cn('block min-w-0 truncate text-label font-normal text-fg-muted', className)}
    >
      {values.map((value, index) => (
        <Fragment key={value.fieldId}>
          {index > 0 ? ' · ' : null}
          <span className={value.code ? 'font-mono text-mono' : 'tabular-nums'}>{value.text}</span>
        </Fragment>
      ))}
    </span>
  );
}

/** The drawn check box of a row (the row itself is the option; the box is decoration). */
export function RowCheck({ checked, disabled }: { checked: boolean; disabled?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-sm',
        checked ? 'bg-accent text-on-accent' : 'border-[1.5px] border-line-control bg-surface',
        disabled === true && !checked && 'opacity-50',
      )}
    >
      {checked ? <Check className="size-3" strokeWidth={2.4} /> : null}
    </span>
  );
}

export interface CandidateRowProps {
  readonly id: string;
  readonly title: string | null;
  readonly search: string;
  readonly values: readonly DisplayValue[];
  readonly selected: boolean;
  /** Several records: a check box; one record: a check mark at the end when chosen. */
  readonly multiple: boolean;
  readonly active: boolean;
  /** Why the record cannot be chosen (its own cell is full, off the field's conditions). */
  readonly disabledReason?: string | undefined;
  /** Chosen records are full: new ones are dimmed (they cannot be added). */
  readonly dimmed?: boolean;
  /** Row height: 44 px in the popover, 48 px in the dialog, 56 px on phones. */
  readonly size: 'popover' | 'dialog' | 'sheet';
  readonly onChoose: () => void;
  readonly onPointerActive: () => void;
}

/** One record of the picker's list (`role="option"`, chosen = `aria-selected`). */
export function CandidateRow(props: CandidateRowProps) {
  const { t } = useTranslation('link');
  const disabled = props.disabledReason !== undefined;
  const height =
    props.size === 'popover' ? 'min-h-11' : props.size === 'dialog' ? 'min-h-12' : 'min-h-14';
  return (
    <div
      id={props.id}
      role="option"
      aria-selected={props.selected}
      aria-disabled={disabled || (props.dimmed === true && !props.selected) ? true : undefined}
      data-testid="link-candidate"
      className={cn(
        'flex cursor-pointer items-center gap-3 px-3 py-1',
        height,
        props.size === 'sheet' ? 'border-b border-line px-4' : 'rounded-md',
        props.selected && props.size !== 'sheet' && 'bg-accent-soft/60',
        props.active && props.size !== 'sheet' && 'ring-2 ring-accent ring-inset',
        props.active && props.size === 'sheet' && 'bg-surface-sunken',
        (disabled || (props.dimmed === true && !props.selected)) && 'cursor-not-allowed',
      )}
      onMouseDown={(event) => {
        // The focus stays in the search box (combobox) or the list.
        event.preventDefault();
      }}
      onMouseMove={props.onPointerActive}
      onClick={props.onChoose}
    >
      {props.multiple ? (
        <RowCheck checked={props.selected} disabled={disabled || props.dimmed === true} />
      ) : null}
      <span
        className={cn(
          'flex min-w-0 flex-1 flex-col gap-0.5',
          (disabled || (props.dimmed === true && !props.selected)) && 'opacity-60',
        )}
      >
        <span
          className={cn(
            'truncate font-medium',
            props.size === 'sheet' ? 'text-heading font-medium' : 'text-body',
          )}
        >
          {props.title === null ? (
            <span className="inline-flex items-center gap-1 font-normal text-fg-muted">
              <Lock aria-hidden="true" className="size-3.5" />
              {t('picker.noAccess')}
            </span>
          ) : (
            <Highlighted text={props.title} search={props.search} />
          )}
        </span>
        <DisplayLine values={props.values} />
        {disabled ? (
          <span className="text-label font-normal text-fg-muted">{props.disabledReason}</span>
        ) : null}
      </span>
      {!props.multiple && props.selected ? (
        <Check
          aria-hidden="true"
          className="ml-auto size-4 shrink-0 text-accent"
          strokeWidth={2.2}
        />
      ) : null}
    </div>
  );
}

/** "Only … matching the field's conditions" (the field has a `record_filter`). */
export function FilterNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn('flex items-center gap-1.5 text-label font-normal text-fg-muted', className)}>
      <Filter aria-hidden="true" className="size-3 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** Skeleton rows while the first page loads: grey blocks where the rows go, no spinner. */
export function LoadingRows({ multiple, label }: { multiple: boolean; label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-2 px-3 py-2">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex items-center gap-3 py-1.5">
          {multiple ? <Skeleton className="size-4 rounded-sm" /> : null}
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className={cn('h-3', row === 1 ? 'w-2/5' : 'w-3/5')} />
            <Skeleton className="h-2.5 w-1/4" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Nothing found: the search, and creating the record right here (board card "không có kết quả"). */
export function EmptyResults({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string | undefined;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-1 px-4 py-6 text-center" role="status">
      <Search aria-hidden="true" className="mb-1 size-4 text-fg-muted" />
      <p className="text-body font-medium text-fg">{title}</p>
      {hint === undefined ? null : <p className="text-label font-normal text-fg-muted">{hint}</p>}
      {action === undefined ? null : <div className="mt-2">{action}</div>}
    </div>
  );
}

/** The list failed: a retry that keeps the search (board card "lỗi tải"). */
export function LoadError({ detail, onRetry }: { detail: string; onRetry: () => void }) {
  const { t } = useTranslation('link');
  return (
    <div className="flex flex-col items-center gap-1 px-4 py-6 text-center" role="alert">
      <TriangleAlert aria-hidden="true" className="mb-1 size-4 text-fg-muted" />
      <p className="text-body font-medium text-fg">{t('picker.error')}</p>
      <p className="text-label font-normal text-fg-muted">{detail}</p>
      <Button variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
        <RotateCw aria-hidden="true" />
        {t('picker.retry')}
      </Button>
    </div>
  );
}

/** The cell is full (500 / 1): adding is blocked until some are removed (board card "đủ 500"). */
export function LimitBanner({ limit }: { limit: number }) {
  const { t } = useTranslation('link');
  return (
    <div
      role="status"
      className="mx-3 my-2 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-label font-normal text-fg"
    >
      <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0 text-warning" />
      <span>
        <strong className="font-semibold">{t('picker.limitReached', { limit })}</strong>{' '}
        {t('picker.limitReachedHint')}
      </span>
    </div>
  );
}

/** "+ Create …" of the list. */
export function CreateButton({
  label,
  hint,
  className,
  onClick,
}: {
  label: string;
  hint?: string | undefined;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="link-create"
      className={cn(
        'flex min-h-11 w-full shrink-0 items-center gap-2 px-4 text-left text-body font-medium text-accent hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset',
        className,
      )}
      onClick={onClick}
    >
      <Plus aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
      {hint === undefined ? null : (
        <span className="ml-auto shrink-0 text-label font-normal text-fg-muted max-sm:hidden">
          {hint}
        </span>
      )}
    </button>
  );
}

/** Keyboard hints at the bottom (board footer). */
export function KeyHints({ hints, className }: { hints: readonly string[]; className?: string }) {
  return (
    <p
      aria-hidden="true"
      className={cn(
        'flex flex-wrap gap-x-3.5 gap-y-1 text-label font-normal text-fg-muted',
        className,
      )}
    >
      {hints.map((hint) => (
        <span key={hint}>{hint}</span>
      ))}
    </p>
  );
}
