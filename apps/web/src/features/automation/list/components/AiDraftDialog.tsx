import {
  AI_AUTOMATION_MAX_PROMPT_LENGTH,
  type AiAutomationDraft,
  type AiAutomationDraftRequest,
  type BaseDetail,
} from '@cellhive/contracts';
import { Alert, Button, Dialog, FormField, Select, Skeleton } from '@cellhive/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AiWaiting } from '../../../../lib/ai/AiWaiting';
import { aiApi } from '../../../../lib/api/ai';
import { translateError } from '../../../../lib/errors/translate';
import { canManageAutomations } from '../../../../lib/permissions/access';
import { fieldsQuery, tablesQuery } from '../../../../lib/query/queries';
import { draftExamples } from '../model/ai-examples';

/** Codes with a sentence of this dialog (BACKLOG T913); others use `errors:codes`. */
const OWN_ERRORS = ['AI_INVALID_OUTPUT', 'AI_TIMEOUT', 'AI_QUOTA_EXCEEDED'] as const;

export interface AiDraftDialogProps {
  readonly base: BaseDetail;
  readonly onCancel: () => void;
  /** The checked draft: the builder opens it unsaved (it is never saved or turned on here). */
  readonly onDraft: (draft: AiAutomationDraft) => void;
}

/**
 * "Create with AI" (T913, research S8 §5.3, CONTRACTS §29.3): one sentence
 * (≤ 1,000 characters; Enter sends, Shift+Enter is a new line), three
 * examples from the schema of the chosen table, the table the sentence is
 * mainly about (`table_id`; only tables the caller manages, ADR-25), then
 * "Create draft". The wait (up to 90 s) says what happens and can be
 * cancelled; closing the dialog cancels too. There is no way to turn the
 * automation on from here: the draft opens in the builder, unsaved and off.
 */
export function AiDraftDialog({ base, onCancel, onDraft }: AiDraftDialogProps) {
  const { t, i18n } = useTranslation(['automation', 'common', 'errors']);
  const hintId = useId();
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const tables = useQuery(tablesQuery(base.id));
  const managed = (tables.data?.items ?? []).filter((table) =>
    canManageAutomations(base.access, table.id),
  );
  const [tableId, setTableId] = useState<string | null>(null);
  const chosen = managed.find((table) => table.id === tableId) ?? managed[0];
  const fields = useQuery({ ...fieldsQuery(chosen?.id ?? ''), enabled: chosen !== undefined });
  const examples =
    chosen === undefined || fields.data === undefined
      ? []
      : draftExamples(chosen.name, fields.data.items);
  const [prompt, setPrompt] = useState('');
  const trimmed = prompt.trim();
  const numbers = new Intl.NumberFormat(i18n.language);

  const controller = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );
  const draft = useMutation({
    mutationFn: (body: AiAutomationDraftRequest) => {
      controller.current?.abort();
      const next = new AbortController();
      controller.current = next;
      return aiApi.automationDraft(base.id, body, next.signal);
    },
    onSuccess: onDraft,
  });
  const submit = () => {
    if (trimmed === '' || draft.isPending) return;
    draft.mutate({
      prompt: trimmed,
      table_id: chosen?.id ?? null,
    });
  };
  const cancel = () => {
    controller.current?.abort();
    draft.reset();
    promptRef.current?.focus();
  };
  const error =
    draft.error === null
      ? null
      : translateError(draft.error, i18n, {
          overrides: Object.fromEntries(
            OWN_ERRORS.map((code) => [code, `automation:ai.errors.${code}`]),
          ),
        }).message;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={
        <span className="flex items-center gap-2">
          <Sparkles aria-hidden="true" className="size-4 text-accent" />
          {t('ai.title')}
        </span>
      }
      description={t('ai.description')}
      closeLabel={t('common:actions.close')}
      className="max-w-[600px]"
      layout="sheet"
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        data-testid="ai-draft-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <FormField label={t('ai.prompt')}>
          {(control) => (
            <>
              <textarea
                {...control}
                ref={promptRef}
                value={prompt}
                rows={4}
                maxLength={AI_AUTOMATION_MAX_PROMPT_LENGTH}
                placeholder={t('ai.placeholder')}
                readOnly={draft.isPending}
                aria-describedby={hintId}
                className="min-h-24 w-full resize-y rounded-md border border-line-control bg-surface px-3 py-2 text-body text-fg placeholder:text-fg-subtle max-lg:text-[16px]"
                data-testid="ai-draft-prompt"
                onChange={(event) => {
                  setPrompt(event.target.value);
                }}
                onKeyDown={(event) => {
                  // Enter sends, Shift+Enter is a new line; never while an IME composes (Vietnamese).
                  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
                    return;
                  }
                  event.preventDefault();
                  submit();
                }}
              />
              <span className="flex flex-wrap justify-between gap-x-3 text-label font-normal text-fg-muted">
                <span id={hintId}>{t('ai.keys')}</span>
                <span className="tabular-nums">
                  {t('ai.count', {
                    count: prompt.length,
                    limit: numbers.format(AI_AUTOMATION_MAX_PROMPT_LENGTH),
                  })}
                </span>
              </span>
            </>
          )}
        </FormField>

        {examples.length === 0 ? null : (
          <div
            role="group"
            aria-labelledby={`${hintId}-examples`}
            className="flex flex-col gap-1.5"
          >
            <span id={`${hintId}-examples`} className="text-label text-fg">
              {t('ai.examplesLabel')}
            </span>
            <ul className="flex flex-col gap-1.5">
              {examples.map((example) => {
                const text = t(example.key, example.params);
                return (
                  <li key={example.key}>
                    <button
                      type="button"
                      disabled={draft.isPending}
                      className="w-full rounded-md border border-line bg-surface px-3 py-2 text-left text-body text-fg hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:text-fg-muted max-lg:min-h-control"
                      data-testid="ai-draft-example"
                      onClick={() => {
                        setPrompt(text);
                        promptRef.current?.focus();
                      }}
                    >
                      {text}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {managed.length > 1 ? (
          <FormField label={t('ai.table')} className="sm:max-w-80">
            {(control) => (
              <Select
                {...control}
                value={chosen?.id ?? ''}
                disabled={draft.isPending}
                data-testid="ai-draft-table"
                onChange={(event) => {
                  setTableId(event.target.value);
                }}
              >
                {managed.map((table) => (
                  <option key={table.id} value={table.id}>
                    {table.name}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        ) : null}

        {draft.isPending ? (
          <AiWaiting
            text={t('ai.waiting')}
            later={t('ai.waitingLater')}
            hint={t('ai.waitingHint')}
            cancelLabel={t('common:actions.cancel')}
            onCancel={cancel}
          >
            {/* The shape of a draft: trigger, condition, step. */}
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-[85%]" />
            <Skeleton className="h-9 w-[70%]" />
          </AiWaiting>
        ) : (
          <>
            {error === null ? null : (
              <Alert variant="danger" data-testid="ai-draft-error">
                {error}
              </Alert>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="secondary" onClick={onCancel}>
                {t('common:actions.cancel')}
              </Button>
              <Button type="submit" disabled={trimmed === ''} data-testid="ai-draft-submit">
                <Sparkles aria-hidden="true" />
                {t('ai.submit')}
              </Button>
            </div>
          </>
        )}
      </form>
    </Dialog>
  );
}
