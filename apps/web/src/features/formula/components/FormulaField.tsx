import { Button, Skeleton } from '@cellhive/ui';
import { Copy, Monitor, Pencil } from 'lucide-react';
import { lazy, Suspense, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { showToast } from '../../../lib/toast/toast';
import { useFormulaEnvironment } from '../data';
import { analyzeFormula } from '../model/analysis';

import { FormulaText } from './FormulaText';

import type { FormulaFieldProps } from '../../../lib/schema/formula-tools';

/** The editor with CodeMirror: its own chunk, loaded when it is opened (BACKLOG S4b #9). */
const FormulaEditorDialog = lazy(() => import('./FormulaEditorDialog'));

/**
 * The formula of a formula field in the field dialog (T466): the formula
 * read-only with its chips, what it gives (result type, stored or computed
 * on read) and what it reads, and the button that opens the editor. Below
 * 768 px the formula is read-only (board "S4b · Công thức trên mobile",
 * FRONTEND §9.4): a note to edit on a larger screen and "Copy formula".
 */
export function FormulaField({
  tableId,
  field,
  fieldName,
  value,
  onChange,
  onSave,
  missing,
}: FormulaFieldProps) {
  const { t } = useTranslation(['formula', 'common']);
  const labelId = useId();
  const env = useFormulaEnvironment(tableId, field?.id);
  const [open, setOpen] = useState(false);
  const expression = value.expression.trim();
  const analysis = useMemo(
    () =>
      env.schema === null || expression === ''
        ? null
        : analyzeFormula(value.expression, env.schema),
    [env.schema, expression, value.expression],
  );
  const resultType = analysis?.resultType ?? field?.result_type ?? null;
  const mode = analysis?.analysis.compute_mode ?? field?.compute_mode ?? null;

  const copy = () => {
    void navigator.clipboard.writeText(value.expression).then(
      () => {
        showToast({ variant: 'success', message: t('formula:field.copied') });
      },
      () => {
        showToast({ variant: 'error', message: t('formula:field.copyFailed') });
      },
    );
  };

  return (
    <div className="flex flex-col gap-3" data-testid="formula-field">
      <div className="flex flex-col gap-1.5">
        <span id={labelId} className="text-label text-fg">
          {t('formula:editor.label')}
        </span>
        <div
          role="textbox"
          aria-readonly="true"
          aria-multiline="true"
          aria-labelledby={labelId}
          className="min-h-10 rounded-md border border-line bg-surface-sunken px-3 py-1.5 leading-[26px]"
          data-testid="formula-field-text"
        >
          {expression === '' ? (
            <span className="text-body text-fg-subtle">{t('formula:field.empty')}</span>
          ) : env.schema === null ? (
            <span className="font-mono text-body break-words whitespace-pre-wrap">
              {value.expression}
            </span>
          ) : (
            <FormulaText source={value.expression} schema={env.schema} />
          )}
        </div>
        {missing === true ? (
          <p role="alert" className="text-label font-normal text-danger">
            {t('formula:field.missing')}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2 max-md:hidden">
          <Button
            variant="secondary"
            onClick={() => {
              setOpen(true);
            }}
            disabled={env.schema === null}
            data-testid="formula-open-editor"
          >
            <Pencil aria-hidden="true" className="size-3.5" />
            {expression === '' ? t('formula:field.write') : t('formula:field.edit')}
          </Button>
        </div>
        <div className="flex flex-col gap-3 md:hidden">
          <div className="flex gap-2.5 rounded-lg bg-accent-soft p-3 leading-normal text-fg">
            <Monitor aria-hidden="true" className="mt-0.5 size-4.5 shrink-0 text-accent" />
            <span className="flex flex-col gap-0.5">
              <strong className="text-heading">{t('formula:field.mobileTitle')}</strong>
              <span>{t('formula:field.mobileBody')}</span>
            </span>
          </div>
          {expression === '' ? null : (
            <Button variant="secondary" className="h-11" onClick={copy}>
              <Copy aria-hidden="true" className="size-3.5" />
              {t('formula:field.copy')}
            </Button>
          )}
        </div>
      </div>

      <dl className="grid gap-x-4 gap-y-2 text-body sm:grid-cols-[auto_1fr]">
        {resultType === null ? null : (
          <>
            <dt className="text-label font-normal text-fg-muted">{t('formula:result.type')}</dt>
            <dd data-testid="formula-field-result">
              {resultType.list
                ? t('formula:result.list', { kind: t(`formula:result.kinds.${resultType.kind}`) })
                : t(`formula:result.kinds.${resultType.kind}`)}
            </dd>
          </>
        )}
        {mode === null ? null : (
          <>
            <dt className="text-label font-normal text-fg-muted">{t('formula:mode.label')}</dt>
            <dd>{mode === 'virtual' ? t('formula:mode.virtual') : t('formula:mode.stored')}</dd>
          </>
        )}
        {analysis === null || analysis.dependencies.length === 0 ? null : (
          <>
            <dt className="text-label font-normal text-fg-muted">{t('formula:field.uses')}</dt>
            <dd className="flex flex-wrap gap-1.5">
              {analysis.dependencies.map((dependency) => (
                <span
                  key={dependency.tableId}
                  className="inline-flex h-[22px] items-center rounded-sm bg-option-0 px-2 text-label text-on-option-0"
                >
                  {dependency.tableId === tableId
                    ? dependency.fields.join(', ')
                    : dependency.fields.length === 0
                      ? dependency.tableName
                      : `${dependency.tableName}: ${dependency.fields.join(', ')}`}
                </span>
              ))}
            </dd>
          </>
        )}
      </dl>

      {open && env.schema !== null ? (
        <Suspense
          fallback={
            <div role="status" aria-label={t('common:loading')}>
              <Skeleton className="h-8 w-40" />
            </div>
          }
        >
          <FormulaEditorDialog
            tableId={tableId}
            fieldId={field?.id}
            fieldName={fieldName}
            tableName={env.tableName}
            schema={env.schema}
            timeZone={env.timeZone ?? 'UTC'}
            currency={env.currency ?? 'VND'}
            initial={value}
            onCancel={() => {
              setOpen(false);
            }}
            onConfirm={async (next) => {
              onChange(next);
              const outcome = await onSave(next);
              if (!outcome.ok && outcome.formError) setOpen(false);
              return outcome;
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

export default FormulaField;
