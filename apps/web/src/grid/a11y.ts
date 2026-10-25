import { useEffect } from 'react';

import { COMPUTE_ERROR_TOKENS } from './display/computed';

import type { HeaderBadge } from './computed-header';
import type { GridField } from './types';
import type { TFunction } from 'i18next';

/**
 * Accessibility of the canvas grid (FRONTEND §9.2). Glide keeps a hidden
 * `role="grid"` table in sync with the viewport (`aria-rowcount`, focused
 * cell announced); its column headers only carry the title. This module adds
 * the field type to each header's accessible name.
 */

/** i18n key (namespace `grid`) of the type name of a field, refined by style. */
export function typeLabelKey(field: GridField): string {
  const config = field.config;
  if (config === null) return `types.${field.field.type}`;
  switch (config.type) {
    case 'text':
      return config.options.style.type === 'plain'
        ? 'types.text'
        : `types.text_${config.options.style.type}`;
    case 'number': {
      const style = config.options.style;
      if (style.type === 'plain')
        return style.percentage ? 'types.number_percentage' : 'types.number';
      return `types.number_${style.type}`;
    }
    case 'select':
      return config.options.multiple ? 'types.select_multiple' : 'types.select';
    default:
      return `types.${config.type}`;
  }
}

/**
 * Accessible name of a column header: "Status, single select" (+ "primary
 * field"). A computed column (T468) adds its state: locked, its error token,
 * or the progress of a recompute (`badge`).
 */
export function columnHeaderLabel(
  field: GridField,
  t: TFunction<'grid'>,
  badge?: HeaderBadge,
): string {
  const type = t(typeLabelKey(field) as 'types.text');
  const label = field.field.is_primary
    ? t('header.primaryLabel', { name: field.field.name, type })
    : t('header.label', { name: field.field.name, type });
  const computed = field.computed;
  if (computed === undefined) return label;
  if (computed.error !== null) {
    return t('header.computedError', { label, token: COMPUTE_ERROR_TOKENS[computed.error.code] });
  }
  if (computed.locked) return t('header.computedLocked', { label });
  if (badge?.kind === 'progress') {
    return t(computed.state === 'backfilling' ? 'header.computedFilling' : 'header.computing', {
      label,
      percent: Math.round(badge.progress * 100),
    });
  }
  return label;
}

/**
 * (T554) A note of a column header: shown when the header is hovered and
 * read with its accessible name ("Due, date, Reminder: 1 day before…").
 * `warning`: something is wrong (the tip is drawn as an error).
 */
export interface HeaderHint {
  readonly text: string;
  readonly warning: boolean;
}

/**
 * Sets `aria-label` on the column headers of glide's accessibility table
 * inside `container`, and again whenever glide re-renders it (scrolling
 * changes which columns it lists). `columnOffset` is the number of columns
 * before the first field column in `aria-colindex` (glide does not count
 * its row-marker column: 0).
 */
export function useColumnHeaderLabels(
  container: HTMLElement | null,
  labels: readonly string[],
  columnOffset: number,
): void {
  useEffect(() => {
    if (container === null) return;
    const apply = () => {
      for (const header of container.querySelectorAll('th[role="columnheader"]')) {
        const index = Number(header.getAttribute('aria-colindex')) - 1 - columnOffset;
        const label = labels[index];
        if (label !== undefined && header.getAttribute('aria-label') !== label) {
          header.setAttribute('aria-label', label);
        }
      }
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(container, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
    };
  }, [container, labels, columnOffset]);
}
