import type { ReactNode } from 'react';

/** Centered message of an empty or unavailable trash tab. */
export function EmptyState({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line-strong bg-surface px-6 py-12 text-center">
      {icon}
      <h2 className="text-heading">{title}</h2>
      <p className="max-w-md text-fg-muted">{description}</p>
    </div>
  );
}
