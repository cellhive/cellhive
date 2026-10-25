import { Button } from '@cellhive/ui';
import { RefreshCw, RotateCw } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { isComputing } from '../../../grid/display/computed';
import { progressOf, useComputedProgress } from '../../../lib/realtime/computed-progress';

import type { GridField } from '../../../grid';

/** Field ids a filter DSL names (any nesting: groups, `not`). */
export function filterFieldIds(filter: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(filter)) {
    for (const item of filter) filterFieldIds(item, into);
  } else if (typeof filter === 'object' && filter !== null) {
    for (const [key, value] of Object.entries(filter)) {
      if (key === 'field' && typeof value === 'string') into.add(value);
      else filterFieldIds(value, into);
    }
  }
  return into;
}

export interface RecomputeBannerProps {
  /** Every column of the table (hidden ones too: a filter may use them). */
  readonly fields: readonly GridField[];
  readonly filter: unknown;
  readonly sort: readonly { readonly field: string }[];
  readonly group: readonly { readonly field: string }[];
  readonly onRefresh: () => void;
}

/**
 * "Results may be out of date" (T468, board "S4b · Cột tính toán: lỗi và
 * tính lại"): the view filters, sorts or groups by a computed field being
 * recomputed — rows may move once the job is done (the grid refreshes
 * itself then: the field's `schema.changed`). "Refresh now" loads the rows
 * again with the values computed so far.
 */
export function RecomputeBanner({ fields, filter, sort, group, onRefresh }: RecomputeBannerProps) {
  const { t, i18n } = useTranslation('grid');
  const progress = useComputedProgress();
  const used = useMemo(() => {
    const filtered = filterFieldIds(filter);
    const sorted = new Set(sort.map((key) => key.field));
    const grouped = new Set(group.map((key) => key.field));
    const computing = fields.filter((field) => isComputing(field.computed));
    const hit = (ids: Set<string>) => computing.filter((field) => ids.has(field.field.id));
    return {
      fields: [...new Set([...hit(filtered), ...hit(sorted), ...hit(grouped)])],
      parts: [
        ...(hit(filtered).length > 0 ? ['filter'] : []),
        ...(hit(sorted).length > 0 ? ['sort'] : []),
        ...(hit(grouped).length > 0 ? ['group'] : []),
      ] as const,
    };
  }, [fields, filter, sort, group]);
  if (used.fields.length === 0) return null;
  const list = new Intl.ListFormat(i18n.language, { type: 'conjunction' });
  const uses = list.format(used.parts.map((part) => t(`computed.banner.parts.${part}`)));
  const percent = Math.round(
    Math.min(...used.fields.map((field) => progressOf(progress.get(field.field.id)))) * 100,
  );
  return (
    <div
      role="status"
      data-testid="recompute-banner"
      className="flex min-h-10 shrink-0 items-center gap-2 border-b border-option-3 bg-option-3 px-4 py-1.5 text-label font-normal text-on-option-3 max-md:flex-wrap"
    >
      <RotateCw aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        <strong className="font-semibold">{t('computed.banner.title')}</strong>{' '}
        {t('computed.banner.body', {
          uses: uses.charAt(0).toLocaleUpperCase(i18n.language) + uses.slice(1),
          names: list.format(used.fields.map((field) => field.field.name)),
        })}
        {/* The percentage moves with every batch: shown, not announced again and again. */}
        <span aria-hidden="true" className="tabular-nums">{` (${String(percent)}%)`}</span>
        {t('computed.banner.end')}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 text-on-option-3 max-lg:h-control"
        onClick={onRefresh}
      >
        <RefreshCw aria-hidden="true" className="size-3.5" />
        {t('computed.banner.refresh')}
      </Button>
    </div>
  );
}
