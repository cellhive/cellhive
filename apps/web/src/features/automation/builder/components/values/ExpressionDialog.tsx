import { Button, Dialog, FormField, Input, Spinner } from '@cellhive/ui';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { automationsApi } from '../../../../../lib/api/automations';
import { ErrorAlert } from '../../../../../lib/errors/ErrorAlert';
import { translateDetail } from '../../../../../lib/errors/translate';
import { templateSteps, type ValueScope } from '../../model/scope';

export interface ExpressionDialogProps {
  readonly baseId: string;
  readonly scope: ValueScope;
  readonly onCancel: () => void;
  /** The expression as stored (ids) and as shown (names). */
  readonly onInsert: (stored: string, display: string) => void;
}

/**
 * "Formula expression…" of the value menu: a formula on the trigger record
 * typed with names (`IF([Amount] > 1000, "big", "small")`), checked by the
 * server like a saved template (`validate-template`, CONTRACTS §21; `REGEX*`
 * refused — BACKLOG S5 decision 2) and inserted as one chip stored with
 * ids. (T522) A refused `REGEX*` call says to compute it in a formula
 * field and insert that field instead (S4b-followup §1.4.3).
 */
export function ExpressionDialog({ baseId, scope, onCancel, onInsert }: ExpressionDialogProps) {
  const { t, i18n } = useTranslation(['automationBuilder', 'errors']);
  const [expression, setExpression] = useState('');
  const check = useMutation({
    mutationFn: (source: string) =>
      automationsApi.validateTemplate(baseId, {
        table_id: scope.triggerTableId,
        template: `{{ ${source} }}`,
        form: 'display',
        trigger_type: scope.triggerType,
        steps: templateSteps(scope),
      }),
    onSuccess: (result) => {
      const placeholder = result.placeholders[0];
      if (result.valid && placeholder !== undefined)
        onInsert(placeholder.stored, placeholder.display);
    },
  });
  const problems = check.data !== undefined && !check.data.valid ? check.data.errors : [];
  // `REGEX*` is refused in automations (BACKLOG S5 decision 2): say what to do instead.
  const regex = problems.find((problem) => problem.code === 'UNSUPPORTED_FUNCTION');
  const submit = () => {
    if (expression.trim() === '' || check.isPending) return;
    check.mutate(expression.trim());
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={t('expression.title')}
      description={t('expression.description')}
      closeLabel={t('expression.cancel')}
      className="max-w-[520px]"
      layout="sheet"
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <FormField
          label={t('expression.label')}
          hint={t('expression.hint')}
          error={
            problems.length === 0
              ? undefined
              : problems.map((problem) => translateDetail(i18n, problem)).join(' ')
          }
        >
          {(control) => (
            <Input
              {...control}
              value={expression}
              spellCheck={false}
              autoComplete="off"
              className="font-code"
              data-testid="expression-input"
              onChange={(event) => {
                setExpression(event.target.value);
              }}
            />
          )}
        </FormField>
        {regex === undefined ? null : (
          <p className="text-label font-normal text-fg" data-testid="expression-regex-hint">
            {t('expression.regexHint', {
              name:
                typeof regex.params?.['function'] === 'string' ? regex.params['function'] : 'REGEX',
            })}
          </p>
        )}
        {check.isError ? <ErrorAlert error={check.error} /> : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            {t('expression.cancel')}
          </Button>
          <Button type="submit" disabled={expression.trim() === '' || check.isPending}>
            {check.isPending ? <Spinner /> : null}
            {t('expression.insert')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
