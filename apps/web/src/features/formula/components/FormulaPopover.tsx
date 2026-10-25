import { Button, cn, Skeleton, Spinner } from '@cellhive/ui';
import { ChevronLeft, ChevronRight, CircleAlert, HelpCircle, Maximize2, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../lib/api/client';
import { useFormulaEnvironment } from '../data';
import { FormulaInput, type FormulaInputHandle } from '../editor/FormulaInput';
import { FORMULA_LIMITS } from '../model/analysis';
import { isEmptyValue } from '../model/preview';

import { Catalogue } from './Catalogue';
import { useFormulaSession } from './formula-session';

import type { FormulaDraft, FormulaPopoverProps } from '../../../lib/schema/formula-tools';
import type { FormulaSchema } from '../model/schema';

/** The full editor behind "Expand": its own chunk, shared with the field dialog (T466). */
const FormulaEditorDialog = lazy(() => import('./FormulaEditorDialog'));

const WIDTH = 640;
const GAP = 4;
const MARGIN = 8;

function draftOf(options: Readonly<Record<string, unknown>>): FormulaDraft {
  const style = options['style'];
  return {
    expression: typeof options['expression'] === 'string' ? options['expression'] : '',
    style:
      typeof style === 'object' && style !== null && !Array.isArray(style)
        ? (style as Record<string, unknown>)
        : null,
    styleTouched: false,
  };
}

/**
 * "Edit formula" from the column header (T468; BACKLOG S4b additional
 * decision #12, board "S4b · Trình soạn công thức - popover"): the editor
 * of T466 in a 640 px popover anchored under the header — the formula,
 * "= value" of the preview row with ‹ ›, "Expand" (the full dialog with
 * what was typed) and "Confirm"; the signature bar, the catalogue and the
 * length. Cells stay read-only (like Lark and Airtable, the formula is
 * edited on the field). Non-modal: Escape or a click outside closes it
 * (unsaved changes ask first).
 */
export function FormulaPopover(props: FormulaPopoverProps) {
  const { t } = useTranslation(['formula', 'common']);
  const env = useFormulaEnvironment(props.tableId, props.field.id);
  if (env.schema === null) {
    return (
      <div
        role="status"
        aria-label={t('common:loading')}
        className="fixed z-50 rounded-lg border border-line bg-surface p-4 shadow-popover"
        style={{ left: props.anchor.x, top: props.anchor.y + props.anchor.height + GAP }}
      >
        <Skeleton className="h-8 w-60" />
      </div>
    );
  }
  return (
    <FormulaPopoverEditor
      {...props}
      schema={env.schema}
      tableName={env.tableName}
      timeZone={env.timeZone ?? 'UTC'}
      currency={env.currency ?? 'VND'}
    />
  );
}

export function FormulaPopoverEditor({
  tableId,
  field,
  anchor,
  onSave,
  onClose,
  schema,
  tableName,
  timeZone,
  currency,
}: FormulaPopoverProps & {
  readonly schema: FormulaSchema;
  readonly tableName: string;
  readonly timeZone: string;
  readonly currency: string;
}) {
  const { t } = useTranslation(['formula', 'common']);
  const titleId = useId();
  const errorsId = useId();
  const reasonId = useId();
  const box = useRef<HTMLElement>(null);
  const input = useRef<FormulaInputHandle>(null);
  const [initial] = useState(() => draftOf(field.options));
  const [expression, setExpression] = useState(initial.expression);
  const [caret, setCaret] = useState(initial.expression.length);
  const [rowIndex, setRowIndex] = useState(0);
  const [guide, setGuide] = useState(false);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [saveError, setSaveError] = useState<{ error: unknown; source: string } | null>(null);
  const [height, setHeight] = useState(480);
  const session = useFormulaSession({
    tableId,
    fieldId: field.id,
    schema,
    timeZone,
    expression,
    caret,
    style: initial.style,
    styleTouched: false,
    saveError,
  });
  const { previewRows, visibleDiagnostics, diagnostics, signature, blocked, trimmed } = session;
  const rowCount = previewRows?.length ?? 0;
  const index = rowCount === 0 ? 0 : Math.min(rowIndex, rowCount - 1);
  const current = previewRows?.[index];
  const dirty = expression !== initial.expression;

  useLayoutEffect(() => {
    const element = box.current;
    if (element === null) return;
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            setHeight(element.offsetHeight);
          });
    observer?.observe(element);
    setHeight(element.offsetHeight);
    return () => observer?.disconnect();
  }, []);

  const requestClose = () => {
    if (dirty && !saving) setConfirmingDiscard(true);
    else onClose();
  };
  const closeRef = useRef(requestClose);
  useLayoutEffect(() => {
    closeRef.current = requestClose;
  });

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (box.current?.contains(target) === true) return;
      // The autocomplete list of CodeMirror and the expanded dialog live outside the box.
      if (target instanceof Element && target.closest('.cm-tooltip, dialog') !== null) return;
      closeRef.current();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, []);

  const save = (draft: FormulaDraft) => {
    setSaving(true);
    setSaveError(null);
    return onSave(draft).then((outcome) => {
      setSaving(false);
      if (!outcome.ok) setSaveError({ error: outcome.error, source: draft.expression });
      return outcome;
    });
  };
  const confirm = () => {
    if (blocked || saving) return;
    void save({ expression, style: initial.style, styleTouched: false });
  };

  const width = Math.min(WIDTH, window.innerWidth - 2 * MARGIN);
  const left = Math.min(Math.max(anchor.x, MARGIN), window.innerWidth - width - MARGIN);
  const below = anchor.y + anchor.height + GAP;
  const room = window.innerHeight - below - MARGIN;
  const top = room >= Math.min(height, 360) ? below : Math.max(MARGIN, anchor.y - GAP - height);
  const maxHeight = Math.max(240, top === below ? room : anchor.y - GAP - MARGIN);

  if (expanded) {
    return (
      <Suspense fallback={null}>
        <FormulaEditorDialog
          tableId={tableId}
          fieldId={field.id}
          fieldName={field.name}
          tableName={tableName}
          schema={schema}
          timeZone={timeZone}
          currency={currency}
          initial={{ expression, style: initial.style, styleTouched: false }}
          onCancel={() => {
            setExpanded(false);
          }}
          onConfirm={save}
        />
      </Suspense>
    );
  }

  return (
    <section
      ref={box}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-testid="formula-popover"
      className="fixed z-50 flex flex-col overflow-hidden rounded-lg border border-line bg-surface text-body text-fg shadow-popover animate-pop-in"
      style={{ left, top, width, maxHeight }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.stopPropagation();
          if (confirmingDiscard) setConfirmingDiscard(false);
          else requestClose();
        }
      }}
    >
      <header className="flex items-center gap-2 border-b border-line py-1 pr-1 pl-3">
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-label text-fg">
          {t('formula:popover.title')}
          <span className="font-normal text-fg-muted">{` · ${field.name}`}</span>
        </h2>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={t('formula:popover.expand')}
          onClick={() => {
            setExpanded(true);
          }}
          data-testid="formula-popover-expand"
        >
          <Maximize2 aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={t('common:actions.close')}
          onClick={requestClose}
        >
          <X aria-hidden="true" />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="px-3 pt-3 [&_.cm-scroller]:max-h-[calc(9.25rem-2px)] [&_.cm-scroller]:overflow-y-auto">
          <FormulaInput
            ref={input}
            value={expression}
            env={session.env}
            diagnostics={visibleDiagnostics}
            label={t('formula:editor.label')}
            describedBy={errorsId}
            onChange={(text) => {
              setExpression(text);
              setConfirmingDiscard(false);
            }}
            onCaret={setCaret}
            onConfirm={confirm}
            lineNumbers={false}
            autoFocus
          />
        </div>
        {visibleDiagnostics.length > 0 ? (
          <div id={errorsId} role="alert" className="px-3 pt-2" data-testid="formula-errors">
            <ul
              aria-label={t('formula:errors.count', { count: visibleDiagnostics.length })}
              className="flex flex-col gap-0.5"
            >
              {visibleDiagnostics.map((item) => (
                <li key={`${String(item.start)}:${item.code}`}>
                  <button
                    type="button"
                    onClick={() => {
                      input.current?.select(item.start, item.start + item.length);
                    }}
                    className="flex w-full items-start gap-2 rounded-md px-2 py-1 text-left text-label leading-normal font-normal text-fg hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <CircleAlert
                      aria-hidden="true"
                      className="mt-0.5 size-3.5 shrink-0 text-danger"
                    />
                    <span className="min-w-0 flex-1">{session.translate(item)}</span>
                    <span className="mt-0.5 font-mono text-mono whitespace-nowrap text-fg-muted">
                      <span className="sr-only">{t('formula:errors.at')}</span>
                      {`${String(item.line)}:${String(item.column)}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <span id={errorsId} className="sr-only">
            {trimmed === '' ? '' : t('formula:errors.none')}
          </span>
        )}
        <div className="flex min-h-12 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5">
          <span
            role="status"
            aria-live="polite"
            className={cn(
              'flex min-w-0 flex-1 items-baseline gap-2',
              session.stale && 'opacity-60',
            )}
            data-testid="formula-preview-value"
          >
            <span className="font-mono text-fg-muted" aria-hidden="true">
              =
            </span>
            {trimmed === '' || diagnostics.length > 0 ? null : current === undefined ? (
              session.loadingServer ? (
                <Spinner />
              ) : session.server.error !== null && !session.editor.sameRow ? (
                <span className="text-label font-normal text-danger">
                  {isApiError(session.server.error) && session.server.error.code === 'QUERY_TIMEOUT'
                    ? t('formula:preview.timeout')
                    : t('formula:preview.failed')}
                </span>
              ) : (
                <span className="text-label font-normal text-fg-muted">
                  {t('formula:preview.noRows')}
                </span>
              )
            ) : isEmptyValue(current.value) ? (
              <span className="font-normal text-fg-muted italic">{t('formula:preview.blank')}</span>
            ) : (
              <span className="truncate text-heading text-fg tabular-nums">
                {session.formatValue(current.value)}
              </span>
            )}
          </span>
          {rowCount > 0 ? (
            <span className="flex shrink-0 items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={t('formula:preview.previous')}
                disabled={index === 0}
                onClick={() => {
                  setRowIndex(index - 1);
                }}
              >
                <ChevronLeft aria-hidden="true" />
              </Button>
              <span
                className="max-w-48 truncate text-label font-normal text-fg-muted tabular-nums"
                data-testid="formula-preview-row"
              >
                {t('formula:preview.row', {
                  index: index + 1,
                  count: rowCount,
                  title:
                    current?.title === '' || current === undefined
                      ? t('formula:preview.untitled')
                      : current.title,
                })}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={t('formula:preview.next')}
                disabled={index >= rowCount - 1}
                onClick={() => {
                  setRowIndex(index + 1);
                }}
              >
                <ChevronRight aria-hidden="true" />
              </Button>
            </span>
          ) : null}
          <Button
            size="sm"
            aria-disabled={blocked || saving}
            aria-describedby={blocked ? reasonId : undefined}
            className={cn((blocked || saving) && 'cursor-not-allowed opacity-60')}
            onClick={confirm}
            data-testid="formula-confirm"
          >
            {saving ? <Spinner /> : null}
            {t('formula:editor.confirm')}
          </Button>
        </div>
        {signature === null ? null : (
          <div
            role="note"
            aria-label={t('formula:signature.label')}
            className="flex flex-col gap-1 border-y border-line bg-surface-sunken px-4 py-2"
            data-testid="formula-signature"
          >
            <span className="font-mono text-body break-words text-fg">
              {signature.parts.map((part, position) =>
                part.active ? (
                  <mark
                    key={position}
                    className="rounded-sm bg-option-3 px-0.5 text-fg shadow-[inset_0_-2px_0_var(--warning)]"
                  >
                    {part.text}
                  </mark>
                ) : (
                  <span key={position}>{part.text}</span>
                ),
              )}
            </span>
            {signature.param === null ? null : (
              <span className="text-label leading-normal font-normal text-fg-muted">
                <strong className="font-semibold text-fg">
                  {signature.parts.find((part) => part.active)?.text ?? ''}
                </strong>
                {`: ${t(`formula:paramKinds.${signature.param.kind}`)}`}
              </span>
            )}
          </div>
        )}
        <div className="flex h-64 shrink-0 flex-col border-t border-line">
          <Catalogue
            schema={schema}
            variables={session.variables}
            guide={guide}
            onGuideShown={() => {
              setGuide(false);
            }}
            onInsert={(text, caretOffset) => {
              input.current?.insert(text, caretOffset);
            }}
          />
        </div>
      </div>
      <footer className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3 py-1.5 text-label font-normal text-fg-muted tabular-nums">
        {confirmingDiscard ? (
          <div
            role="alertdialog"
            aria-label={t('formula:discard.title')}
            className="flex flex-1 flex-wrap items-center gap-2"
          >
            <span className="text-body text-fg">{t('formula:discard.title')}</span>
            <span className="ml-auto flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                autoFocus
                onClick={() => {
                  setConfirmingDiscard(false);
                  input.current?.focus();
                }}
              >
                {t('formula:discard.keep')}
              </Button>
              <Button variant="danger" size="sm" onClick={onClose}>
                {t('formula:discard.discard')}
              </Button>
            </span>
          </div>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={guide}
              onClick={() => {
                setGuide((value) => !value);
              }}
            >
              <HelpCircle aria-hidden="true" className="size-3.5" />
              {t('formula:popover.guide')}
            </Button>
            {blocked ? (
              <span id={reasonId} className={cn(trimmed !== '' && 'text-danger')}>
                {trimmed === ''
                  ? t('formula:footer.writeToConfirm')
                  : t('formula:footer.fixToConfirm', { count: diagnostics.length })}
              </span>
            ) : null}
            <span
              className={cn('ml-auto', expression.length > FORMULA_LIMITS.length && 'text-danger')}
            >
              {t('formula:footer.length', {
                count: expression.length,
                limit: FORMULA_LIMITS.length,
              })}
            </span>
          </>
        )}
      </footer>
    </section>
  );
}

export default FormulaPopover;
