import { Button, cn, Skeleton } from '@cellhive/ui';
import {
  MessageCircleQuestion,
  PencilLine,
  RefreshCw,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import { Suspense, useId, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { askErrorOf } from '../model/errors';
import { interpretationChips } from '../model/interpretation';

import type { AiAnswer, AskAnswerWidgetComponent } from '../../../lib/ai/ask';
import type { AskOutcome } from '../model/session';
import type { FieldDto } from '@cellhive/contracts';

/** Room of the widget in the panel: charts a fixed height, tables scroll, a KPI its own. */
function widgetBox(type: AiAnswer['widget']['type']): string {
  if (type === 'kpi') return 'min-h-16';
  if (type === 'table') return 'max-h-80 overflow-auto';
  return 'h-72';
}

export interface AskOutcomeViewProps {
  readonly outcome: AskOutcome;
  readonly fields: readonly FieldDto[];
  readonly Answer: AskAnswerWidgetComponent;
  /** "Edit question": the question back in the box. */
  readonly onEdit: () => void;
  /** "Try again": the same question again. */
  readonly onRetry: () => void;
}

/**
 * What one question got (T914, research S8 §5.5): the answer — its title,
 * the "Interpretation" chips, the number, chart or table drawn by the
 * dashboard's widget renderer, the narrative in plain text under it when
 * there is one —, a neutral "Couldn't answer this yet" that names no field,
 * or the error with "Try again" when that can help.
 */
export function AskOutcomeView({ outcome, fields, Answer, onEdit, onRetry }: AskOutcomeViewProps) {
  const { t } = useTranslation('aiAsk');
  const edit = (
    <Button variant="ghost" size="sm" className="max-lg:h-control" onClick={onEdit}>
      <PencilLine aria-hidden="true" />
      {t('edit')}
    </Button>
  );
  if (outcome.kind === 'answer') {
    return <AnswerView answer={outcome.answer} fields={fields} Answer={Answer} edit={edit} />;
  }
  if (outcome.kind === 'unanswerable') {
    return (
      <div
        className="flex items-start gap-3 rounded-lg border border-line bg-surface p-3 motion-safe:animate-reveal"
        data-testid="ask-unanswerable"
      >
        <MessageCircleQuestion
          aria-hidden="true"
          className="mt-0.5 size-5 shrink-0 text-fg-muted"
        />
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
          <p className="text-body font-medium text-fg">{t('unanswerable.title')}</p>
          <p className="text-label font-normal text-fg-muted">{t('unanswerable.detail')}</p>
          <div className="-ml-2">{edit}</div>
        </div>
      </div>
    );
  }
  return <ErrorView error={outcome.error} edit={edit} onRetry={onRetry} />;
}

function ErrorView({
  error,
  edit,
  onRetry,
}: {
  readonly error: unknown;
  readonly edit: ReactNode;
  readonly onRetry: () => void;
}) {
  const { t, i18n } = useTranslation('aiAsk');
  const { message, retry } = askErrorOf(error, i18n);
  return (
    <div
      className="flex items-start gap-3 rounded-lg border border-danger bg-surface p-3 motion-safe:animate-reveal"
      data-testid="ask-error"
    >
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
        <p className="text-body text-fg" data-testid="ask-error-message">
          {message}
        </p>
        <div className="-ml-2 flex flex-wrap gap-1">
          {retry ? (
            <Button variant="ghost" size="sm" className="max-lg:h-control" onClick={onRetry}>
              <RefreshCw aria-hidden="true" />
              {t('retry')}
            </Button>
          ) : null}
          {edit}
        </div>
      </div>
    </div>
  );
}

function AnswerView({
  answer,
  fields,
  Answer,
  edit,
}: {
  readonly answer: AiAnswer;
  readonly fields: readonly FieldDto[];
  readonly Answer: AskAnswerWidgetComponent;
  readonly edit: ReactNode;
}) {
  const { t, i18n } = useTranslation('aiAsk');
  const titleId = useId();
  const chipsId = useId();
  const chips = useMemo(
    () =>
      interpretationChips(
        answer.interpretation,
        (key, params) => t(key, params ?? {}),
        i18n.language,
      ),
    [answer.interpretation, t, i18n.language],
  );
  const title = answer.widget.title.trim() === '' ? t('untitled') : answer.widget.title;
  return (
    <article
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3 motion-safe:animate-reveal"
      data-testid="ask-answer"
      data-widget-type={answer.widget.type}
    >
      <h3 id={titleId} className="text-heading font-semibold text-fg">
        {title}
      </h3>
      <div className="flex flex-col gap-1.5">
        <p id={chipsId} className="text-label font-normal text-fg-muted">
          {t('interpretation')}
        </p>
        <ul
          aria-labelledby={chipsId}
          className="flex flex-wrap gap-1.5"
          data-testid="ask-interpretation"
        >
          {chips.map((chip) => (
            <li
              key={chip.id}
              data-kind={chip.kind}
              className={cn(
                'max-w-full rounded-sm border border-line bg-surface-sunken px-2 py-0.5 text-label font-normal text-fg [overflow-wrap:anywhere]',
                chip.kind === 'metric' && 'font-medium',
              )}
            >
              {chip.text}
            </li>
          ))}
        </ul>
      </div>
      <div className={widgetBox(answer.widget.type)} data-testid="ask-widget">
        <Suspense
          fallback={
            <Skeleton
              aria-hidden="true"
              className={answer.widget.type === 'kpi' ? 'h-16 w-40' : 'h-72 w-full'}
            />
          }
        >
          <Answer widget={answer.widget} data={answer.data} fields={fields} />
        </Suspense>
      </div>
      {answer.narrative === null || answer.narrative.trim() === '' ? null : (
        <div className="flex flex-col gap-1 border-t border-line pt-3" data-testid="ask-narrative">
          <p className="flex items-center gap-1.5 text-label font-normal text-fg-muted">
            <Sparkles aria-hidden="true" className="size-3.5 shrink-0" />
            {t('narrative')}
          </p>
          {/* Model text: plain text only, never Markdown or HTML (CONTRACTS §29.4). */}
          <p className="text-body whitespace-pre-line text-fg [overflow-wrap:anywhere]">
            {answer.narrative}
          </p>
        </div>
      )}
      <div className="-ml-2 -mb-1">{edit}</div>
    </article>
  );
}
