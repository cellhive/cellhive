import { Alert, Button, Checkbox, cn, FormField, Input, Skeleton } from '@cellhive/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  CircleAlert,
  Eye,
  Languages,
  ScanText,
  Sparkles,
  SquarePen,
  Tags,
  TextQuote,
  Undo2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { AiWaiting } from '../../../lib/ai/AiWaiting';
import { aiApi } from '../../../lib/api/ai';
import { isApiError } from '../../../lib/api/client';
import { translateError } from '../../../lib/errors/translate';
import { fieldsQuery, tableQuery } from '../../../lib/query/queries';
import { SelectOptionsEditor } from '../components/options/SelectOptionsEditor';
import { issueAt, useIssueText } from '../components/shared';

import {
  AI_TEMPLATES,
  aiDraftOf,
  aiIssues,
  aiOptionsBody,
  promptFields,
  serverAiIssue,
  type AiDraft,
  type AiOutput,
} from './model';

import type { AiPromptEditorComponent } from '../../../lib/schema/ai-tools';
import type { DraftIssue, FieldDraft } from '../draft';
import type {
  AiFieldPreview,
  AiFieldPreviewRequest,
  AiFieldTask,
  FieldDto,
} from '@cellhive/contracts';

/** Codes with a sentence of the AI field (BACKLOG T915); others use `errors:codes`. */
const OWN_ERRORS = [
  'AI_QUOTA_EXCEEDED',
  'AI_TIMEOUT',
  'AI_NOT_CONFIGURED',
  'AI_RECORD_DATA_DISABLED',
  'AI_INVALID_OUTPUT',
] as const;

const OUTPUTS: readonly AiOutput[] = ['text', 'select'];
const PROMPT_TEST_ID = 'ai-prompt';

const TEMPLATE_ICONS: Readonly<Record<AiFieldTask, LucideIcon>> = {
  summarize: TextQuote,
  classify: Tags,
  extract: ScanText,
  translate: Languages,
  custom: SquarePen,
};

const TEXTAREA_CLASSES =
  'min-h-16 w-full rounded-md border border-line-control bg-surface px-3 py-2 text-body text-fg ' +
  'placeholder:text-fg-subtle aria-invalid:border-danger max-lg:text-[16px]';

export interface AiFieldSectionProps {
  readonly tableId: string;
  /** The saved field (an AI field being edited); absent: a new field. */
  readonly field: FieldDto | undefined;
  readonly draft: FieldDraft;
  readonly onChange: (next: Partial<FieldDraft>) => void;
  /** Issues of the form shown now (after a first save) and server details placed here. */
  readonly issues: readonly DraftIssue[];
  /** The automation template editor (chips), from the route; absent: a plain text box. */
  readonly PromptEditor?: AiPromptEditorComponent | undefined;
  /** Template leads come from here: the new field's prompt starts from them. */
  readonly onTemplate: (task: AiFieldTask) => void;
  /** The last preview's estimate (rows, tokens), for the "generate" dialog after saving. */
  readonly onEstimate: (estimate: AiFieldPreview['estimate'] | undefined) => void;
  /** AI may read record values (`ai.record_data`): else a saved field explains why it waits. */
  readonly recordData: boolean;
  /** "Organization settings › AI" for owners/admins, `null` for others. */
  readonly settingsPath: string | null;
}

/** A radio group drawn as segments (native radios: ←/→ by the browser). */
function OutputChoice({
  value,
  onChange,
  disabled,
}: {
  readonly value: AiOutput;
  readonly onChange: (value: AiOutput) => void;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation('field');
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-label={t('ai.output')}
      className="inline-flex min-h-control max-w-full items-stretch gap-0.5 self-start rounded-md border border-line bg-surface-sunken p-0.5"
    >
      {OUTPUTS.map((output) => (
        <label
          key={output}
          className={cn(
            'inline-flex cursor-pointer items-center rounded-sm px-3 text-label font-normal text-fg-muted',
            'has-[:checked]:bg-surface has-[:checked]:font-medium has-[:checked]:text-fg has-[:checked]:shadow-sm',
            'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent',
            disabled && 'cursor-not-allowed opacity-60',
          )}
        >
          <input
            type="radio"
            className="sr-only"
            name={name}
            value={output}
            checked={value === output}
            disabled={disabled}
            onChange={() => {
              onChange(output);
            }}
          />
          {t(output === 'text' ? 'ai.outputText' : 'ai.outputSelect')}
        </label>
      ))}
    </div>
  );
}

/** The five templates as radio cards (board: Summarize, Classify, Extract, Translate, Custom). */
function TemplateCards({
  value,
  onChange,
}: {
  readonly value: AiFieldTask;
  readonly onChange: (task: AiFieldTask) => void;
}) {
  const { t } = useTranslation('field');
  const name = useId();
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5">
      <legend className="mb-1.5 text-label text-fg">{t('ai.template')}</legend>
      <div
        role="radiogroup"
        aria-label={t('ai.template')}
        className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5"
      >
        {AI_TEMPLATES.map(({ task }) => {
          const Icon = TEMPLATE_ICONS[task];
          return (
            <label
              key={task}
              data-testid={`ai-template-${task}`}
              className={cn(
                'group relative flex min-h-control cursor-pointer flex-col gap-1 rounded-lg border border-line bg-surface p-2.5',
                'transition-[border-color,background-color,box-shadow,transform] duration-(--motion-enter) ease-(--ease-enter)',
                'hover:border-line-strong motion-safe:hover:-translate-y-px',
                'has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:checked]:shadow-[inset_0_0_0_1px_var(--accent)]',
                'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-accent',
              )}
            >
              <input
                type="radio"
                className="sr-only"
                name={name}
                value={task}
                checked={value === task}
                onChange={() => {
                  onChange(task);
                }}
              />
              <span className="flex items-center gap-1.5 text-body font-medium text-fg">
                <Icon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-fg-muted group-has-[:checked]:text-accent"
                />
                {t(`ai.templates.${task}.name`)}
              </span>
              <span className="text-label font-normal text-fg-muted">
                {t(`ai.templates.${task}.description`)}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** One previewed record: its input (cut by the server) → the answer, or why there is none. */
function PreviewRow({
  item,
  select,
  lead,
}: {
  readonly item: AiFieldPreview['items'][number];
  readonly select: boolean;
  /** The prompt's text before its first field: the same in every input, left out. */
  readonly lead: string;
}) {
  const { t } = useTranslation('field');
  const input =
    lead !== '' && item.input_preview.startsWith(lead)
      ? item.input_preview.slice(lead.length).trim()
      : item.input_preview;
  return (
    <li
      className="grid gap-x-3 gap-y-1 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-start"
      data-testid="ai-preview-row"
    >
      <p className="line-clamp-2 text-label font-normal break-words text-fg-muted">
        <span className="sr-only">{`${t('ai.preview.input')}: `}</span>
        {input === '' ? t('ai.preview.empty') : input}
      </p>
      <ArrowRight
        aria-hidden="true"
        className="hidden size-3.5 shrink-0 text-fg-subtle sm:mt-0.5 sm:block"
      />
      {item.error !== null ? (
        <p className="flex items-start gap-1.5 text-label font-normal text-danger">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {t(
              [
                `ai.preview.errors.${item.error.code}_${item.error.reason ?? ''}`,
                `ai.preview.errors.${item.error.code}`,
              ],
              { defaultValue: item.error.code },
            )}
          </span>
        </p>
      ) : item.output === null || item.output === '' ? (
        <p className="text-label font-normal text-fg-subtle">{t('ai.preview.empty')}</p>
      ) : select ? (
        <p>
          <span className="sr-only">{`${t('ai.preview.output')}: `}</span>
          {/* Model text is data: plain text, never Markdown or HTML (CONTRACTS §29.6). */}
          <span className="inline-flex h-[22px] max-w-full items-center truncate rounded-sm bg-option-5 px-2 text-label text-on-option-5">
            {item.output}
          </span>
        </p>
      ) : (
        <p className="line-clamp-3 text-body break-words whitespace-pre-line text-fg">
          <span className="sr-only">{`${t('ai.preview.output')}: `}</span>
          {item.output}
        </p>
      )}
    </li>
  );
}

/**
 * The AI part of the field dialog (T915, FRONTEND §4.10, research S8 §5.3,
 * §5.6): a template (summarize, classify, extract, translate, custom) that
 * fills the prompt and the output; the output (text, or one option of a
 * single select with its options); the prompt (the automation template
 * editor: field chips); "update when the fields of the prompt change";
 * more settings (instructions, longest answer); "Preview 5 rows" — the
 * input of each record cut → its answer or error, with the tokens of every
 * row estimated (nothing is written). A saved field may "Remove AI" (its
 * values stay and become editable). Inside the dialog's form: no nested
 * form, Enter in the prompt adds a line.
 */
export function AiFieldSection({
  tableId,
  field,
  draft,
  onChange,
  issues,
  PromptEditor,
  onTemplate,
  onEstimate,
  recordData,
  settingsPath,
}: AiFieldSectionProps) {
  const { t, i18n } = useTranslation(['field', 'errors', 'common']);
  const issueText = useIssueText();
  const promptHintId = useId();
  const promptIssueId = useId();
  const fields = useQuery(fieldsQuery(tableId));
  const table = useQuery(tableQuery(tableId));
  const usable = useMemo(
    () => promptFields(fields.data?.items ?? [], field?.id),
    [fields.data, field?.id],
  );
  const savedAi = field !== undefined && field.options['ai'] != null;
  const ai = draft.ai;
  const output: AiOutput = draft.type === 'select' ? 'select' : 'text';
  const select = output === 'select';

  const controller = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );
  const preview = useMutation({
    mutationFn: (body: AiFieldPreviewRequest) => {
      controller.current?.abort();
      const next = new AbortController();
      controller.current = next;
      return aiApi.fieldPreview(tableId, body, next.signal);
    },
    onSuccess: (result) => {
      onEstimate(result.estimate);
    },
  });
  const [previewIssues, setPreviewIssues] = useState<readonly DraftIssue[]>([]);
  const [asked, setAsked] = useState<string | null>(null);

  if (ai === null) {
    // "Remove AI" of a saved field: undone until saved.
    return savedAi ? (
      <Alert variant="info" data-testid="ai-removed">
        <p>{t('field:ai.removed')}</p>
        <div>
          <Button
            variant="secondary"
            size="sm"
            className="max-lg:h-control"
            onClick={() => {
              onChange({ ai: aiDraftOf(field) });
            }}
          >
            <Undo2 aria-hidden="true" />
            {t('field:ai.undoRemove')}
          </Button>
        </div>
      </Alert>
    ) : null;
  }

  const set = (patch: Partial<AiDraft>) => {
    onChange({ ai: { ...ai, ...patch } });
  };
  const liveOptions = draft.select.options.filter((option) => !option.deleted);
  const request: AiFieldPreviewRequest = {
    field_id: field?.id ?? null,
    type: output,
    choices: select ? liveOptions.map((option) => option.name.trim()).filter(Boolean) : [],
    ai: aiOptionsBody(ai),
  };
  const requestKey = JSON.stringify(request);
  // "Shortened input": the values only, without the instructions every row repeats.
  const lead = (ai.prompt.split('{{')[0] ?? '').replace(/\\(.)/gu, '$1').trim();
  const stale = asked !== null && asked !== requestKey && preview.data !== undefined;

  const runPreview = () => {
    const problems = aiIssues(ai, output, liveOptions.length);
    setPreviewIssues(problems);
    if (problems.length > 0) return;
    setAsked(requestKey);
    preview.mutate(request, {
      onError: (failure) => {
        const placed = isApiError(failure) ? serverAiIssue(failure.errors) : undefined;
        setPreviewIssues(placed === undefined ? [] : [placed]);
      },
    });
  };
  const cancel = () => {
    controller.current?.abort();
    preview.reset();
  };

  const allIssues = [...issues, ...previewIssues];
  const promptIssue = issueAt(allIssues, 'options.ai.prompt');
  const tokensIssue = issueAt(allIssues, 'options.ai.max_output_tokens');
  const instructionsIssue = issueAt(allIssues, 'options.ai.instructions');
  const choicesIssue = issueAt(allIssues, 'options.ai.choices');
  const placedPreviewIssue =
    isApiError(preview.error) && serverAiIssue(preview.error.errors) !== undefined;
  const previewError =
    preview.error === null || placedPreviewIssue
      ? null
      : translateError(preview.error, i18n, {
          overrides: Object.fromEntries(
            OWN_ERRORS.map((code) => [code, `field:ai.errors.${code}`]),
          ),
        }).message;
  const result = preview.data;

  return (
    <section
      aria-labelledby={`${promptHintId}-title`}
      className="flex min-w-0 flex-col gap-4 motion-safe:animate-reveal"
      data-testid="ai-field-section"
    >
      <div className="flex items-center gap-2">
        <h3
          id={`${promptHintId}-title`}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-heading text-fg"
        >
          <Sparkles aria-hidden="true" className="size-4 shrink-0 text-accent" />
          {t('field:ai.section')}
        </h3>
        {savedAi ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-fg-muted max-lg:h-control"
            data-testid="ai-remove"
            onClick={() => {
              cancel();
              onChange({ ai: null });
            }}
          >
            <X aria-hidden="true" />
            {t('field:ai.remove')}
          </Button>
        ) : null}
      </div>
      {!recordData ? (
        <Alert variant="info" data-testid="ai-record-data-off">
          <p>{t('field:ai.recordDataOffSaved')}</p>
          {settingsPath === null ? null : (
            <p>
              <Link
                to={settingsPath}
                className="font-medium text-accent underline-offset-2 hover:underline"
              >
                {t('field:ai.openSettings')}
              </Link>
            </p>
          )}
        </Alert>
      ) : null}
      <TemplateCards
        value={ai.task}
        onChange={(task) => {
          cancel();
          onTemplate(task);
        }}
      />
      <FormField
        label={t('field:ai.output')}
        hint={savedAi ? t('field:ai.outputFixed') : undefined}
      >
        {() => (
          <OutputChoice
            value={output}
            disabled={savedAi}
            onChange={(next) => {
              onChange({ type: next });
            }}
          />
        )}
      </FormField>
      {select ? (
        <div className="flex flex-col gap-1.5 rounded-lg border border-line p-3">
          <SelectOptionsEditor
            value={draft.select}
            issues={issues}
            ai
            onChange={(next) => {
              onChange({ select: next });
            }}
          />
          {choicesIssue === undefined ? null : (
            <p role="alert" className="text-label font-normal text-danger">
              {t('field:validation.AI_CHOICES_REQUIRED')}
            </p>
          )}
        </div>
      ) : null}
      <div className="flex min-w-0 flex-col gap-1.5">
        <span id={`${promptHintId}-label`} className="text-label text-fg">
          {t('field:ai.prompt')}
        </span>
        {PromptEditor === undefined ? (
          <textarea
            aria-labelledby={`${promptHintId}-label`}
            aria-describedby={`${promptHintId} ${promptIssue === undefined ? '' : promptIssueId}`}
            aria-invalid={promptIssue !== undefined || undefined}
            rows={3}
            className={TEXTAREA_CLASSES}
            data-testid="ai-prompt"
            value={ai.prompt}
            onChange={(event) => {
              set({ prompt: event.target.value });
            }}
          />
        ) : (
          // The editor (and the builder's strings) load with the first AI field configured.
          <Suspense fallback={<Skeleton className="h-20 w-full" />}>
            <PromptEditor
              fields={usable}
              tableName={table.data?.name ?? ''}
              value={ai.prompt}
              onChange={(prompt) => {
                set({ prompt });
              }}
              label={t('field:ai.prompt')}
              placeholder={t('field:ai.promptPlaceholder')}
              invalid={promptIssue !== undefined}
              describedBy={`${promptHintId} ${promptIssue === undefined ? '' : promptIssueId}`.trim()}
              testId={PROMPT_TEST_ID}
            />
          </Suspense>
        )}
        <p id={promptHintId} className="text-label font-normal text-fg-muted">
          {t('field:ai.promptHint')}
        </p>
        {promptIssue === undefined ? null : (
          <p id={promptIssueId} role="alert" className="text-label font-normal text-danger">
            {issueText(promptIssue)}
          </p>
        )}
      </div>
      <Checkbox
        label={t('field:ai.autoUpdate')}
        hint={t('field:ai.autoUpdateHint')}
        checked={ai.autoUpdate}
        data-testid="ai-auto-update"
        onChange={(event) => {
          set({ autoUpdate: event.target.checked });
        }}
      />
      <details
        className="group/more rounded-lg border border-line [&[open]>summary_svg]:rotate-90"
        open={instructionsIssue !== undefined || tokensIssue !== undefined || undefined}
      >
        <summary className="flex min-h-control cursor-pointer items-center gap-1.5 rounded-lg px-3 text-label text-fg select-none hover:bg-surface-sunken">
          <ArrowRight
            aria-hidden="true"
            className="size-3.5 transition-transform duration-(--motion-enter)"
          />
          {t('field:ai.advanced')}
        </summary>
        <div className="flex flex-col gap-4 border-t border-line p-3">
          <FormField
            label={t('field:ai.instructions')}
            hint={t('field:ai.instructionsHint')}
            error={issueText(instructionsIssue)}
          >
            {(control) => (
              <textarea
                {...control}
                rows={2}
                maxLength={2000}
                className={TEXTAREA_CLASSES}
                value={ai.instructions}
                onChange={(event) => {
                  set({ instructions: event.target.value });
                }}
              />
            )}
          </FormField>
          <FormField
            label={t('field:ai.maxTokens')}
            hint={t('field:ai.maxTokensHint')}
            error={issueText(tokensIssue)}
          >
            {(control) => (
              <Input
                {...control}
                inputMode="numeric"
                className="w-32"
                value={ai.maxOutputTokens}
                onChange={(event) => {
                  set({ maxOutputTokens: event.target.value });
                }}
                onKeyDown={(event) => {
                  // Enter keeps the dialog open (it would save the field).
                  if (event.key === 'Enter') event.preventDefault();
                }}
              />
            )}
          </FormField>
        </div>
      </details>

      <div className="flex flex-col gap-2" data-testid="ai-preview">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button
            variant="secondary"
            size="sm"
            className="max-lg:h-control"
            disabled={preview.isPending || !recordData}
            data-testid="ai-preview-run"
            onClick={runPreview}
          >
            <Eye aria-hidden="true" />
            {result === undefined ? t('field:ai.preview.button') : t('field:ai.preview.again')}
          </Button>
          {result === undefined ? (
            <span className="text-label font-normal text-fg-muted">
              {t('field:ai.preview.hint')}
            </span>
          ) : (
            <span
              className="text-label font-normal text-fg-muted"
              data-testid="ai-preview-estimate"
            >
              {t('field:ai.preview.estimate', {
                rows: result.estimate.rows,
                tokens: result.estimate.tokens,
              })}
            </span>
          )}
        </div>
        {/* Read once the rows arrive; the list itself stays out of the live region. */}
        <p role="status" className="sr-only">
          {result === undefined ? '' : t('field:ai.preview.ready', { count: result.items.length })}
        </p>
        {preview.isPending ? (
          <AiWaiting
            text={t('field:ai.preview.waiting')}
            later={t('field:ai.preview.waitingLater')}
            hint={t('field:ai.preview.waitingHint')}
            cancelLabel={t('common:actions.cancel')}
            onCancel={cancel}
          >
            {[0, 1, 2].map((row) => (
              <div key={row} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
                <Skeleton className="h-3.5 w-[80%]" />
                <Skeleton className="h-3.5 w-[65%]" />
              </div>
            ))}
          </AiWaiting>
        ) : null}
        {previewError === null ? null : (
          <p
            role="alert"
            className="flex items-start gap-1.5 text-label font-normal text-danger"
            data-testid="ai-preview-error"
          >
            <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span>{previewError}</span>
          </p>
        )}
        {result === undefined ? null : result.items.length === 0 ? (
          <p className="text-label font-normal text-fg-muted">{t('field:ai.preview.none')}</p>
        ) : (
          <div
            className={cn(
              'overflow-hidden rounded-lg border border-line bg-surface motion-safe:animate-reveal',
              stale && 'opacity-60',
            )}
          >
            <div className="hidden grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-x-3 border-b border-line bg-surface-sunken px-3 py-1.5 text-label text-fg-muted sm:grid">
              <span>{t('field:ai.preview.input')}</span>
              <span aria-hidden="true" className="w-3.5" />
              <span>{t('field:ai.preview.output')}</span>
            </div>
            <ul className="divide-y divide-line" aria-label={t('field:ai.preview.title')}>
              {result.items.map((item) => (
                <PreviewRow key={item.record_id} item={item} select={select} lead={lead} />
              ))}
            </ul>
          </div>
        )}
        {stale ? (
          <p className="text-label font-normal text-fg-muted">{t('field:ai.preview.stale')}</p>
        ) : null}
      </div>
    </section>
  );
}
