import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../../lib/api/client';
import { fieldsQuery } from '../../../../lib/query/queries';
import { isStaleSummaryField, useGridSummaries } from '../use-grid-summaries';

import type { ViewConfigState } from '../../../../lib/views/use-view-config';
import type {
  FieldDto,
  RecordSummariesRequest,
  RecordSummariesResponse,
} from '@cellhive/contracts';
import type { ReactNode } from 'react';

const summaries = vi.fn<(tableId: string, body: RecordSummariesRequest) => Promise<unknown>>();
const listFields = vi.fn<(tableId: string) => Promise<unknown>>();
vi.mock('../../../../lib/api', () => ({
  api: {
    records: {
      summaries: (tableId: string, body: RecordSummariesRequest) => summaries(tableId, body),
    },
    fields: { list: (tableId: string) => listFields(tableId) },
  },
}));

const TABLE = 'tbl_T501Summaries000';
const PHONE = 'fld_T501Phone0000000';
const AMOUNT = 'fld_T501Amount000000';

const field = (id: string, type: string, extra: Partial<FieldDto> = {}): FieldDto =>
  ({
    id,
    table_id: TABLE,
    name: id,
    type,
    options: {},
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...extra,
  }) as FieldDto;

const fieldsWith = (phoneLocked: boolean) => ({
  items: [
    field(PHONE, 'lookup', { locked: phoneLocked, result_type: { kind: 'text', list: true } }),
    field(AMOUNT, 'number'),
  ],
});

const ok: RecordSummariesResponse = {
  count: 3,
  summaries: { [AMOUNT]: { fn: 'sum', value: 60 } },
  group: [],
  groups: [],
  truncated: false,
};

const unknownPhone = () =>
  new ApiError({
    status: 422,
    code: 'VALIDATION_FAILED',
    errors: [{ path: `summaries.${PHONE}`, code: 'UNKNOWN_FIELD', message: 'Unknown field' }],
  });

/** A temporary summary on both fields (saved: none), so the request names them. */
const state = {
  config: { summaries: { [PHONE]: 'filled', [AMOUNT]: 'sum' } },
  saved: { summaries: {} },
  unsaved: ['summaries'],
  saving: false,
  canSave: true,
  change: () => undefined,
  save: () => Promise.resolve(true),
  discard: () => undefined,
} as unknown as ViewConfigState;

function renderSummaries() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const errors: unknown[] = [];
  const rendered = renderHook(
    () => {
      const fields = useQuery(fieldsQuery(TABLE)).data as { items: FieldDto[] } | undefined;
      const bar = useGridSummaries({
        tableId: TABLE,
        state,
        query: { view_id: 'viw_T501View00000000' },
        permissionVersion: 1,
        fields: fields?.items ?? [],
        locale: { locale: 'en', timeZone: 'UTC' },
        enabled: fields !== undefined,
      });
      if (bar.error !== null) errors.push(bar.error);
      return bar;
    },
    { wrapper },
  );
  return { ...rendered, errors };
}

beforeEach(() => {
  summaries.mockReset();
  listFields.mockReset();
});

describe('isStaleSummaryField', () => {
  it('is a 422 UNKNOWN_FIELD on summaries.* only', () => {
    expect(isStaleSummaryField(unknownPhone())).toBe(true);
    expect(
      isStaleSummaryField(
        new ApiError({
          status: 422,
          code: 'INVALID_FILTER',
          errors: [{ path: 'filter.items[0].field', code: 'UNKNOWN_FIELD', message: 'x' }],
        }),
      ),
    ).toBe(false);
    expect(isStaleSummaryField(new ApiError({ status: 504, code: 'QUERY_TIMEOUT' }))).toBe(false);
    expect(isStaleSummaryField(new Error('network'))).toBe(false);
  });
});

describe('useGridSummaries: a field locked after the schema loaded (T501)', () => {
  it('reloads the fields and asks again without the field, never showing the error', async () => {
    listFields.mockResolvedValueOnce(fieldsWith(false)).mockResolvedValueOnce(fieldsWith(true));
    summaries.mockRejectedValueOnce(unknownPhone()).mockResolvedValueOnce(ok);

    const { result, errors } = renderSummaries();
    await waitFor(() => {
      expect(result.current.result).toEqual(ok);
    });
    expect(listFields).toHaveBeenCalledTimes(2);
    expect(summaries.mock.calls.map(([, body]) => body.summaries)).toEqual([
      { [PHONE]: 'filled', [AMOUNT]: 'sum' },
      { [AMOUNT]: 'sum' },
    ]);
    expect(result.current.config).toEqual({ [AMOUNT]: 'sum' });
    expect(errors).toEqual([]);
  });

  it('sends the same request again once when the fields did not change', async () => {
    listFields.mockResolvedValue(fieldsWith(false));
    summaries.mockRejectedValueOnce(unknownPhone()).mockResolvedValueOnce(ok);

    const { result, errors } = renderSummaries();
    await waitFor(() => {
      expect(result.current.result).toEqual(ok);
    });
    expect(summaries).toHaveBeenCalledTimes(2);
    expect(summaries.mock.calls[1]?.[1]).toEqual(summaries.mock.calls[0]?.[1]);
    expect(errors).toEqual([]);
  });

  it('shows the error when the second answer fails too, without a loop', async () => {
    listFields.mockResolvedValue(fieldsWith(false));
    summaries.mockRejectedValue(unknownPhone());

    const { result } = renderSummaries();
    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(ApiError);
    });
    expect(result.current.busy).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(summaries).toHaveBeenCalledTimes(2);
    expect(listFields).toHaveBeenCalledTimes(2);
  });
});
