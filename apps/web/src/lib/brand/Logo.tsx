import { useTranslation } from 'react-i18next';

/** Product mark + name. Neutral, no third-party brand assets (SPEC §1A). */
export function Logo({ className }: { className?: string }) {
  const { t } = useTranslation('common');
  return (
    <span className={`inline-flex items-center gap-2 text-heading text-fg ${className ?? ''}`}>
      <svg aria-hidden="true" viewBox="0 0 32 32" className="size-6">
        <rect width="32" height="32" rx="8" className="fill-accent" />
        <path
          d="M9 11h14M9 16h14M9 21h14M13 9v14"
          className="stroke-on-accent"
          strokeWidth="2"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
      {t('app.name')}
    </span>
  );
}
