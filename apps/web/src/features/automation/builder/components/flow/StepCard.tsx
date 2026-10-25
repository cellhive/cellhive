import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
} from '@cellhive/ui';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  GripVertical,
  MoreHorizontal,
  Trash2,
} from 'lucide-react';
import { type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { LucideIcon } from 'lucide-react';

export interface StepCardProps {
  readonly stepKey: string;
  /** "When", "Run only if", "Step 2.1". */
  readonly eyebrow: string;
  readonly title: string;
  readonly body: ReactNode;
  readonly icon: LucideIcon;
  readonly selected: boolean;
  readonly issueCount: number;
  readonly onSelect: () => void;
  /** Steps you can move and delete (actions); absent for the trigger and the condition. */
  readonly actions?:
    | {
        readonly sortableId: string;
        readonly canUp: boolean;
        readonly canDown: boolean;
        readonly onMove: (delta: number) => void;
        readonly onDelete: () => void;
      }
    | undefined;
  readonly readOnly: boolean;
  readonly narrow?: boolean;
  readonly muted?: boolean;
}

/** Moves the focus to the previous/next card of the flow (↑/↓, board shortcut line). */
function focusSibling(from: HTMLElement, delta: number) {
  const all = [...document.querySelectorAll<HTMLElement>('[data-step-button]')];
  const index = all.indexOf(from);
  all[index + delta]?.focus();
}

/**
 * One card of the flow (board "S5 · Automation builder"): icon, "When" /
 * "Step N", title and a summary with chips. The title is the button that
 * opens its settings (Enter); ↑/↓ go to the previous/next card; actions
 * move with Alt+↑/↓ or the grip (pointer), and have a menu (move, delete).
 * A card with issues has a red border and says how many.
 */
export function StepCard({
  stepKey,
  eyebrow,
  title,
  body,
  icon: Icon,
  selected,
  issueCount,
  onSelect,
  actions,
  readOnly,
  narrow = false,
  muted = false,
}: StepCardProps) {
  const { t } = useTranslation('automationBuilder');
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: actions?.sortableId ?? stepKey,
    disabled: actions === undefined || readOnly,
  });
  const style = { transform: CSS.Translate.toString(transform), transition };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const delta = event.key === 'ArrowUp' ? -1 : 1;
    event.preventDefault();
    if (event.altKey) {
      if (actions === undefined || readOnly) return;
      if ((delta < 0 && actions.canUp) || (delta > 0 && actions.canDown)) actions.onMove(delta);
      return;
    }
    focusSibling(event.currentTarget, delta);
  };
  return (
    <article
      ref={setNodeRef}
      style={style}
      aria-labelledby={`${stepKey}-title`}
      data-step={stepKey}
      data-testid={`step-${stepKey}`}
      data-selected={selected || undefined}
      className={cn(
        'relative flex w-full gap-3 rounded-lg border bg-surface px-3.5 py-3 text-left',
        selected ? 'border-2 border-accent px-[13px] py-[11px]' : 'border-line-strong',
        issueCount > 0 && 'border-2 border-danger px-[13px] py-[11px]',
        isDragging && 'z-10 shadow-popover',
        muted && 'opacity-80',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-md',
          stepKey === 'trigger' ? 'bg-accent-soft text-accent' : 'bg-surface-sunken text-fg-muted',
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span
          className={cn(
            'text-label font-medium',
            stepKey === 'trigger' ? 'text-accent' : 'text-fg-muted',
          )}
        >
          {eyebrow}
        </span>
        {readOnly && narrow ? (
          <h3 id={`${stepKey}-title`} className="text-body font-semibold">
            {title}
          </h3>
        ) : (
          <h3 className="text-body font-semibold">
            <button
              id={`${stepKey}-title`}
              type="button"
              data-step-button={stepKey}
              aria-expanded={selected}
              aria-describedby={issueCount > 0 ? `${stepKey}-issues` : undefined}
              className="text-left after:absolute after:inset-0 after:content-[''] focus-visible:outline-none [&:focus-visible]:after:rounded-lg [&:focus-visible]:after:outline-2 [&:focus-visible]:after:outline-accent"
              onClick={onSelect}
              onKeyDown={onKeyDown}
            >
              {title}
            </button>
          </h3>
        )}
        <div className="text-label leading-[1.7] font-normal break-words text-fg-muted">{body}</div>
        {issueCount > 0 ? (
          <p id={`${stepKey}-issues`} className="flex items-center gap-1 text-label text-danger">
            <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
            {t('flow.issues', { count: issueCount })}
          </p>
        ) : null}
      </div>
      {actions === undefined || readOnly ? null : (
        <div className="relative z-[1] flex shrink-0 flex-col items-center gap-1 self-center">
          <DropdownMenu modal={false}>
            <Tooltip content={t('flow.menu', { title })}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 max-lg:size-control"
                  aria-label={t('flow.menu', { title })}
                >
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={!actions.canUp}
                onSelect={() => {
                  actions.onMove(-1);
                }}
              >
                <ArrowUp aria-hidden="true" />
                {t('flow.moveUp')}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!actions.canDown}
                onSelect={() => {
                  actions.onMove(1);
                }}
              >
                <ArrowDown aria-hidden="true" />
                {t('flow.moveDown')}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-danger [&_svg]:text-danger"
                onSelect={actions.onDelete}
              >
                <Trash2 aria-hidden="true" />
                {t('flow.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <span
            {...attributes}
            {...listeners}
            role="presentation"
            tabIndex={-1}
            aria-hidden="true"
            className="flex size-6 cursor-grab touch-none items-center justify-center text-fg-muted"
          >
            <GripVertical className="size-4" />
          </span>
        </div>
      )}
    </article>
  );
}
