import { Button, cn, Spinner } from '@cellhive/ui';
import { useEffect, useState, type ReactNode } from 'react';

/** After this long the text says the answer is being checked (repair rounds, CONTRACTS §29.7). */
export const AI_WAITING_LATER_MS = 12_000;

export interface AiWaitingProps {
  /** What is happening now ("Writing the formula…"). */
  readonly text: string;
  /** Said instead once the wait gets long ("Checking … and fixing it if needed…"). */
  readonly later: string;
  /** Why it may take a while ("… up to 90 seconds"). */
  readonly hint: string;
  readonly cancelLabel: string;
  readonly onCancel: () => void;
  /** A skeleton shaped like the answer (`Skeleton`s), below the status line. */
  readonly children?: ReactNode;
  readonly className?: string;
}

/**
 * The wait of an AI request (research S8 §5.4; no streaming, up to the 90 s
 * budget of the server): the status in words — one polite announcement when
 * it starts and one when it gets long, never a ticking count —, "Cancel"
 * (aborts the request on the client) and a shimmering skeleton the size of
 * the answer. The texts come from the caller's namespace.
 */
export function AiWaiting({
  text,
  later,
  hint,
  cancelLabel,
  onCancel,
  children,
  className,
}: AiWaitingProps) {
  const [long, setLong] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setLong(true);
    }, AI_WAITING_LATER_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, []);
  return (
    <div
      aria-busy="true"
      className={cn(
        'flex flex-col gap-2.5 rounded-md border border-line bg-surface px-3 py-2.5 motion-safe:animate-reveal',
        className,
      )}
      data-testid="ai-waiting"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Spinner className="text-accent" />
        <p role="status" className="flex min-w-0 flex-1 basis-48 flex-col">
          <span className="text-body text-fg">{long ? later : text}</span>
          <span className="text-label font-normal text-fg-muted">{hint}</span>
        </p>
        <Button variant="secondary" size="sm" className="max-lg:h-control" onClick={onCancel}>
          {cancelLabel}
        </Button>
      </div>
      {children}
    </div>
  );
}
