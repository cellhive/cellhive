import { cn, Spinner } from '@cellhive/ui';
import { Check, X } from 'lucide-react';

/** What happens to one phase of a job. */
export type JobPhaseState = 'done' | 'active' | 'failed' | 'pending';

export interface JobPhase {
  readonly key: string;
  /** Translated name of the phase. */
  readonly label: string;
}

export interface JobPhasesProps {
  readonly phases: readonly JobPhase[];
  /**
   * The phase in progress (`null` before the first one starts: queued, or
   * the upload of an import); every phase before it is done.
   */
  readonly current: string | null;
  /** Every phase is done (the job succeeded). */
  readonly finished?: boolean;
  /** The current phase failed (the job failed or was cancelled in it). */
  readonly failed?: boolean;
  /** Overall progress, 0–1. */
  readonly progress: number;
  /** Translated accessible name of the progress bar. */
  readonly label: string;
  /** Translated value of the progress bar, e.g. "42%". */
  readonly valueText: string;
  /** Translated `sr-only` state of a phase, e.g. "done", "in progress". */
  readonly stateText: Readonly<Record<JobPhaseState, string>>;
  readonly className?: string;
}

/** The state of each phase from the current one. */
export function phaseStates(
  phases: readonly JobPhase[],
  current: string | null,
  finished: boolean,
  failed: boolean,
): JobPhaseState[] {
  const index = current === null ? -1 : phases.findIndex((phase) => phase.key === current);
  return phases.map((_phase, position) => {
    if (finished) return 'done';
    if (position < index) return 'done';
    if (position === index) return failed ? 'failed' : 'active';
    return 'pending';
  });
}

const DOT = 'flex size-5 shrink-0 items-center justify-center rounded-full';

function PhaseIcon({ state }: { readonly state: JobPhaseState }) {
  switch (state) {
    case 'done':
      return (
        // Remounts when the phase ends, so its check pops in (FRONTEND §9.3 motion).
        <span className={cn(DOT, 'animate-pop-in bg-accent text-on-accent')}>
          <Check aria-hidden="true" className="size-3.5" strokeWidth={3} />
        </span>
      );
    case 'active':
      return (
        <span className={cn(DOT, 'text-accent')}>
          <Spinner />
        </span>
      );
    case 'failed':
      return (
        <span className={cn(DOT, 'animate-pop-in bg-danger text-on-danger')}>
          <X aria-hidden="true" className="size-3.5" strokeWidth={3} />
        </span>
      );
    default:
      return <span className={cn(DOT, 'border-2 border-line-strong')} aria-hidden="true" />;
  }
}

/**
 * Progress of a job that runs in named phases (the `.chbase` export and
 * import, CONTRACTS §12.2, FRONTEND §17.5): a determinate bar, then the
 * phases in order — done (check), in progress (spinner), not started (ring)
 * — with the state as text for screen readers, not only as an icon.
 */
export function JobPhases({
  phases,
  current,
  finished = false,
  failed = false,
  progress,
  label,
  valueText,
  stateText,
  className,
}: JobPhasesProps) {
  const percent = Math.round(Math.min(1, Math.max(0, progress)) * 100);
  const states = phaseStates(phases, current, finished, failed);
  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={valueText}
        className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken"
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-(--motion-sheet) ease-(--ease-enter) motion-reduce:transition-none',
            failed ? 'bg-danger' : 'bg-accent',
          )}
          style={{ width: `${String(percent)}%` }}
        />
      </div>
      <ol className="flex flex-col gap-2" data-testid="job-phases">
        {phases.map((phase, position) => {
          const state = states[position] ?? 'pending';
          return (
            <li
              key={phase.key}
              className="flex items-center gap-3 text-body"
              aria-current={state === 'active' ? 'step' : undefined}
              data-state={state}
            >
              <PhaseIcon key={state} state={state} />
              <span
                className={cn(
                  state === 'pending' ? 'text-fg-muted' : 'text-fg',
                  state === 'active' && 'font-medium',
                  state === 'failed' && 'font-medium text-danger',
                )}
              >
                {phase.label}
              </span>
              <span className="sr-only">{stateText[state]}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
