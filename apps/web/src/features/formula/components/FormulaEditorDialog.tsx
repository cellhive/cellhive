import { Button, cn, Spinner } from '@cellhive/ui';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  HelpCircle,
  WandSparkles,
  X,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../lib/api/client';
import { useFormatters } from '../../../lib/i18n/format';
import { FormulaInput, type FormulaInputHandle } from '../editor/FormulaInput';
import { FORMULA_LIMITS } from '../model/analysis';
import { formatFormula } from '../model/format';
import { isEmptyValue } from '../model/preview';

import { Catalogue } from './Catalogue';
import { useFormulaSession } from './formula-session';
import { StylePanel } from './StylePanel';

import type { FormulaDraft, FormulaSaveOutcome } from '../../../lib/schema/formula-tools';
import type { FormulaSchema } from '../model/schema';
import type { FieldDto } from '@cellhive/contracts';

/**
 * "Trình soạn công thức" (T466, SPEC §9.6; boards "S4b · Trình soạn công
 * thức - dialog", "- tối", "Gợi ý khi gõ công thức", "Lỗi trong trình soạn
 * công thức"): CodeMirror text area with chips and autocomplete, errors
 * under it, the preview of the first rows (browser for same-row formulas,
 * server otherwise), the signature bar, the function catalogue, the format
 * of the result, and "Confirm" that saves the field.
 */

export interface FormulaEditorDialogProps {
  readonly tableId: string;
  readonly fieldId: FieldDto['id'] | undefined;
  readonly fieldName: string;
  readonly tableName: string;
  readonly schema: FormulaSchema;
  readonly timeZone: string;
  readonly currency: string;
  readonly initial: FormulaDraft;
  readonly onCancel: () => void;
  readonly onConfirm: (value: FormulaDraft) => Promise<FormulaSaveOutcome>;
}

export function FormulaEditorDialog({
  tableId,
  fieldId,
  fieldName,
  tableName,
  schema,
  timeZone,
  currency,
  initial,
  onCancel,
  onConfirm,
}: FormulaEditorDialogProps) {
  const { t } = useTranslation(['formula', 'errors', 'common']);
  const format = useFormatters();
  const titleId = useId();
  const errorsId = useId();
  const reasonId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const input = useRef<FormulaInputHandle>(null);
  const [expression, setExpression] = useState(initial.expression);
  const [style, setStyle] = useState(initial.style);
  const [styleTouched, setStyleTouched] = useState(initial.styleTouched);
  const [caret, setCaret] = useState(initial.expression.length);
  const [rowIndex, setRowIndex] = useState(0);
  const [guide, setGuide] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ error: unknown; source: string } | null>(null);
  const {
    env,
    editor,
    trimmed,
    clientDiagnostics,
    diagnostics,
    visibleDiagnostics,
    server,
    resultType,
    computeMode,
    chosenStyle,
    previewRows,
    loadingServer,
    stale,
    formatValue,
    translate,
    signature,
    variables,
    blocked,
  } = useFormulaSession({
    tableId,
    fieldId,
    schema,
    timeZone,
    expression,
    caret,
    style,
    styleTouched,
    saveError,
  });
  const rowCount = previewRows?.length ?? 0;
  const index = rowCount === 0 ? 0 : Math.min(rowIndex, rowCount - 1);
  const current = previewRows?.[index];

  const dirty =
    expression !== initial.expression ||
    styleTouched !== initial.styleTouched ||
    JSON.stringify(style) !== JSON.stringify(initial.style);
  const tooLong = expression.length > FORMULA_LIMITS.length;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null || dialog.open) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    input.current?.focus();
  }, []);

  const requestClose = () => {
    if (dirty && !saving) setConfirmingDiscard(true);
    else onCancel();
  };

  const confirm = () => {
    if (blocked || saving) return;
    setSaving(true);
    setSaveError(null);
    const source = expression;
    void onConfirm({ expression: source, style, styleTouched }).then((outcome) => {
      setSaving(false);
      if (!outcome.ok && !outcome.formError) setSaveError({ error: outcome.error, source });
    });
  };

  const reformat = () => {
    const ast = editor.analysis.ast;
    if (ast === null || clientDiagnostics.length > 0) return;
    input.current?.replaceAll(formatFormula(ast));
  };

  const dependencies = editor.dependencies
    .map((dependency) =>
      dependency.tableId === tableId
        ? dependency.fields.join(', ')
        : dependency.fields.length === 0
          ? dependency.tableName
          : `${dependency.tableName} (${dependency.fields.join(', ')})`,
    )
    .join(', ');

  const virtualReason = editor.analysis.virtual_reason;
  const virtualText =
    virtualReason === null
      ? t('formula:mode.virtual')
      : virtualReason.kind === 'volatile_function'
        ? t('formula:mode.virtualVolatile', { function: virtualReason.function })
        : t('formula:mode.virtualDependency', {
            field:
              schema.tables
                .flatMap((table) => table.fields)
                .find((field) => field.id === virtualReason.field_id)?.name ?? '',
          });

  let previewArea: ReactNode;
  if (visibleDiagnostics.length > 0) {
    previewArea = (
      <div id={errorsId} role="alert" className="px-3 py-1.5" data-testid="formula-errors">
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
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-label font-normal leading-normal text-fg hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-accent"
              >
                <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-danger" />
                <span className="min-w-0 flex-1">{translate(item)}</span>
                <span className="mt-0.5 font-mono text-mono whitespace-nowrap text-fg-muted">
                  <span className="sr-only">{t('formula:errors.at')}</span>
                  {`${String(item.line)}:${String(item.column)}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  } else {
    previewArea = (
      <div className="flex min-h-11 flex-wrap items-center gap-x-2.5 gap-y-1 px-5 py-1.5">
        <span id={errorsId} className="sr-only">
          {trimmed === '' ? '' : t('formula:errors.none')}
        </span>
        <span
          role="status"
          aria-live="polite"
          className={cn('flex min-w-0 flex-1 items-baseline gap-2', stale && 'opacity-60')}
          data-testid="formula-preview-value"
        >
          <span className="font-mono text-body text-fg-muted" aria-hidden="true">
            =
          </span>
          {trimmed === '' ? (
            <span className="text-label font-normal text-fg-muted">
              {t('formula:preview.empty')}
            </span>
          ) : diagnostics.length > 0 ? null : current === undefined ? (
            loadingServer ? (
              <Spinner />
            ) : server.error !== null && !editor.sameRow ? (
              <span className="text-label font-normal text-danger">
                {isApiError(server.error) && server.error.code === 'QUERY_TIMEOUT'
                  ? t('formula:preview.timeout')
                  : t('formula:preview.failed')}
              </span>
            ) : (
              <span className="text-label font-normal text-fg-muted">
                {t('formula:preview.noRows')}
              </span>
            )
          ) : isEmptyValue(current.value) ? (
            <span className="text-heading font-normal text-fg-muted italic">
              {t('formula:preview.blank')}
            </span>
          ) : (
            <span className="truncate text-heading text-fg tabular-nums">
              {formatValue(current.value)}
            </span>
          )}
        </span>
        {rowCount > 0 ? (
          <span className="flex shrink-0 items-center gap-0.5 border-l border-line pl-2.5">
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
              className="text-label font-normal whitespace-nowrap text-fg-muted tabular-nums"
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
        {current !== undefined && isEmptyValue(current.value) && trimmed !== '' ? (
          <p className="basis-full text-label font-normal text-fg-muted">
            {t('formula:preview.blankHint')}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      data-motion="center"
      onCancel={(event) => {
        event.preventDefault();
        if (confirmingDiscard) setConfirmingDiscard(false);
        else requestClose();
      }}
      className="m-auto flex h-[min(828px,calc(100dvh-2rem))] w-[min(1220px,calc(100vw-2rem))] max-w-none flex-col overflow-hidden rounded-lg border border-line bg-surface p-0 text-body text-fg shadow-popover backdrop:bg-overlay"
      data-testid="formula-editor"
    >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line pr-3 pl-5">
        <h2 id={titleId} className="text-heading text-fg">
          {t('formula:editor.title')}
        </h2>
        <span className="truncate text-label font-normal text-fg-muted">
          {t('formula:editor.subtitle', {
            field: fieldName === '' ? t('formula:editor.newField') : fieldName,
            table: tableName,
          })}
        </span>
        <span className="ml-auto flex shrink-0 gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={reformat}
            disabled={editor.analysis.ast === null || clientDiagnostics.length > 0}
          >
            <WandSparkles aria-hidden="true" className="size-3.5" />
            {t('formula:editor.reformat')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={guide}
            onClick={() => {
              setGuide((value) => !value);
            }}
          >
            <HelpCircle aria-hidden="true" className="size-3.5" />
            {t('formula:editor.guide')}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('common:actions.close')}
            onClick={requestClose}
          >
            <X aria-hidden="true" />
          </Button>
        </span>
      </header>

      <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_300px] lg:overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="flex min-w-0 flex-col gap-2 px-5 pt-4">
            <div className="flex items-center gap-2">
              <span className="text-label text-fg-muted">{t('formula:editor.label')}</span>
              <span className="ml-auto text-label font-normal text-fg-muted">
                {t('formula:editor.newlineHint')}
              </span>
            </div>
            {/* The editor's own scroller scrolls a long formula (T527): suggestions placed
                "absolute" by CodeMirror (opened while the dialog still animates) then overflow
                the editor box instead of making a scroll region of this wrapper. */}
            <div className="[&_.cm-scroller]:max-h-[calc(14rem-2px)] [&_.cm-scroller]:overflow-y-auto">
              <FormulaInput
                ref={input}
                value={expression}
                env={env}
                diagnostics={visibleDiagnostics}
                label={t('formula:editor.label')}
                describedBy={errorsId}
                onChange={(text) => {
                  setExpression(text);
                  setConfirmingDiscard(false);
                }}
                onCaret={setCaret}
                onConfirm={confirm}
                autoFocus
              />
            </div>
          </div>
          <div className="mt-2 flex min-h-0 flex-1 flex-col border-t border-line">
            {previewArea}
            {editor.perfWarning ? (
              <div
                role="note"
                className="mx-5 mb-2 flex gap-2 rounded-md border border-option-3 bg-option-3 px-3 py-2 text-label font-normal text-on-option-3"
                data-testid="formula-perf-warning"
              >
                <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {computeMode === 'virtual'
                    ? t('formula:perf.virtual')
                    : t('formula:perf.wrapped')}
                </span>
              </div>
            ) : null}
            {signature === null ? null : (
              <div
                role="note"
                aria-label={t('formula:signature.label')}
                className="flex flex-col gap-1 border-y border-line bg-surface-sunken px-5 py-2.5"
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
                  <span className="text-label font-normal leading-normal text-fg-muted">
                    <strong className="font-semibold text-fg">
                      {signature.parts.find((part) => part.active)?.text ?? ''}
                    </strong>
                    {`: ${t(`formula:paramKinds.${signature.param.kind}`)}`}
                  </span>
                )}
              </div>
            )}
            <div className="flex min-h-72 flex-1 flex-col border-t border-line lg:min-h-0">
              <Catalogue
                schema={schema}
                variables={variables}
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
        </div>

        <aside
          aria-label={t('formula:result.label')}
          className="flex flex-col gap-3.5 border-t border-line bg-canvas px-5 py-4 lg:overflow-y-auto lg:border-t-0 lg:border-l"
          data-testid="formula-result"
        >
          <div className="flex flex-col gap-1.5">
            <span className="text-label text-fg-muted">{t('formula:result.type')}</span>
            {resultType === null ? (
              <span className="text-label font-normal text-fg-muted">
                {t('formula:result.unknown')}
              </span>
            ) : (
              <span
                className="inline-flex h-[22px] items-center self-start rounded-sm bg-option-5 px-2 text-label text-on-option-5"
                data-testid="formula-result-type"
              >
                {resultType.list
                  ? t('formula:result.list', { kind: t(`formula:result.kinds.${resultType.kind}`) })
                  : t(`formula:result.kinds.${resultType.kind}`)}
              </span>
            )}
          </div>
          {resultType === null || resultType.list ? null : (
            <StylePanel
              resultType={resultType}
              style={chosenStyle}
              onChange={(next) => {
                setStyle(next);
                setStyleTouched(true);
              }}
              sample={current?.value}
              locale={format.locale}
              timeZone={timeZone}
              defaultCurrency={currency}
            />
          )}
          {resultType === null ? null : (
            <div className="flex flex-col gap-1" data-testid="formula-compute-mode">
              <span className="text-label text-fg-muted">{t('formula:mode.label')}</span>
              <span className="leading-normal">
                {computeMode === 'virtual' ? virtualText : t('formula:mode.stored')}
              </span>
            </div>
          )}
        </aside>
      </div>

      <footer className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-line py-2 pr-4 pl-5 text-label font-normal text-fg-muted tabular-nums">
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
                autoFocus
                onClick={() => {
                  setConfirmingDiscard(false);
                  input.current?.focus();
                }}
              >
                {t('formula:discard.keep')}
              </Button>
              <Button variant="danger" onClick={onCancel}>
                {t('formula:discard.discard')}
              </Button>
            </span>
          </div>
        ) : (
          <>
            {diagnostics.length > 0 ? (
              <span className="text-danger">
                {t('formula:errors.count', { count: diagnostics.length })}
              </span>
            ) : editor.perfWarning ? (
              <span className="text-warning">{t('formula:perf.footer')}</span>
            ) : null}
            <span className={cn(tooLong && 'text-danger')}>
              {t('formula:footer.length', {
                count: expression.length,
                limit: FORMULA_LIMITS.length,
              })}
            </span>
            <span>
              {t('formula:footer.filters', {
                count: editor.crossTableFilters,
                limit: FORMULA_LIMITS.crossTableFilters,
              })}
            </span>
            {dependencies === '' ? null : (
              <span className="min-w-0 truncate" title={dependencies}>
                {t('formula:footer.dependencies', { list: dependencies })}
              </span>
            )}
            <span className="ml-auto flex items-center gap-2">
              {blocked && trimmed !== '' ? (
                <span id={reasonId} className="text-danger">
                  {t('formula:footer.fixToConfirm', { count: diagnostics.length })}
                </span>
              ) : blocked ? (
                <span id={reasonId}>{t('formula:footer.writeToConfirm')}</span>
              ) : null}
              <Button variant="secondary" onClick={requestClose}>
                {t('common:actions.cancel')}
              </Button>
              <Button
                aria-disabled={blocked || saving}
                aria-describedby={blocked ? reasonId : undefined}
                className={cn((blocked || saving) && 'cursor-not-allowed opacity-60')}
                onClick={confirm}
                data-testid="formula-confirm"
              >
                {saving ? <Spinner /> : null}
                {t('formula:editor.confirm')}
              </Button>
            </span>
          </>
        )}
      </footer>
    </dialog>
  );
}

export default FormulaEditorDialog;
