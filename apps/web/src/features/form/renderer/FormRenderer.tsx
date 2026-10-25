import { Alert, Button, cn, Spinner } from '@cellhive/ui';
import { CircleCheckBig, Clock } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../lib/api/client';
import { UploadStore, type UploadTarget } from '../../../lib/attachments/uploads';
import { translateDetail, translateError } from '../../../lib/errors/translate';
import { Markdown } from '../../../lib/markdown/Markdown';
import { safeHref } from '../../../lib/markdown/parse';
import {
  limitReached,
  relativeTime,
  splitProblems,
  tokenProblem,
  type LimitReached,
} from '../model/errors';
import { parsePrefill } from '../model/prefill';
import { questionsOf, type FormQuestion } from '../model/questions';
import { buildSubmission, initialInput, prefillInput, type InputValue } from '../model/values';

import { isChoiceGroup, QuestionInput, type QuestionInputProps } from './QuestionInput';
import { SubmitTokens, SYSTEM_CLOCK } from './submit-token';

import type { EditorIssue } from '../../../grid/editors/types';
import type { FormRendererProps, FormUploadSource } from '../../../lib/forms/renderer';
import type {
  AttachmentDto,
  FormSubmitRequest,
  FormSubmitResponse,
  Id,
  ProblemErrorItem,
} from '@cellhive/contracts';

type Stage =
  | { readonly kind: 'filling' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'done'; readonly response: FormSubmitResponse }
  | { readonly kind: 'limit'; readonly limit: LimitReached }
  | { readonly kind: 'previewed' };

/** A problem shown under a question: from the client checks or the server. */
type FieldProblem =
  | { readonly source: 'client'; readonly issue: EditorIssue }
  | { readonly source: 'server'; readonly item: ProblemErrorItem };

/** Name of the honeypot input: a field bots like to fill. */
const HONEYPOT_NAME = 'website';

function redirectTarget(url: string | null): string | null {
  if (url === null) return null;
  const href = safeHref(url);
  return href !== null && !href.startsWith('mailto:') ? href : null;
}

/**
 * The form a person fills in (SPEC §8, CONTRACTS §17, T315): title,
 * description (Markdown), one input per question, client checks mirroring
 * the server (required, value per field type), server problems under their
 * question (`errors[].path` = `fields.<id>`), the submission limit
 * (`409`), then the success message or the redirect. Values prefilled
 * through the URL start the inputs; hidden ones are sent as typed.
 * With `antiSpam` (link forms, T317) it fetches a submit token when it
 * opens, waits for the minimum fill time and sends a honeypot.
 */
export function FormRenderer({
  form,
  fields,
  locale,
  search,
  submit,
  antiSpam,
  members,
  links,
  uploads,
  limitReached: reachedOnOpen,
  blocked,
  onRedirect,
  clock = SYSTEM_CLOCK,
  headingLevel = 2,
  coverUrlOf,
}: FormRendererProps) {
  const { t, i18n } = useTranslation(['form', 'errors']);
  const titleId = useId();
  const baseId = useId();
  const questions = useMemo(() => questionsOf(form, fields), [form, fields]);
  const prefill = useMemo(() => parsePrefill(search), [search]);
  // Hidden only when a value is given: a hidden empty question could never be answered.
  const hidden = useMemo(() => {
    const out: Record<string, string> = {};
    for (const question of questions) {
      const raw = prefill.values[question.field.id];
      if (raw !== undefined && prefill.hidden.has(question.field.id)) out[question.field.id] = raw;
    }
    return out;
  }, [questions, prefill]);
  const visible = useMemo(
    () => questions.filter((question) => hidden[question.field.id] === undefined),
    [questions, hidden],
  );

  const startValues = () => {
    const values: Record<string, InputValue> = {};
    for (const question of questions) {
      const raw = prefill.values[question.field.id];
      values[question.field.id] =
        raw === undefined
          ? initialInput(question.config, locale)
          : prefillInput(question.config, raw, locale, members);
    }
    return values;
  };
  const isBlocked = blocked !== undefined && blocked !== null && blocked !== false;
  const [values, setValues] = useState<Record<string, InputValue>>(startValues);
  const [problems, setProblems] = useState<Record<string, FieldProblem>>({});
  const [general, setGeneral] = useState<string[]>([]);
  const [stage, setStage] = useState<Stage>(() =>
    reachedOnOpen === null || reachedOnOpen === undefined
      ? { kind: 'filling' }
      : {
          kind: 'limit',
          limit: { limit: form.submission_limit, nextAllowedAt: reachedOnOpen.nextAllowedAt },
        },
  );
  const formRef = useRef<HTMLFormElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const honeypot = useRef<HTMLInputElement>(null);

  const tokens = useMemo(
    () => (antiSpam === undefined ? null : new SubmitTokens(antiSpam, clock)),
    [antiSpam, clock],
  );
  useEffect(() => {
    if (tokens === null) return undefined;
    void tokens.prefetch().catch(() => undefined);
    return () => {
      tokens.dispose();
    };
  }, [tokens]);

  // Uploads of file questions (T410): one store per form; a link form binds them to its
  // submit token (the one the form is sent with).
  const uploadStore = useMemo(
    () => (uploads === undefined ? null : formUploadStore(uploads, tokens)),
    [uploads, tokens],
  );
  // A new round (after a submission) starts empty upload lists.
  const [round, setRound] = useState(0);
  const targetOf = (fieldId: string): UploadTarget => ({
    tableId: 'form',
    recordId: `round-${String(round)}`,
    fieldId,
  });
  const uploading = () =>
    uploadStore !== null &&
    questions.some(
      (question) =>
        question.config?.type === 'attachment' &&
        uploadStore.active(targetOf(question.field.id)) > 0,
    );

  // Done / limit screens take the focus so that screen readers read them.
  useEffect(() => {
    if (stage.kind === 'done' || stage.kind === 'limit') statusRef.current?.focus();
  }, [stage.kind]);

  const labelOf = (fieldId: string) =>
    questions.find((question) => question.field.id === fieldId)?.label ?? fieldId;

  const messageOf = (problem: FieldProblem): string =>
    problem.source === 'client'
      ? translateDetail(i18n, {
          code: problem.issue.code,
          ...(problem.issue.params === undefined ? {} : { params: problem.issue.params }),
          ...(problem.issue.message === undefined ? {} : { message: problem.issue.message }),
        })
      : translateDetail(i18n, problem.item);

  const focusFirstProblem = (fieldIds: readonly string[]) => {
    const first = visible.find((question) => fieldIds.includes(question.field.id));
    if (first === undefined) return;
    requestAnimationFrame(() => {
      const control = formRef.current?.querySelector<HTMLElement>(
        `#${CSS.escape(`${baseId}-${first.field.id}`)}`,
      );
      const target =
        control?.matches('input, select, textarea') === true
          ? control
          : (control?.querySelector<HTMLElement>('input, select, textarea') ?? control);
      target?.focus();
    });
  };

  const send = async (
    post: (body: FormSubmitRequest) => Promise<FormSubmitResponse>,
    body: FormSubmitRequest,
    retried = false,
  ): Promise<FormSubmitResponse> => {
    let request = body;
    if (tokens !== null) {
      request = {
        ...body,
        submit_token: await tokens.ready(),
        honeypot: honeypot.current?.value ?? '',
      };
    }
    try {
      const response = await post(request);
      tokens?.discard();
      return response;
    } catch (error) {
      const problem = tokens === null || retried ? null : tokenProblem(error);
      if (problem === null) throw error;
      if (problem.kind === 'invalid') tokens?.discard();
      else await clock.sleep(problem.retryAfterMs);
      return send(post, body, true);
    }
  };

  const onSubmit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (stage.kind === 'sending' || isBlocked) return;
    if (uploading()) {
      setGeneral([t('fill.files.wait')]);
      return;
    }
    const submission = buildSubmission(questions, values, hidden, locale, members);
    const invalid = Object.keys(submission.issues);
    if (invalid.length > 0) {
      setProblems(
        Object.fromEntries(
          Object.entries(submission.issues).map(([fieldId, issue]) => [
            fieldId,
            { source: 'client', issue } satisfies FieldProblem,
          ]),
        ),
      );
      // Hidden questions have no input to point at: named in the summary.
      setGeneral(
        invalid
          .filter((fieldId) => hidden[fieldId] !== undefined)
          .map(
            (fieldId) =>
              `${labelOf(fieldId)}: ${messageOf({ source: 'client', issue: submission.issues[fieldId] ?? { code: 'INVALID' } })}`,
          ),
      );
      focusFirstProblem(invalid);
      return;
    }
    setProblems({});
    setGeneral([]);
    if (submit === undefined) {
      setStage({ kind: 'previewed' });
      return;
    }
    setStage({ kind: 'sending' });
    try {
      const response = await send(submit, { fields: submission.fields });
      setStage({ kind: 'done', response });
      const target = redirectTarget(response.redirect_url);
      if (target !== null) {
        (
          onRedirect ??
          ((url: string) => {
            window.location.assign(url);
          })
        )(target);
      }
    } catch (error) {
      const limit = limitReached(error);
      if (limit !== null) {
        setStage({ kind: 'limit', limit });
        return;
      }
      setStage({ kind: 'filling' });
      const split = isApiError(error) ? splitProblems(error.errors) : { fields: {}, other: [] };
      const onQuestions = Object.entries(split.fields).filter(
        ([fieldId]) => hidden[fieldId] === undefined && visible.some((q) => q.field.id === fieldId),
      );
      setProblems(
        Object.fromEntries(
          onQuestions.map(([fieldId, item]) => [
            fieldId,
            { source: 'server', item } satisfies FieldProblem,
          ]),
        ),
      );
      const elsewhere = Object.entries(split.fields)
        .filter(([fieldId]) => !onQuestions.some(([id]) => id === fieldId))
        .map(([fieldId, item]) => `${labelOf(fieldId)}: ${translateDetail(i18n, item)}`);
      const translated = translateError(error, i18n);
      const details = split.other
        .filter((item) => item.path !== '')
        .map((item) => translateDetail(i18n, item));
      setGeneral(
        onQuestions.length > 0 && elsewhere.length === 0 && details.length === 0
          ? []
          : [translated.message, ...elsewhere, ...details],
      );
      focusFirstProblem(onQuestions.map(([fieldId]) => fieldId));
    }
  };

  const reset = () => {
    setRound((current) => current + 1);
    setValues(startValues());
    setProblems({});
    setGeneral([]);
    setStage({ kind: 'filling' });
    tokens?.prefetch().catch(() => undefined);
  };

  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  const title = form.title.trim() === '' ? t('fill.untitled') : form.title;

  if (stage.kind === 'done') {
    const again = form.submission_limit === 'none';
    return (
      <section aria-labelledby={titleId} className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-0">
        <div
          ref={statusRef}
          tabIndex={-1}
          role="status"
          className="flex flex-col items-center gap-3 rounded-lg border border-line bg-surface p-8 text-center outline-none"
        >
          <CircleCheckBig aria-hidden="true" className="size-10 text-success" />
          <Heading id={titleId} className="text-title">
            {t('fill.done.title')}
          </Heading>
          {stage.response.success_message.trim() === '' ? (
            <p className="text-fg-muted">{t('fill.done.default')}</p>
          ) : (
            <Markdown source={stage.response.success_message} className="text-fg-muted" />
          )}
          {redirectTarget(stage.response.redirect_url) === null ? null : (
            <p className="text-label font-normal text-fg-muted">{t('fill.done.redirecting')}</p>
          )}
          {again ? (
            <Button variant="secondary" onClick={reset}>
              {t('fill.done.again')}
            </Button>
          ) : null}
        </div>
      </section>
    );
  }

  if (stage.kind === 'limit') {
    const next = stage.limit.nextAllowedAt;
    const at = next === null ? null : Date.parse(next);
    return (
      <section aria-labelledby={titleId} className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-0">
        <div
          ref={statusRef}
          tabIndex={-1}
          role="status"
          data-testid="form-limit"
          className="flex flex-col items-center gap-3 rounded-lg border border-line bg-surface p-8 text-center outline-none"
        >
          <Clock aria-hidden="true" className="size-10 text-fg-muted" />
          <Heading id={titleId} className="text-title">
            {t('fill.limit.title')}
          </Heading>
          <p className="text-fg-muted">
            {at === null
              ? t('fill.limit.once')
              : t('fill.limit.next', {
                  relative: relativeTime(at, clock.now(), i18n.language),
                  date: new Intl.DateTimeFormat(i18n.language, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                    timeZone: locale.timeZone,
                  }).format(at),
                })}
          </p>
        </div>
      </section>
    );
  }

  const sending = stage.kind === 'sending';
  return (
    <form
      ref={formRef}
      noValidate
      aria-labelledby={titleId}
      aria-busy={sending}
      className="mx-auto w-full max-w-2xl sm:px-4 sm:py-8"
      onSubmit={(event) => {
        void onSubmit(event);
      }}
    >
      {/* One card: header, questions, footer (design "Form công khai"). */}
      <div className="flex flex-col bg-surface sm:rounded-lg sm:border sm:border-line">
        {form.cover_attachment_id === null || coverUrlOf === undefined ? null : (
          <FormCover key={form.cover_attachment_id} src={coverUrlOf(form.cover_attachment_id)} />
        )}
        <header className="flex flex-col gap-1.5 border-b border-line px-5 pt-7 pb-4 sm:px-7 sm:pt-6">
          <Heading id={titleId} className="text-title break-words">
            {title}
          </Heading>
          {form.description.trim() === '' ? null : (
            <Markdown source={form.description} className="text-fg-muted" />
          )}
          {questions.some((question) => question.required) ? (
            <p className="text-label font-normal text-fg-muted">
              <span aria-hidden="true" className="text-danger">
                *
              </span>{' '}
              {t('fill.requiredHint')}
            </p>
          ) : null}
        </header>

        <div className="flex flex-col gap-4 px-5 py-5 sm:px-7">
          {general.length > 0 ? (
            <Alert variant="danger">
              {general.map((line, index) => (
                <p key={index}>{line}</p>
              ))}
            </Alert>
          ) : null}

          {visible.length === 0 ? (
            <p className="text-fg-muted">{t('fill.noQuestions')}</p>
          ) : (
            <ol className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
              {visible.map((question) => (
                <li
                  key={question.field.id}
                  className={cn('min-w-0', !isShortQuestion(question) && 'sm:col-span-2')}
                >
                  <QuestionBlock
                    question={question}
                    baseId={baseId}
                    value={values[question.field.id] ?? initialInput(question.config, locale)}
                    problem={problems[question.field.id]}
                    message={messageOf}
                    disabled={sending}
                    members={members}
                    links={links}
                    files={{
                      store: uploadStore,
                      target: targetOf(question.field.id),
                      maxFiles: uploads?.maxFilesPerQuestion,
                      maxTotalBytes: uploads?.maxTotalBytes,
                    }}
                    onChange={(change) => {
                      const fieldId = question.field.id;
                      setValues((current) => ({
                        ...current,
                        [fieldId]: change(
                          current[fieldId] ?? initialInput(question.config, locale),
                        ),
                      }));
                      setProblems((current) =>
                        current[fieldId] === undefined
                          ? current
                          : Object.fromEntries(
                              Object.entries(current).filter(([id]) => id !== fieldId),
                            ),
                      );
                      if (stage.kind === 'previewed') setStage({ kind: 'filling' });
                    }}
                  />
                </li>
              ))}
            </ol>
          )}

          {tokens === null ? null : (
            // People never see or reach this input; bots filling every field do (CONTRACTS §17).
            <div aria-hidden="true" className="absolute -left-[10000px] size-px overflow-hidden">
              <label>
                {t('fill.honeypot')}
                <input
                  ref={honeypot}
                  type="text"
                  name={HONEYPOT_NAME}
                  tabIndex={-1}
                  autoComplete="off"
                  defaultValue=""
                />
              </label>
            </div>
          )}
        </div>

        <footer
          className={cn(
            'flex flex-col-reverse gap-2 border-t border-line bg-surface px-5 pt-3 pb-5 sm:flex-row sm:items-center sm:gap-3 sm:px-7 sm:pt-4',
            // Phones: the send button stays in reach at the bottom of the screen.
            'sticky bottom-0 sm:static',
          )}
        >
          <span className="text-center text-label font-normal text-fg-subtle sm:text-left">
            {t('fill.madeWith')}
          </span>
          {stage.kind === 'previewed' ? (
            <p role="status" className="text-fg-muted sm:ml-auto">
              {t('fill.previewed')}
            </p>
          ) : null}
          {!isBlocked ? (
            <Button
              type="submit"
              disabled={sending}
              className={cn(
                'h-12 w-full text-body sm:h-10 sm:w-auto',
                stage.kind !== 'previewed' && 'sm:ml-auto',
              )}
            >
              {sending ? <Spinner /> : null}
              {sending ? t('fill.sending') : t('fill.submit')}
            </Button>
          ) : (
            <Alert variant="info" className="w-full sm:ml-auto sm:w-auto">
              {blocked}
            </Alert>
          )}
        </footer>
      </div>
    </form>
  );
}

/**
 * Questions answered in a few characters (numbers, dates, emails, phones,
 * links, one pick from a list) share a row on wide screens; the others take
 * the whole width (design "Form công khai").
 */
export function isShortQuestion(question: FormQuestion): boolean {
  const config = question.config;
  if (config === null) return false;
  switch (config.type) {
    case 'number':
    case 'datetime':
      return true;
    case 'text':
      return question.field.is_primary !== true && config.options.style.type !== 'plain';
    case 'select':
      return !config.options.multiple && !isChoiceGroup(question);
    case 'user':
      return !config.options.multiple;
    default:
      return false;
  }
}

interface QuestionBlockProps {
  readonly question: FormQuestion;
  readonly baseId: string;
  readonly value: InputValue;
  readonly problem: FieldProblem | undefined;
  readonly message: (problem: FieldProblem) => string;
  readonly disabled: boolean;
  readonly members: FormRendererProps['members'];
  readonly links: FormRendererProps['links'];
  readonly files: QuestionInputProps['files'];
  /** Changes the value from the one it holds when the change lands. */
  readonly onChange: (change: (current: InputValue) => InputValue) => void;
}

/** One question: label (required mark), help, input, problem. */
function QuestionBlock({
  question,
  baseId,
  value,
  problem,
  message,
  disabled,
  members,
  links,
  files,
  onChange,
}: QuestionBlockProps) {
  const { t } = useTranslation('form');
  const controlId = `${baseId}-${question.field.id}`;
  const labelId = `${controlId}-label`;
  const helpId = `${controlId}-help`;
  const errorId = `${controlId}-error`;
  const group = isChoiceGroup(question);
  const describedBy =
    [question.help === null ? null : helpId, problem === undefined ? null : errorId]
      .filter((id) => id !== null)
      .join(' ') || undefined;
  const Label = group || question.config === null ? 'span' : 'label';
  return (
    <div
      data-testid="form-question"
      data-field={question.field.id}
      data-invalid={problem === undefined ? undefined : 'true'}
      className="flex min-w-0 flex-col gap-1.5"
    >
      <Label
        id={labelId}
        {...(Label === 'label' ? { htmlFor: controlId } : {})}
        className="text-body font-medium break-words text-fg"
      >
        {question.label}
        {question.required ? (
          <>
            <span aria-hidden="true" className="ml-1 text-danger">
              *
            </span>
            <span className="sr-only"> {t('fill.required')}</span>
          </>
        ) : null}
      </Label>
      {question.help === null ? null : (
        <p
          id={helpId}
          className="text-label font-normal break-words whitespace-pre-line text-fg-muted"
        >
          {question.help}
        </p>
      )}
      <QuestionInput
        question={question}
        value={value}
        onChange={(next) => {
          onChange(() => next);
        }}
        update={onChange}
        labelId={labelId}
        members={members}
        links={links}
        files={files}
        control={{
          id: controlId,
          describedBy,
          invalid: problem !== undefined,
          required: question.required,
          disabled,
        }}
      />
      {problem === undefined ? null : (
        <p id={errorId} className="text-label font-normal text-danger">
          {message(problem)}
        </p>
      )}
    </div>
  );
}

/**
 * The upload store of a form (T410): the T418 flow through the form's
 * upload source, with the submit token of a link form (fetched when the form
 * opened; the one the form is sent with).
 */
function formUploadStore(uploads: FormUploadSource, tokens: SubmitTokens | null): UploadStore {
  const token = async () => (tokens === null ? null : (await tokens.prefetch()).submit_token);
  return new UploadStore({
    api: {
      createUpload: async (body, signal) =>
        uploads.start(
          { field_id: body.field_id, filename: body.filename, size: body.size, mime: body.mime },
          await token(),
          signal,
        ),
      complete: async (attachmentId, signal) => {
        const file = await uploads.complete(attachmentId, await token(), signal);
        const done: AttachmentDto = {
          id: file.id as Id<'att'>,
          name: file.name,
          size: file.size,
          mime: file.mime,
          url: '',
          thumbnail_url: null,
        };
        return done;
      },
    },
  });
}

export default FormRenderer;

/**
 * The cover image of a form (T419): the width of the card, at most 192 px
 * high, cropped to fill; decorative (the title names the form). An image
 * that cannot be read (removed meanwhile) leaves no empty frame.
 */
function FormCover({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      src={src}
      alt=""
      loading="eager"
      decoding="async"
      data-testid="form-cover"
      className="aspect-[4/1] max-h-48 w-full object-cover sm:rounded-t-lg"
      onError={() => {
        setFailed(true);
      }}
    />
  );
}
