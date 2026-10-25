import { formatComputedText, type ComputedStyle } from '@cellhive/field-types';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../lib/api/client';
import { translateDetail } from '../../../lib/errors/translate';
import { useFormatters } from '../../../lib/i18n/format';
import { usePreviewRows } from '../data';
import { analyzeFormula, type Diagnostic } from '../model/analysis';
import { formulaContext } from '../model/context';
import { editorMessageKey } from '../model/messages';
import { evaluateRows, isEmptyValue, type PreviewRow } from '../model/preview';
import { lineColumn } from '../model/scan';
import { activeSignature } from '../model/signature';
import { useServerPreview } from '../use-server-preview';

import { useEditorTexts } from './editor-texts';

import type { FormulaSchema } from '../model/schema';
import type { ComputedResultTypeDto, FieldDto } from '@cellhive/contracts';

/**
 * What the formula editor computes from the text being written (T466),
 * shared by the dialog and the popover of the column header (T468,
 * BACKLOG S4b additional decision #12): analysis and diagnostics (client,
 * then server preview and save errors), the result type, the preview rows
 * (browser for same-row formulas, server otherwise), the signature and the
 * variables at the caret.
 */

/** Diagnostics shown after typing pauses (not on every keystroke). */
const DIAGNOSTICS_DELAY_MS = 400;

function useDebounced<T>(value: T, delay: number): T {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setShown(value);
    }, delay);
    return () => {
      window.clearTimeout(timer);
    };
  }, [value, delay]);
  return shown;
}

/** `errors[]` of a `422 FORMULA_*` answer as editor diagnostics (positions in `source`). */
export function serverDiagnostics(error: unknown, source: string): Diagnostic[] {
  if (!isApiError(error) || !error.code.startsWith('FORMULA_')) return [];
  return error.errors.map((item) => {
    const position = item.params?.['position'] as { start?: unknown; length?: unknown } | undefined;
    const start = typeof position?.start === 'number' ? position.start : 0;
    const length = typeof position?.length === 'number' ? position.length : 0;
    const { line, column } = lineColumn(source, start);
    return { start, length, code: item.code, params: item.params ?? {}, line, column };
  });
}

export interface FormulaSessionInput {
  readonly tableId: string;
  readonly fieldId: FieldDto['id'] | undefined;
  readonly schema: FormulaSchema;
  readonly timeZone: string;
  readonly expression: string;
  readonly caret: number;
  readonly style: Readonly<Record<string, unknown>> | null;
  readonly styleTouched: boolean;
  /** The last save failed with this error for this text. */
  readonly saveError: { readonly error: unknown; readonly source: string } | null;
}

export function useFormulaSession({
  tableId,
  fieldId,
  schema,
  timeZone,
  expression,
  caret,
  style,
  styleTouched,
  saveError,
}: FormulaSessionInput) {
  const { t, i18n } = useTranslation(['formula', 'errors', 'common']);
  const format = useFormatters();
  const texts = useEditorTexts();
  const locale = i18n.language.startsWith('vi') ? 'vi' : 'en';

  const env = useMemo(() => ({ schema, texts }), [schema, texts]);
  const editor = useMemo(() => analyzeFormula(expression, schema), [expression, schema]);
  const trimmed = expression.trim();
  const clientDiagnostics = trimmed === '' ? [] : editor.diagnostics;
  const rows = usePreviewRows(tableId);
  const primaryFieldId =
    schema.tables.find((table) => table.id === tableId)?.fields.find((field) => field.isPrimary)
      ?.id ?? null;
  const now = useMemo(() => new Date(), []);

  const chosenStyle = styleTouched ? style : (editor.analysis.style ?? null);
  const server = useServerPreview(
    trimmed === '' || clientDiagnostics.length > 0 || editor.sameRow
      ? null
      : {
          tableId,
          fieldId,
          expression,
          style: styleTouched ? style : undefined,
          recordIds: rows?.map((row) => row.id),
        },
  );
  const serverErrors =
    server.expression === expression ? serverDiagnostics(server.error, expression) : [];
  const saveErrors =
    saveError !== null && saveError.source === expression
      ? serverDiagnostics(saveError.error, expression)
      : [];
  const diagnostics =
    clientDiagnostics.length > 0 ? clientDiagnostics : [...serverErrors, ...saveErrors];
  const shownDiagnostics = useDebounced(diagnostics, DIAGNOSTICS_DELAY_MS);
  // Errors disappear at once when fixed; they appear after a pause.
  const visibleDiagnostics = diagnostics.length === 0 ? diagnostics : shownDiagnostics;

  const resultType: ComputedResultTypeDto | null =
    clientDiagnostics.length > 0 || trimmed === ''
      ? null
      : (server.data?.result_type ?? editor.resultType);
  const computeMode = server.data?.compute_mode ?? editor.analysis.compute_mode;

  // Preview rows: computed here for same-row formulas, by the server otherwise.
  const local = useMemo(
    () =>
      editor.sameRow && rows !== undefined && trimmed !== ''
        ? evaluateRows(editor, rows, primaryFieldId, timeZone, now)
        : null,
    [editor, rows, primaryFieldId, timeZone, now, trimmed],
  );
  const previewRows: PreviewRow[] | null =
    local ??
    (server.data === undefined
      ? null
      : server.data.records.map((record) => {
          const row = rows?.find((item) => item.id === record.id);
          const title = primaryFieldId === null ? '' : row?.fields[primaryFieldId];
          return {
            id: record.id,
            title: typeof title === 'string' ? title : '',
            value: record.value,
          };
        }));
  const loadingServer = !editor.sameRow && server.loading;
  const stale = loadingServer && server.data !== undefined;

  const formatValue = (value: unknown): string => {
    if (resultType === null || isEmptyValue(value)) return '';
    if (resultType.kind === 'record') {
      const count = Array.isArray(value) ? value.length : 1;
      return t('formula:preview.records', { count });
    }
    return formatComputedText(value, resultType, chosenStyle as ComputedStyle | null, {
      locale: format.locale,
      timeZone,
    });
  };

  const translate = (item: Diagnostic): string => {
    const key = editorMessageKey(item);
    if (key !== null && i18n.exists(key)) return t(key, item.params);
    return translateDetail(i18n, { code: item.code, params: item.params });
  };

  const signature = useMemo(
    () => (trimmed === '' ? null : activeSignature(expression, caret, schema, locale)),
    [expression, caret, schema, locale, trimmed],
  );
  const variables = useMemo(() => {
    const context = formulaContext(expression.slice(0, caret), schema);
    return context.variables;
  }, [expression, caret, schema]);

  return {
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
    blocked: trimmed === '' || diagnostics.length > 0,
  };
}
