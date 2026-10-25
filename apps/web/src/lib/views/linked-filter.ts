import { isId } from '@cellhive/contracts';
import { useEffect } from 'react';
import { useSearchParams } from 'react-router';

import { viewSessions } from './session';

import type { ViewDto } from '@cellhive/contracts';

/**
 * "View all" of an embedded sub-table (T416, BACKLOG S4 design decision
 * #4): the linked table opens filtered on the records linked to one record,
 * through the reverse link field of a two-way link. The link carries
 * `?linked=<fld reverse>.<rec>`; the view screen turns it into a temporary
 * filter of the view it opened (like a filter the user set: "unsaved", the
 * user may save or discard it) and drops the parameter.
 */
export const LINKED_PARAM = 'linked';

export interface LinkedFilterTarget {
  /** The link field of the opened table pointing back at the record. */
  readonly fieldId: string;
  readonly recordId: string;
}

/** `linked=<field>.<record>` for a URL. */
export function linkedSearchParam(target: LinkedFilterTarget): string {
  return `${LINKED_PARAM}=${encodeURIComponent(`${target.fieldId}.${target.recordId}`)}`;
}

/** The target of a `?linked=` value, or `null` when it is not well-formed. */
export function parseLinkedParam(value: string | null): LinkedFilterTarget | null {
  if (value === null) return null;
  const [fieldId, recordId, ...rest] = value.split('.');
  if (rest.length > 0 || !isId('fld', fieldId) || !isId('rec', recordId)) return null;
  return { fieldId, recordId };
}

/** Filter DSL (SPEC §6.2): the reverse link field has the record. */
export function linkedFilter(target: LinkedFilterTarget): Record<string, unknown> {
  return {
    op: 'and',
    items: [{ field: target.fieldId, operator: 'has_any_of', value: [target.recordId] }],
  };
}

/**
 * Applies `?linked=` to the view on screen as a temporary filter, then
 * removes it from the URL (Back does not apply it twice). A field the user
 * cannot read is dropped by the view config like any temporary change.
 */
export function useLinkedFilterParam(view: ViewDto | undefined): void {
  const [params, setParams] = useSearchParams();
  const raw = params.get(LINKED_PARAM);
  const viewId = view?.id;
  const type = view?.type;
  useEffect(() => {
    if (raw === null || viewId === undefined) return;
    const target = parseLinkedParam(raw);
    if (target !== null && (type === 'grid' || type === 'kanban')) {
      viewSessions.setTemporary(viewId, { filter: linkedFilter(target) });
    }
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete(LINKED_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [raw, viewId, type, setParams]);
}
