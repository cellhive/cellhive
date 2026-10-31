import {
  AI_FORMULA_MAX_DESCRIPTION_LENGTH,
  AI_FORMULA_MAX_FORMULA_LENGTH,
} from '@cellhive/contracts';
import { Button, Input, Skeleton } from '@cellhive/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CircleAlert, Sparkles } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AiWaiting } from '../../../lib/ai/AiWaiting';
import { aiApi } from '../../../lib/api/ai';
import { translateError } from '../../../lib/errors/translate';
import { fieldsQuery } from '../../../lib/query/queries';

import { FormulaText } from './FormulaText';

import type { FormulaSchema } from '../model/schema';
import type { AiFormulaRequest } from '@cellhive/contracts';

/** Codes with a sentence of the formula editor (BACKLOG T913); others use `errors:codes`. */
const OWN_ERRORS = ['AI_INVALID_OUTPUT', 'AI_TIMEOUT', 'AI_QUOTA_EXCEEDED'] as const;

export interface AiFormulaBoxProps {
  readonly tableId: string;
  /** The field being edited (absent: a new one). */
  readonly fieldId: string | undefined;
  readonly schema: FormulaSchema;
  /** The text of the editor, sent as `current` (the model may fix or extend it). */
  readonly expression: string;
  /** "Use": the suggestion replaces the editor's text (its preview runs as usual). */
  readonly onUse: (formula: string) => void;
}

/**
 * "Write the formula with AI" above the formula editor (T913, research S8
 * §5.3, CONTRACTS §29.2): a description → "Write formula" → a checked
 * suggestion (chips like the editor, result type, the model's explanation as
 * plain text, how many tries) with "Use" / "Dismiss"; nothing is saved. A
 * lazy chunk the editor renders only when `useAiFormulaEntry` says so (AI on,
 * schema rights): without AI nothing of it is downloaded. The wait (up to
 * 90 s) says so and can be cancelled; leaving the editor cancels it too.
 */
export function AiFormulaBox({ tableId, fieldId, schema, expression, onUse }: AiFormulaBoxProps) {
  const { t, i18n } = useTranslation(['formula', 'errors', 'common']);
  const inputId = useId();
  const errorId = useId();
  const fields = useQuery(fieldsQuery(tableId));
  const [description, setDescription] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );
  const ask = useMutation({
    mutationFn: (body: AiFormulaRequest) => {
      controller.current?.abort();
      const next = new AbortController();
      controller.current = next;
      return aiApi.formula(tableId, body, next.signal);
    },
  });

  // `field_id` only for a saved formula or lookup (a field changing type is neither yet).
  const savedType = fields.data?.items.find((field) => field.id === fieldId)?.type;
  const editing = savedType === 'formula' || savedType === 'lookup' ? (fieldId ?? null) : null;
  const trimmed = description.trim();
  const submit = () => {
    if (trimmed === '' || ask.isPending) return;
    ask.mutate({
      description: trimmed,
      current:
        expression.trim() === '' || expression.length > AI_FORMULA_MAX_FORMULA_LENGTH
          ? null
          : expression,
      field_id: editing as AiFormulaRequest['field_id'],
    });
  };
  // The waiting line or the card goes: the focus goes back to the description.
  const backToInput = () => {
    ask.reset();
    document.getElementById(inputId)?.focus();
  };
  const cancel = () => {
    controller.current?.abort();
    backToInput();
  };
  const suggestion = ask.data;
  const error =
    ask.error === null
      ? null
      : translateError(ask.error, i18n, {
          overrides: Object.fromEntries(
            OWN_ERRORS.map((code) => [code, `formula:ai.errors.${code}`]),
          ),
        }).message;

  return (
    <section className="flex flex-col gap-2 motion-safe:animate-reveal" data-testid="formula-ai">
      {/* Not a <form>: the editor sits inside the field dialog's form (no nested forms). */}
      <div className="flex flex-wrap items-center gap-2">
        <label
          htmlFor={inputId}
          className="flex shrink-0 items-center gap-1.5 text-label text-fg-muted"
        >
          <Sparkles aria-hidden="true" className="size-3.5 text-accent" />
          {t('formula:ai.label')}
        </label>
        <Input
          id={inputId}
          value={description}
          maxLength={AI_FORMULA_MAX_DESCRIPTION_LENGTH}
          placeholder={t('formula:ai.placeholder')}
          autoComplete="off"
          readOnly={ask.isPending}
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : errorId}
          className="h-8 min-w-48 flex-1 max-lg:h-control"
          data-testid="formula-ai-description"
          onChange={(event) => {
            setDescription(event.target.value);
          }}
          onKeyDown={(event) => {
            // Enter writes (and never submits the field dialog's form); not while an IME composes.
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
            event.preventDefault();
            submit();
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          className="h-8 max-lg:h-control"
          disabled={trimmed === '' || ask.isPending}
          data-testid="formula-ai-write"
          onClick={submit}
        >
          <Sparkles aria-hidden="true" className="size-3.5" />
          {t('formula:ai.write')}
        </Button>
      </div>
      {/* Read once a suggestion arrives; the card with its buttons stays out of the live region. */}
      <p role="status" className="sr-only">
        {suggestion === undefined ? '' : t('formula:ai.ready', { formula: suggestion.formula })}
      </p>
      {ask.isPending ? (
        <AiWaiting
          text={t('formula:ai.waiting')}
          later={t('formula:ai.waitingLater')}
          hint={t('formula:ai.waitingHint')}
          cancelLabel={t('common:actions.cancel')}
          onCancel={cancel}
        >
          <Skeleton className="h-4 w-[55%]" />
          <Skeleton className="h-3 w-[80%]" />
        </AiWaiting>
      ) : null}
      {error === null ? null : (
        <p
          id={errorId}
          role="alert"
          className="flex items-start gap-1.5 text-label font-normal text-danger"
          data-testid="formula-ai-error"
        >
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}
      {suggestion === undefined ? null : (
        <div
          className="flex flex-col gap-2 rounded-md border border-line bg-surface-sunken px-3 py-2.5 motion-safe:animate-reveal"
          data-testid="formula-ai-suggestion"
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-label">
            <span className="flex items-center gap-1.5 text-fg">
              <Sparkles aria-hidden="true" className="size-3.5 text-accent" />
              {t('formula:ai.suggestion')}
            </span>
            <span className="inline-flex h-[22px] items-center rounded-sm bg-option-5 px-2 text-on-option-5">
              {suggestion.result_type.list
                ? t('formula:result.list', {
                    kind: t(`formula:result.kinds.${suggestion.result_type.kind}`),
                  })
                : t(`formula:result.kinds.${suggestion.result_type.kind}`)}
            </span>
            <span className="font-normal text-fg-muted" data-testid="formula-ai-attempts">
              {t('formula:ai.tries', { count: suggestion.attempts })}
            </span>
          </div>
          {/* Long answers scroll inside the card (≤ 4,000 + 1,000 characters). */}
          <div
            tabIndex={0}
            aria-label={t('formula:ai.suggestion')}
            className="flex max-h-32 flex-col gap-1.5 overflow-y-auto rounded-sm focus-visible:outline-2 focus-visible:outline-accent"
          >
            <div
              className="rounded-sm border border-line bg-surface px-2 py-1"
              data-testid="formula-ai-formula"
            >
              <FormulaText source={suggestion.formula} schema={schema} />
            </div>
            {suggestion.explanation === '' ? null : (
              <p
                className="text-body leading-normal whitespace-pre-wrap text-fg"
                data-testid="formula-ai-explanation"
              >
                {suggestion.explanation}
              </p>
            )}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" size="sm" className="max-lg:h-control" onClick={backToInput}>
              {t('formula:ai.dismiss')}
            </Button>
            <Button
              size="sm"
              className="max-lg:h-control"
              data-testid="formula-ai-use"
              onClick={() => {
                onUse(suggestion.formula);
                ask.reset();
              }}
            >
              {t('formula:ai.use')}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

export default AiFormulaBox;
