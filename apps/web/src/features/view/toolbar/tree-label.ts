import type { TFunction } from 'i18next';

/** Most levels of a tree (the "Expand all" of the toolbar). */
const ALL_LEVELS = 10;

/**
 * Label of the toolbar's tree button (T417, T421b): what the default opens —
 * "collapsed" for the roots only (1 level: no branch is open), "N levels
 * open", or "all open" at the maximum.
 */
export function treeButtonLabel(t: TFunction<'tree'>, on: boolean, levels: number): string {
  if (!on) return t('toolbar.button');
  if (levels <= 1) return t('toolbar.buttonCollapsed');
  if (levels >= ALL_LEVELS) return t('toolbar.buttonAll');
  return t('toolbar.buttonOn', { count: levels });
}
