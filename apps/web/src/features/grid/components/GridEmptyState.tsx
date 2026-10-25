import { Button } from '@cellhive/ui';
import { useTranslation } from 'react-i18next';

export interface GridEmptyStateProps {
  /** A filter or a search hides every row: say so and offer to clear it. */
  readonly narrowedBy: 'filter' | 'search' | null;
  /** Clears the filter (as a temporary change of the view) and the search. */
  readonly onClear?: (() => void) | undefined;
}

/**
 * No row to show (T320b, design "Design tokens → Trạng thái trống"): a
 * dashed box over the empty grid — on the surface color, so no grid line
 * runs through the text. Filtered or searched to nothing: "No records match
 * the filter", a hint and "Clear filter".
 */
export function GridEmptyState({ narrowedBy, onClear }: GridEmptyStateProps) {
  const { t } = useTranslation('grid');
  const filtered = narrowedBy !== null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-20 flex justify-center px-4">
      <section
        aria-labelledby="grid-empty-title"
        data-testid="grid-empty"
        className="pointer-events-auto flex w-full max-w-md flex-col items-start gap-1 rounded-lg border border-dashed border-line-strong bg-surface p-4"
      >
        <h2 id="grid-empty-title" className="text-body font-medium">
          {filtered
            ? t(narrowedBy === 'filter' ? 'empty.filteredTitle' : 'empty.searchTitle')
            : t('empty.title')}
        </h2>
        <p className="text-body text-fg-muted">
          {filtered ? t('empty.filteredHint') : t('empty.description')}
        </p>
        {filtered && onClear !== undefined ? (
          <Button variant="secondary" size="toolbar" className="mt-2" onClick={onClear}>
            {t('empty.clearFilter')}
          </Button>
        ) : null}
      </section>
    </div>
  );
}
