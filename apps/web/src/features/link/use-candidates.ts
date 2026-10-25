import { type LinkCandidatesResponse, type FieldDto } from '@cellhive/contracts';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { cellClipboardText } from '../../grid/clipboard';
import { toGridField, type GridField } from '../../grid/types';
import { linkCandidatesQuery } from '../../lib/links/candidates';
import { fieldsQuery } from '../../lib/query/queries';

import type { LocaleContext } from '@cellhive/field-types';

/** Search waits this long after the last key (FRONTEND §3.3 style debounce). */
export const SEARCH_DEBOUNCE_MS = 250;

/** A value that follows `value` once it stopped changing for `delay` ms. */
export function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSettled(value);
    }, delay);
    return () => {
      window.clearTimeout(timer);
    };
  }, [value, delay]);
  return settled;
}

export interface CandidatesRequest {
  readonly fieldId: string;
  readonly linkTable: string;
  /** The edited record: marks `linked` and fills `cell`. */
  readonly recordId: string | null;
  readonly search: string;
  /** Only these records ("selected only", "recent"); `null` = every candidate. */
  readonly ids: readonly string[] | null;
  readonly enabled?: boolean;
}

/** One candidate as the picker lists it. */
export type Candidate = LinkCandidatesResponse['items'][number];

/**
 * Pages of `POST /fields/:id/link-candidates` (CONTRACTS §2, T402): 50 at
 * a time, the next page when the list scrolls near its end (FRONTEND §11.1:
 * never every record). Keyed under the linked table, so its changes
 * (realtime `schema.changed`, a record created here) refresh them.
 */
export function useLinkCandidates(request: CandidatesRequest) {
  const { fieldId, linkTable, recordId, search, ids } = request;
  const trimmed = search.trim();
  const body = useMemo(
    () => ({
      search: trimmed === '' ? null : trimmed,
      record_id: recordId,
      ids: ids === null ? null : [...ids],
    }),
    [trimmed, recordId, ids],
  );
  const query = useInfiniteQuery({
    ...linkCandidatesQuery(fieldId, linkTable, body),
    enabled: (request.enabled ?? true) && (ids === null || ids.length > 0),
  });
  const items = useMemo(() => {
    const seen = new Set<string>();
    const all: Candidate[] = [];
    for (const page of query.data?.pages ?? []) {
      for (const item of page.items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        all.push(item);
      }
    }
    return all;
  }, [query.data]);
  const first = query.data?.pages[0];
  // No ids asked ("Selected 0"): nothing to load, an empty answer (T421a: not a skeleton forever).
  const none = ids !== null && ids.length === 0;
  return {
    items: none ? [] : items,
    displayFields: first?.fields ?? [],
    cell: first?.cell ?? null,
    status: none ? ('success' as const) : query.status,
    error: query.error,
    fetching: none ? false : query.isFetching,
    hasMore: none ? false : query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    },
    retry: () => {
      void query.refetch();
    },
  };
}

/** One display value of a candidate, formatted like the cell shows it. */
export interface DisplayValue {
  readonly fieldId: string;
  readonly name: string;
  readonly text: string;
  /** A code (auto number, barcode): drawn in the mono font. */
  readonly code: boolean;
}

/**
 * Fields of the linked table (the user reads it, else the picker is not
 * offered): display values are formatted with their options, the primary
 * field and required fields drive "Create a record".
 */
export function useLinkedFields(linkTable: string) {
  return useQuery({ ...fieldsQuery(linkTable), staleTime: 60_000 });
}

/** Formats the display values of a candidate (up to 3, CONTRACTS §2) for its second line. */
export function displayValues(
  candidate: Candidate,
  displayFields: readonly { id: string; name: string; type: string }[],
  fields: readonly FieldDto[] | undefined,
  locale: LocaleContext,
): DisplayValue[] {
  const byId = new Map<string, GridField>(
    (fields ?? []).map((field) => [field.id, toGridField(field)]),
  );
  return displayFields.flatMap((display) => {
    const value = candidate.fields[display.id];
    if (value === null || value === undefined) return [];
    const field = byId.get(display.id);
    const text =
      field === undefined
        ? typeof value === 'string' || typeof value === 'number'
          ? String(value)
          : ''
        : cellClipboardText(field, value, locale);
    if (text === '') return [];
    const code =
      display.type === 'auto_number' ||
      (field?.config?.type === 'text' && field.config.options.style.type === 'barcode');
    return [{ fieldId: display.id, name: display.name, text, code }];
  });
}
