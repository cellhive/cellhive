import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { api } from '../../lib/api';

import type { ComputedPreview, FieldDto, RecordDto } from '@cellhive/contracts';

/**
 * Server preview of a formula reading links or other tables (T466,
 * CONTRACTS §13 `POST /tables/:id/computed-preview`): 300 ms after the last
 * change, the request still running is aborted when a newer one starts.
 * The last answer stays (dimmed by the caller) while the next one loads.
 */
export const PREVIEW_DEBOUNCE_MS = 300;

export interface ServerPreviewRequest {
  readonly tableId: string;
  readonly fieldId: FieldDto['id'] | undefined;
  readonly expression: string;
  readonly style: Readonly<Record<string, unknown>> | null | undefined;
  readonly recordIds: readonly RecordDto['id'][] | undefined;
}

export interface ServerPreviewState {
  readonly data: ComputedPreview | undefined;
  /** The expression `data`/`error` answer. */
  readonly expression: string | undefined;
  readonly loading: boolean;
  readonly error: unknown;
  readonly retry: () => void;
}

/** `request` null: nothing to ask (same-row formula, errors, empty text). */
export function useServerPreview(request: ServerPreviewRequest | null): ServerPreviewState {
  const [state, setState] = useState<{
    data: ComputedPreview | undefined;
    expression: string | undefined;
    loading: boolean;
    error: unknown;
  }>({ data: undefined, expression: undefined, loading: false, error: null });
  const [attempt, setAttempt] = useState(0);
  const key = request === null ? null : JSON.stringify(request);
  const latest = useRef(request);
  useLayoutEffect(() => {
    latest.current = request;
  });

  useEffect(() => {
    const current = latest.current;
    if (key === null || current === null) {
      setState((previous) => (previous.loading ? { ...previous, loading: false } : previous));
      return;
    }
    setState((previous) => ({ ...previous, loading: true }));
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api.fields
        .computedPreview(
          current.tableId,
          {
            type: 'formula',
            options: {
              expression: current.expression,
              ...(current.style === undefined ? {} : { style: current.style }),
            },
            ...(current.fieldId === undefined ? {} : { field_id: current.fieldId }),
            ...(current.recordIds === undefined || current.recordIds.length === 0
              ? {}
              : { record_ids: [...current.recordIds] }),
          },
          controller.signal,
        )
        .then((data) => {
          setState({ data, expression: current.expression, loading: false, error: null });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setState((previous) => ({
            data: previous.data,
            expression: current.expression,
            loading: false,
            error,
          }));
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [key, attempt]);

  return {
    ...state,
    retry: () => {
      setAttempt((value) => value + 1);
    },
  };
}
