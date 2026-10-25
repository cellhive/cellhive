export interface ProgressBarProps {
  /** 0–1. */
  readonly value: number;
  /** Translated accessible name. */
  readonly label: string;
  /** Translated value text, e.g. "42% — 21,000 of 50,000 rows". */
  readonly valueText?: string;
}

/** A determinate progress bar (upload, import job). */
export function ProgressBar({ value, label, valueText }: ProgressBarProps) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
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
        className="h-full bg-accent transition-[width] motion-reduce:transition-none"
        style={{ width: `${String(percent)}%` }}
      />
    </div>
  );
}
