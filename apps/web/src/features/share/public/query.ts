import type { ShareMeta, ShareRecordQueryRequest } from '@cellhive/contracts';

/** A sort key of the viewer (field id). */
export interface ViewerSortKey {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

/**
 * What a viewer of a shared view changed on this device (never saved): a
 * filter narrowing the view (the view filter always applies on the server),
 * a sort replacing the view's, a search of the primary field.
 */
export interface ViewerChoices {
  readonly filter: Readonly<Record<string, unknown>> | null;
  readonly sort: readonly ViewerSortKey[];
  readonly search: string;
}

export function initialChoices(meta: ShareMeta): ViewerChoices {
  return {
    filter: null,
    sort: meta.view.config.sort.map((key) => ({ field: key.field, direction: key.direction })),
    search: '',
  };
}

function sameSort(a: readonly ViewerSortKey[], b: readonly ViewerSortKey[]): boolean {
  return (
    a.length === b.length &&
    a.every((key, index) => key.field === b[index]?.field && key.direction === b[index].direction)
  );
}

/**
 * The query of the shared view for the viewer's choices, only what the link
 * allows (CONTRACTS §16A: anything else is `403`): `filter` and a sort
 * different from the view's (`sort_mode: replace`) with
 * `allow_viewer_filter_sort`, `search` with `allow_search`. Nothing is sent
 * for choices equal to the view's.
 */
export function shareRecordQuery(
  meta: ShareMeta,
  choices: ViewerChoices,
): Pick<ShareRecordQueryRequest, 'filter' | 'sort' | 'sort_mode' | 'search'> {
  const query: Pick<ShareRecordQueryRequest, 'filter' | 'sort' | 'sort_mode' | 'search'> = {};
  const { allow_viewer_filter_sort: sorting, allow_search: searching } = meta.settings;
  if (sorting && choices.filter !== null) query.filter = { ...choices.filter };
  if (sorting && !sameSort(choices.sort, initialChoices(meta).sort)) {
    query.sort = choices.sort.map((key) => ({ ...key }));
    query.sort_mode = 'replace';
  }
  const search = choices.search.trim();
  if (searching && search !== '') query.search = search;
  return query;
}
