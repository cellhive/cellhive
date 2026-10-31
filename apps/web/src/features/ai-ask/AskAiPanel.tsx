import { AI_ASK_MAX_QUESTION_LENGTH } from '@cellhive/contracts';
import { Button, Skeleton, Tooltip } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowUp, Sparkles, X } from 'lucide-react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { AiWaiting } from '../../lib/ai/AiWaiting';
import { useAiAvailability } from '../../lib/ai/use-ai-availability';
import { aiApi } from '../../lib/api/ai';
import { browserTimeZone } from '../../lib/i18n/format';
import { meQuery } from '../../lib/session/session';

import { AskOutcomeView } from './components/AskOutcomeView';
import { askErrorOf } from './model/errors';
import {
  nextEntryId,
  readSession,
  sessionKey,
  writeSession,
  type AskEntry,
  type AskOutcome,
} from './model/session';
import { askSuggestions } from './model/suggestions';

import type { AskAiPanelProps, AskAnswerWidgetComponent } from '../../lib/ai/ask';

export interface AskAiPanelWithAnswerProps extends AskAiPanelProps {
  /** The dashboard's widget renderer (lazy), from the route (FRONTEND §1.2). */
  readonly Answer: AskAnswerWidgetComponent;
}

interface Pending {
  readonly id: number;
  readonly question: string;
}

/**
 * "Ask AI" of a table (T914, FRONTEND §20, research S8 §5.4–§5.5, CONTRACTS
 * §29.4): a panel on the right (a bottom sheet below 768 px), not modal —
 * the grid stays usable beside it. The questions of this session and what
 * each got, three suggested questions while there are none, the box at the
 * bottom (Enter asks, Shift+Enter is a new line, Escape closes). One
 * question at a time; the wait says what happens and can be cancelled (the
 * request is aborted, the question goes back in the box). The numbers are
 * computed by the server with the asker's permissions; the model's words
 * (the narrative) are plain text.
 */
export default function AskAiPanel({
  table,
  fields,
  orgId,
  onClose,
  Answer,
}: AskAiPanelWithAnswerProps) {
  const { t, i18n } = useTranslation(['aiAsk', 'common']);
  const titleId = useId();
  const hintId = useId();
  const ai = useAiAvailability(orgId);
  const me = useQuery(meQuery());
  const key = sessionKey(me.data?.user.id, table.id);
  const [entries, setEntries] = useState<readonly AskEntry[]>(() => readSession(key).entries);
  const [draft, setDraft] = useState(() => readSession(key).draft);
  const [pending, setPending] = useState<Pending | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const latest = useRef<HTMLLIElement>(null);
  const numbers = new Intl.NumberFormat(i18n.language);
  const suggestions = useMemo(() => askSuggestions(table.name, fields), [table.name, fields]);

  // The session outlives the panel; a question still waiting goes back in the box.
  const saved = useRef({ entries, draft, pending });
  useLayoutEffect(() => {
    saved.current = { entries, draft, pending };
  });
  useEffect(
    () => () => {
      controller.current?.abort();
      const { entries: kept, draft: text, pending: waiting } = saved.current;
      writeSession(key, kept, waiting === null ? text : waiting.question);
    },
    [key],
  );

  useEffect(() => {
    // After the frame: the panel slides in, the focus lands in the box.
    const frame = requestAnimationFrame(() => {
      input.current?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);
  // The newest question at the top of what shows (CSS smooth scroll unless reduced motion).
  useEffect(() => {
    // Not in every environment (jsdom).
    (latest.current as Partial<Pick<HTMLElement, 'scrollIntoView'>> | null)?.scrollIntoView?.({
      block: 'start',
    });
  }, [entries.length, pending?.id]);

  const finish = (id: number, question: string, outcome: AskOutcome) => {
    setPending((current) => (current?.id === id ? null : current));
    setEntries((current) => [...current, { id, question, outcome }]);
    setAnnouncement(
      outcome.kind === 'answer'
        ? t('announce.answer', { title: outcome.answer.widget.title })
        : outcome.kind === 'unanswerable'
          ? t('unanswerable.title')
          : askErrorOf(outcome.error, i18n).message,
    );
  };

  const ask = (text: string) => {
    const question = text.trim();
    if (question === '' || pending !== null) return;
    const next = new AbortController();
    controller.current = next;
    const id = nextEntryId();
    setPending({ id, question });
    setDraft('');
    setAnnouncement('');
    aiApi.ask(table.id, { question, timezone: browserTimeZone() }, next.signal).then(
      (result) => {
        if (next.signal.aborted) return;
        finish(
          id,
          question,
          result.status === 'ok' ? { kind: 'answer', answer: result } : { kind: 'unanswerable' },
        );
      },
      (error: unknown) => {
        if (next.signal.aborted) return;
        finish(id, question, { kind: 'error', error });
      },
    );
  };

  const focusInput = (select = false) => {
    requestAnimationFrame(() => {
      input.current?.focus();
      if (select) input.current?.select();
    });
  };
  const cancel = () => {
    controller.current?.abort();
    setDraft(pending?.question ?? draft);
    setPending(null);
    focusInput();
  };
  const edit = (question: string) => {
    setDraft(question);
    focusInput(true);
  };
  const retry = (entry: AskEntry) => {
    setEntries((current) => current.filter((item) => item.id !== entry.id));
    ask(entry.question);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onClose();
  };

  const empty = entries.length === 0 && pending === null;
  const lastId = pending?.id ?? entries.at(-1)?.id;

  return createPortal(
    <>
      {/* Phones: a sheet over a dim page; a tap on the page closes it. */}
      <div
        aria-hidden="true"
        className="fixed inset-0 z-40 bg-overlay motion-safe:animate-fade-in md:hidden"
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        data-testid="ask-ai-panel"
        // The summary bar leaves the cells under the panel out (T470, `markSlivers`).
        data-covers-grid=""
        className="fixed z-40 flex flex-col border-line bg-surface text-fg shadow-popover outline-none max-md:inset-x-0 max-md:bottom-0 max-md:h-[min(88dvh,46rem)] max-md:rounded-t-lg max-md:border-t max-md:motion-safe:animate-sheet-in md:top-0 md:right-0 md:bottom-0 md:w-[min(28rem,100vw)] md:border-l md:motion-safe:animate-panel-in xl:w-120"
        onKeyDown={onKeyDown}
      >
        <div
          aria-hidden="true"
          className="mx-auto mt-2 h-1 w-9 rounded-full bg-line-strong md:hidden"
        />
        <header className="flex items-center gap-2 border-b border-line py-2 pr-2 pl-4">
          <Sparkles aria-hidden="true" className="size-4 shrink-0 text-accent" />
          <div className="flex min-w-0 flex-1 flex-col">
            <h2 id={titleId} className="text-heading font-semibold text-fg">
              {t('title')}
            </h2>
            <p className="truncate text-label font-normal text-fg-muted">
              {t('subtitle', { table: table.name })}
            </p>
          </div>
          <Tooltip content={t('close')}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('close')}
              data-testid="ask-ai-close"
              onClick={onClose}
            >
              <X aria-hidden="true" />
            </Button>
          </Tooltip>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 motion-safe:scroll-smooth">
          {empty ? (
            <div className="flex flex-col gap-5" data-testid="ask-empty">
              <div className="flex flex-col gap-1.5">
                <p className="text-body text-fg">{t('intro', { table: table.name })}</p>
                <p className="text-label font-normal text-fg-muted" data-testid="ask-privacy">
                  {ai.record_data ? t('privacy.withData') : t('privacy.namesOnly')}
                </p>
              </div>
              <div role="group" aria-labelledby={`${titleId}-try`} className="flex flex-col gap-2">
                <p id={`${titleId}-try`} className="text-label text-fg-muted">
                  {t('suggestions.label')}
                </p>
                <ul className="flex flex-col gap-1.5">
                  {suggestions.map((suggestion) => {
                    const text = t(suggestion.key, suggestion.params);
                    return (
                      <li key={suggestion.key}>
                        <button
                          type="button"
                          className="flex w-full items-start gap-2 rounded-md border border-line bg-surface px-3 py-2 text-left text-body text-fg transition-colors hover:border-line-strong hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-accent max-lg:min-h-control"
                          data-testid="ask-suggestion"
                          onClick={() => {
                            ask(text);
                          }}
                        >
                          <Sparkles
                            aria-hidden="true"
                            className="mt-0.5 size-3.5 shrink-0 text-fg-muted"
                          />
                          <span className="min-w-0">{text}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          ) : (
            <ol aria-label={t('history')} className="flex flex-col gap-6" data-testid="ask-history">
              {entries.map((entry) => (
                <li
                  key={entry.id}
                  ref={entry.id === lastId ? latest : undefined}
                  className="flex scroll-mt-4 flex-col gap-2"
                  data-testid="ask-entry"
                >
                  <Question text={entry.question} />
                  <AskOutcomeView
                    outcome={entry.outcome}
                    fields={fields}
                    Answer={Answer}
                    onEdit={() => {
                      edit(entry.question);
                    }}
                    onRetry={() => {
                      retry(entry);
                    }}
                  />
                </li>
              ))}
              {pending === null ? null : (
                <li
                  key={pending.id}
                  ref={latest}
                  className="flex scroll-mt-4 flex-col gap-2"
                  data-testid="ask-entry"
                >
                  <Question text={pending.question} />
                  <AiWaiting
                    text={t('waiting.text')}
                    later={ai.record_data ? t('waiting.laterWithData') : t('waiting.later')}
                    hint={t('waiting.hint')}
                    cancelLabel={t('common:actions.cancel')}
                    onCancel={cancel}
                  >
                    {/* The shape of an answer: the interpretation chips, then the chart. */}
                    <div className="flex gap-1.5">
                      <Skeleton className="h-5 w-24" />
                      <Skeleton className="h-5 w-20" />
                      <Skeleton className="h-5 w-16" />
                    </div>
                    <Skeleton className="h-72 w-full" />
                  </AiWaiting>
                </li>
              )}
            </ol>
          )}
        </div>

        <form
          noValidate
          className="border-t border-line px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
          onSubmit={(event) => {
            event.preventDefault();
            ask(draft);
          }}
        >
          <div className="flex items-end gap-2 rounded-lg border border-line-control bg-surface py-1.5 pr-1.5 pl-3 focus-within:outline-2 focus-within:outline-accent">
            <textarea
              ref={input}
              value={draft}
              rows={1}
              maxLength={AI_ASK_MAX_QUESTION_LENGTH}
              aria-label={t('composer.label')}
              aria-describedby={hintId}
              placeholder={t('composer.placeholder')}
              className="field-sizing-content max-h-40 min-h-8 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-body text-fg outline-none placeholder:text-fg-subtle"
              data-testid="ask-input"
              onChange={(event) => {
                setDraft(event.target.value);
              }}
              onKeyDown={(event) => {
                // Enter asks, Shift+Enter is a new line; never while an IME composes (Vietnamese).
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing)
                  return;
                event.preventDefault();
                ask(draft);
              }}
            />
            <Tooltip content={t('composer.send')}>
              <Button
                type="submit"
                size="icon"
                aria-label={t('composer.send')}
                disabled={draft.trim() === '' || pending !== null}
                className="size-8 shrink-0 max-lg:size-control"
                data-testid="ask-send"
              >
                <ArrowUp aria-hidden="true" />
              </Button>
            </Tooltip>
          </div>
          <p className="mt-1.5 flex flex-wrap justify-between gap-x-3 px-1 text-label font-normal text-fg-muted">
            <span id={hintId}>{t('composer.keys')}</span>
            <span className="tabular-nums">
              {t('composer.count', {
                count: draft.length,
                limit: numbers.format(AI_ASK_MAX_QUESTION_LENGTH),
              })}
            </span>
          </p>
        </form>
        <p role="status" className="sr-only" data-testid="ask-announcement">
          {announcement}
        </p>
      </section>
    </>,
    document.body,
  );
}

/** The asker's question, on the right like a sent message. */
function Question({ text }: { readonly text: string }) {
  const { t } = useTranslation('aiAsk');
  return (
    <p
      className="max-w-[85%] self-end rounded-lg rounded-br-sm bg-surface-sunken px-3 py-2 text-body whitespace-pre-wrap text-fg [overflow-wrap:anywhere] motion-safe:animate-reveal"
      data-testid="ask-question"
    >
      <span className="sr-only">{t('youAsked')} </span>
      {text}
    </p>
  );
}
