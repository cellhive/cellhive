import { toWallTime, fieldTimeZone, type WallTime } from '@cellhive/field-types';
import { Button, cn } from '@cellhive/ui';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { datetimeDraft, datetimeInputText, isDateOnly, valueOfWallTime, wallTimeOf } from './parse';
import { CELL_INPUT_CLASS, EditorFrame, handleEditorKey, useIssueMessage } from './shell';
import { MOVE_NONE, type CellEditorProps, type EditorIssue, type EditorMove } from './types';

interface Month {
  readonly year: number;
  readonly month: number;
}

const DAY_MS = 86_400_000;

/** Days shown for a month: from the Monday before the 1st, six weeks. */
function monthDays(month: Month): { year: number; month: number; day: number }[] {
  const first = Date.UTC(month.year, month.month - 1, 1);
  const weekday = (new Date(first).getUTCDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(first + (index - weekday) * DAY_MS);
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
  });
}

function shiftMonth(month: Month, delta: number): Month {
  const index = month.year * 12 + (month.month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

function addDays(wall: WallTime, days: number): WallTime {
  const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day) + days * DAY_MS);
  return {
    ...wall,
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

/**
 * `datetime` editor. The text is typed in the field's display format
 * (`style.format`) and read in the field's zone; the calendar below picks a
 * day with the mouse (Arrow Up/Down change the day, Page Up/Down the month,
 * from the keyboard). A date-only field writes the picked day at once.
 */
export function DatetimeEditor({
  field,
  config,
  value,
  initialInput,
  cellHeight,
  cellWidth,
  context,
  onDraft,
  onCommit,
  onCancel,
}: CellEditorProps<'datetime'>) {
  const { t, i18n } = useTranslation('grid');
  const options = config.options;
  const ctx = context.locale;
  const dateOnly = isDateOnly(options);
  const [text, setText] = useState(() => initialInput ?? datetimeInputText(value, options, ctx));
  const [issue, setIssue] = useState<EditorIssue | null>(null);
  const error = useIssueMessage(issue);
  const errorId = useId();
  const input = useRef<HTMLInputElement>(null);

  const current = useMemo(() => {
    const draft = datetimeDraft(text, options, ctx);
    return draft.ok ? wallTimeOf(draft.commit.value, options, ctx) : null;
  }, [text, options, ctx]);
  const [today] = useState(() => toWallTime(Date.now(), fieldTimeZone(options, ctx)));
  const [month, setMonth] = useState<Month>(() => {
    const start = wallTimeOf(value, options, ctx) ?? today;
    return { year: start.year, month: start.month };
  });

  useEffect(() => {
    const element = input.current;
    if (element === null) return;
    element.focus();
    if (initialInput === undefined) element.select();
  }, [initialInput]);

  const setDraftText = (next: string) => {
    setText(next);
    setIssue(null);
    onDraft(datetimeDraft(next, options, ctx));
  };

  const pick = (wall: WallTime, commitNow: boolean) => {
    const picked = valueOfWallTime(wall, options, ctx);
    const next = datetimeInputText(picked, options, ctx);
    setMonth({ year: wall.year, month: wall.month });
    if (commitNow) {
      onCommit({ value: picked, display: picked, typecast: false }, MOVE_NONE);
      return;
    }
    setDraftText(next);
  };

  const commit = (move: EditorMove) => {
    const draft = datetimeDraft(text, options, ctx);
    if (!draft.ok) {
      setIssue(draft.issue);
      return;
    }
    onCommit(draft.commit, move);
  };

  const monthLabel = new Intl.DateTimeFormat(i18n.language, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(Date.UTC(month.year, month.month - 1, 1));
  const dayLabel = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'full', timeZone: 'UTC' });
  const weekdays = Array.from({ length: 7 }, (_, index) =>
    new Intl.DateTimeFormat(i18n.language, { weekday: 'narrow', timeZone: 'UTC' }).format(
      Date.UTC(2024, 0, 1 + index),
    ),
  );
  const days = monthDays(month);
  const same = (a: { year: number; month: number; day: number } | null, b: typeof a) =>
    a !== null && b !== null && a.year === b.year && a.month === b.month && a.day === b.day;

  return (
    <EditorFrame
      cellWidth={cellWidth}
      cellHeight={cellHeight}
      error={error}
      errorId={errorId}
      className="w-64"
    >
      <input
        ref={input}
        type="text"
        autoComplete="off"
        aria-label={field.name}
        aria-invalid={issue !== null}
        aria-describedby={issue === null ? `${errorId}-format` : errorId}
        placeholder={options.style.format}
        value={text}
        className={cn(CELL_INPUT_CLASS, 'tabular-nums', issue !== null && 'ring-danger')}
        style={{ height: cellHeight }}
        onChange={(event) => {
          setDraftText(event.target.value);
        }}
        onKeyDown={(event) => {
          const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
          const monthStep = event.key === 'PageDown' ? 1 : event.key === 'PageUp' ? -1 : 0;
          if (step !== 0 || monthStep !== 0) {
            event.preventDefault();
            event.stopPropagation();
            const base = current ?? { ...today, hour: 0, minute: 0, second: 0, millisecond: 0 };
            const moved =
              monthStep === 0
                ? addDays(base, step)
                : (() => {
                    const target = shiftMonth(base, monthStep);
                    const last = new Date(Date.UTC(target.year, target.month, 0)).getUTCDate();
                    return { ...base, ...target, day: Math.min(base.day, last) };
                  })();
            pick(moved, false);
            return;
          }
          handleEditorKey(event, { commit, cancel: onCancel });
        }}
      />
      <p id={`${errorId}-format`} className="sr-only">
        {t('edit.dateFormat', { format: options.style.format })}
      </p>
      {/* The calendar scrolls when the window is too short for it (the input never shrinks). */}
      <div className="min-h-0 overflow-y-auto">
        <div className="flex items-center justify-between gap-2 px-2 pt-2">
          <Button
            variant="ghost"
            size="icon"
            tabIndex={-1}
            aria-label={t('edit.previousMonth')}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => {
              setMonth((shown) => shiftMonth(shown, -1));
            }}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <span aria-live="polite" className="text-label">
            {monthLabel}
          </span>
          <Button
            variant="ghost"
            size="icon"
            tabIndex={-1}
            aria-label={t('edit.nextMonth')}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => {
              setMonth((shown) => shiftMonth(shown, 1));
            }}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
        <div
          role="group"
          aria-label={monthLabel}
          className="grid grid-cols-7 gap-0.5 p-2 text-center"
        >
          {weekdays.map((weekday, index) => (
            <span
              key={`${weekday}-${String(index)}`}
              aria-hidden="true"
              className="text-label text-fg-muted"
            >
              {weekday}
            </span>
          ))}
          {days.map((day) => {
            const outside = day.month !== month.month;
            const chosen = same(day, current);
            return (
              <button
                key={`${String(day.year)}-${String(day.month)}-${String(day.day)}`}
                type="button"
                tabIndex={-1}
                aria-label={dayLabel.format(Date.UTC(day.year, day.month - 1, day.day))}
                aria-pressed={chosen}
                className={cn(
                  'h-7 rounded-md text-body tabular-nums hover:bg-surface-sunken',
                  outside && 'text-fg-subtle',
                  same(day, today) && 'font-semibold text-accent',
                  chosen && 'bg-accent text-on-accent hover:bg-accent',
                )}
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => {
                  const time = current ?? { hour: 0, minute: 0 };
                  pick(
                    {
                      ...day,
                      hour: dateOnly ? 0 : time.hour,
                      minute: dateOnly ? 0 : time.minute,
                      second: 0,
                      millisecond: 0,
                    },
                    dateOnly,
                  );
                }}
              >
                {day.day}
              </button>
            );
          })}
        </div>
      </div>
    </EditorFrame>
  );
}
