import { useSyncExternalStore, type ReactNode } from 'react';

import type { SharePageParts } from '../../../../lib/share/public-page';
import type { ShareApi } from '../api';
import type { ViewerChoices } from '../query';
import type { ShareMeta } from '@cellhive/contracts';
import type { LocaleContext } from '@cellhive/field-types';

/** What the shared grid and board get from the share page. */
export interface SharedViewProps {
  readonly meta: ShareMeta;
  readonly api: ShareApi;
  readonly parts: SharePageParts;
  readonly locale: LocaleContext;
  /** The viewer's filter/sort/search (kept by the page, survives a refresh of the link). */
  readonly choices: ViewerChoices;
  readonly onChoices: (choices: ViewerChoices) => void;
  /**
   * A request failed in a way that ends the page (link gone, password
   * needed again, session ended): the page shows the matching screen.
   */
  readonly onFatal: (error: unknown) => void;
  /** (T814) The download menu of a link with `allow_export` (a chunk of the page), else `null`. */
  readonly download: ReactNode;
}

const NARROW_QUERY = '(max-width: 767.98px)';

function subscribeNarrow(listener: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const media = window.matchMedia(NARROW_QUERY);
  media.addEventListener('change', listener);
  return () => {
    media.removeEventListener('change', listener);
  };
}

function isNarrow(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches;
}

/** Below 768 px (FRONTEND §9.4): cards instead of the grid, one column at a time on the board. */
export function useNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
}
