import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, problem, stubApi } from '../../../test/app-harness';
import { axeViolations } from '../../../test/axe';
import { createTestI18n } from '../../../test/i18n';
import {
  ConditionBranchBuilder,
  COUNT_DEBOUNCE_MS,
} from '../../features/automation/builder/components/conditions/ConditionBranchBuilder';
import * as filterModel from '../../features/view/toolbar/filter-model';
import { ValueEditor } from '../../features/view/toolbar/ValueEditor';
import { createQueryClient } from '../../lib/query/client';
import { fieldsQuery } from '../../lib/query/queries';

import type {
  AutomationConditionEditorProps,
  ConditionEditorState,
  ConditionValueSourceProps,
} from '../../lib/automation/condition-editor';
import type { ConditionKit } from '../../lib/automation/condition-kit';
import type { FieldDto } from '@cellhive/contracts';

/*
 * T1012: the condition branch builder (Lucian UX/UI #132) as the route wires
 * it — the automation builder's component on the view filter builder's model
 * and value editors (`ConditionKit`, FRONTEND §1.2).
 */

const NOW = '2026-11-08T00:00:00.000Z';
const ORG = 'org_Demo000000000001';
const TABLE = 'tbl_Tickets000000001';
const STATUS = 'fld_Status0000000001';
const PRIORITY = 'fld_Priority00000001';
const NEW = 'opt_NewAAAAAAAAAAAAA';
const DONE = 'opt_DoneAAAAAAAAAAAA';
const HIGH = 'opt_HighAAAAAAAAAAAA';
const URGENT = 'opt_UrgentAAAAAAAAAA';
const QUERY = `POST /tables/${TABLE}/records/query`;

const kit: ConditionKit = { model: filterModel, ValueEditor };

function select(id: string, name: string, options: [string, string][], position: number) {
  return {
    id,
    table_id: TABLE,
    name,
    type: 'select',
    options: {
      multiple: false,
      options: options.map(([option, label], index) => ({ id: option, name: label, color: index })),
    },
    is_primary: position === 0,
    required: false,
    unique_values: false,
    description: null,
    position,
    created_at: NOW,
    updated_at: NOW,
  } as unknown as FieldDto;
}

const FIELDS = [
  select(
    STATUS,
    'Trạng thái',
    [
      [NEW, 'Mới'],
      [DONE, 'Xong'],
    ],
    0,
  ),
  select(
    PRIORITY,
    'Ưu tiên',
    [
      [HIGH, 'Cao'],
      [URGENT, 'Khẩn cấp'],
    ],
    1,
  ),
];

const isNew = { field: STATUS, operator: 'is', value: NEW };
const isUrgent = { field: PRIORITY, operator: 'is', value: URGENT };
const isHigh = { field: PRIORITY, operator: 'is', value: HIGH };
const changedToUrgent = { field: PRIORITY, operator: 'changed_to', value: URGENT };

/** Counts by the root `op` of the filter sent (and = 3, or = 12, nested = 5). */
function countOf(body: Record<string, unknown>): number {
  const filter = body['filter'] as { op?: string; items?: unknown[] } | undefined;
  if (filter?.items?.some((item) => (item as { op?: string }).op !== undefined)) return 5;
  return filter?.op === 'or' ? 12 : 3;
}

function serve(answer?: (body: Record<string, unknown>) => Response) {
  return stubApi({
    signedIn: true,
    routes: {
      [QUERY]: (init) => {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        return answer?.(body) ?? json({ records: [], offset: 0, limit: 1, total: countOf(body) });
      },
    },
  });
}

function queryBodies(fetchMock: ReturnType<typeof stubApi>): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(
      ([input, init]) =>
        init?.method === 'POST' && input.includes(`/tables/${TABLE}/records/query`),
    )
    .map(([, init]) => JSON.parse(init?.body as string) as Record<string, unknown>);
}

async function renderBuilder(
  props: Partial<AutomationConditionEditorProps> = {},
  lang: 'en' | 'vi' = 'en',
) {
  const i18n = await createTestI18n(lang);
  const queryClient = createQueryClient();
  queryClient.setQueryData(fieldsQuery(TABLE).queryKey, {
    items: FIELDS,
    total: FIELDS.length,
    offset: 0,
    limit: 1000,
  });
  const onChange = vi.fn<(state: ConditionEditorState) => void>();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <ConditionBranchBuilder
          tableId={TABLE}
          orgId={ORG}
          value={null}
          onChange={onChange}
          label="Run only if"
          emptyText="No condition: the automation always runs."
          kit={kit}
          {...props}
        />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { ...view, onChange };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ConditionBranchBuilder (T1012, Lucian #132)', () => {
  it('draws the bar, the All / Any pill between the first two rules and the joints after', async () => {
    serve();
    const { container } = await renderBuilder({
      value: { op: 'and', items: [isNew, isUrgent, isHigh] },
    });
    const root = await screen.findByTestId('filter-root');
    expect(root).toHaveAttribute('role', 'group');
    expect(root).toHaveAccessibleName('Run only if');
    expect(container.querySelector('.ux.u132 .logic')).not.toBeNull();
    const pill = within(root).getByRole('group', { name: 'Conditions to match' });
    expect(within(pill).getByRole('button', { name: 'All' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(pill).getByRole('button', { name: 'Any' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    // The pill sits with the second rule; the third one starts with "and".
    const items = root.querySelectorAll(':scope > .logic > .rules > li');
    expect(items).toHaveLength(3);
    expect(items[0]?.querySelector('[data-mode]')).toBeNull();
    expect(items[1]?.querySelector('[data-mode]')).toBe(pill);
    expect(items[2]?.querySelector('.joint')).toHaveTextContent('and');
    // Field, operator and × on one line (the 440 px panel, T527), the value under them.
    const rule = within(root).getAllByTestId('filter-condition')[0];
    const line = rule?.querySelector('.rule-line');
    expect(line?.querySelector('.remove')).toHaveAccessibleName('Remove condition on Trạng thái');
    expect(line?.querySelector('.rule-value select')).toHaveAccessibleName('Value for Trạng thái');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('Any turns the group into an or: the change, the joints and the count follow', async () => {
    const fetchMock = serve();
    const { onChange } = await renderBuilder({
      value: { op: 'and', items: [isNew, isUrgent, isHigh] },
    });
    const count = await screen.findByTestId('condition-match-count');
    await waitFor(() => {
      expect(count).toHaveAttribute('data-count', '3');
    });
    expect(count).toHaveTextContent('3records match now');
    expect(count).toHaveTextContent('Based on your access, on current data');
    expect(queryBodies(fetchMock)[0]).toMatchObject({ limit: 1, fields: [] });

    await userEvent.click(screen.getByRole('button', { name: 'Any' }));
    expect(screen.getByRole('button', { name: 'Any' })).toHaveAttribute('aria-pressed', 'true');
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        valid: true,
        filter: expect.objectContaining({ op: 'or' }) as unknown,
      }),
    );
    expect(document.querySelector('.joint')).toHaveTextContent('or');
    await waitFor(
      () => {
        expect(count).toHaveAttribute('data-count', '12');
      },
      { timeout: COUNT_DEBOUNCE_MS + 2_000 },
    );
    expect(queryBodies(fetchMock).at(-1)).toMatchObject({ filter: { op: 'or' } });
  });

  it('waits 400 ms after the last change before counting again', async () => {
    const fetchMock = serve();
    await renderBuilder({ value: { op: 'and', items: [isNew, isUrgent] } });
    await waitFor(() => {
      expect(screen.getByTestId('condition-match-count')).toHaveAttribute('data-count', '3');
    });
    const before = queryBodies(fetchMock).length;
    await userEvent.click(screen.getByRole('button', { name: 'Any' }));
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    await userEvent.click(screen.getByRole('button', { name: 'Any' }));
    expect(screen.getByTestId('condition-match-count')).toHaveAttribute('aria-busy', 'true');
    expect(queryBodies(fetchMock)).toHaveLength(before);
    await waitFor(
      () => {
        expect(screen.getByTestId('condition-match-count')).toHaveAttribute('data-count', '12');
      },
      { timeout: COUNT_DEBOUNCE_MS + 2_000 },
    );
    // One request for the three clicks.
    expect(queryBodies(fetchMock)).toHaveLength(before + 1);
  });

  it('counts without the changed* part; a changed_to alone shows no count', async () => {
    const fetchMock = serve();
    const first = await renderBuilder({
      changeOperators: true,
      value: { op: 'and', items: [changedToUrgent, isNew] },
    });
    await waitFor(() => {
      expect(screen.getByTestId('condition-match-count')).toHaveAttribute('data-count', '3');
    });
    expect(queryBodies(fetchMock)).toEqual([
      expect.objectContaining({ filter: { op: 'and', items: [isNew] } }),
    ]);
    first.unmount();

    const next = serve();
    await renderBuilder({ changeOperators: true, value: { op: 'and', items: [changedToUrgent] } });
    expect(await screen.findByLabelText('Operator for Ưu tiên')).toHaveValue('changed_to');
    await new Promise((resolve) => setTimeout(resolve, COUNT_DEBOUNCE_MS + 100));
    expect(screen.queryByTestId('condition-match-count')).toBeNull();
    expect(queryBodies(next)).toEqual([]);
  });

  it('shows no count without a condition, for update_records, or when the count fails', async () => {
    const fetchMock = serve();
    const empty = await renderBuilder();
    expect(await screen.findByText('No condition: the automation always runs.')).toBeVisible();
    expect(screen.queryByTestId('condition-match-count')).toBeNull();
    empty.unmount();

    // update_records says how many match in its own panel (values from the automation).
    const Source = (() => null) as (props: ConditionValueSourceProps) => null;
    const bulk = await renderBuilder({ ValueSource: Source, value: { op: 'and', items: [isNew] } });
    await screen.findByLabelText('Operator for Trạng thái');
    expect(screen.queryByTestId('condition-match-count')).toBeNull();
    bulk.unmount();
    expect(queryBodies(fetchMock)).toEqual([]);

    serve(() => problem('NOT_FOUND', 404));
    await renderBuilder({ value: { op: 'and', items: [isNew] } });
    await screen.findByLabelText('Operator for Trạng thái');
    await waitFor(() => {
      expect(screen.queryByTestId('condition-match-count')).toBeNull();
    });
  });

  it('says "about" for an estimated count, in Vietnamese with its own number format', async () => {
    serve(() => json({ records: [], offset: 0, limit: 1, total_estimate: 12_500 }));
    await renderBuilder({ value: { op: 'and', items: [isNew, isUrgent] } }, 'vi');
    const count = await screen.findByTestId('condition-match-count');
    await waitFor(() => {
      expect(count).toHaveAttribute('data-count', '12500');
    });
    expect(count).toHaveTextContent('Khoảng12.500bản ghi khớp lúc này');
    expect(count).toHaveTextContent('Theo quyền của bạn, trên dữ liệu hiện tại');
    expect(screen.getByRole('button', { name: 'Tất cả' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Bất kỳ' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('marks the rule of a 422 AUTOMATION_INVALID path', async () => {
    serve();
    await renderBuilder({
      value: { op: 'and', items: [isNew, isUrgent] },
      issues: [{ path: 'items[1].value', code: 'UNKNOWN_OPTION' }],
    });
    const rules = await screen.findAllByTestId('filter-condition');
    expect(rules[0]).not.toHaveAttribute('aria-invalid');
    expect(rules[1]).toHaveAttribute('aria-invalid', 'true');
    expect(rules[1]).toHaveTextContent('This option does not belong to the field.');
    expect(within(rules[1] as HTMLElement).getByLabelText('Field')).toHaveAccessibleDescription(
      'This option does not belong to the field.',
    );
  });

  it('nests groups as bars inside the bar (nested), one level otherwise', async () => {
    serve();
    const nested = await renderBuilder({
      nested: true,
      value: { op: 'and', items: [isNew, { op: 'or', items: [isHigh, isUrgent] }] },
    });
    const group = await screen.findByTestId('filter-group');
    expect(group).toHaveAttribute('data-depth', 'nested');
    expect(group).toHaveAccessibleName('Group of conditions');
    expect(group.closest('.logic')?.closest('[data-testid="filter-root"]')).not.toBeNull();
    const inner = within(group).getByRole('group', { name: 'Conditions to match' });
    expect(within(inner).getByRole('button', { name: 'Any' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await waitFor(() => {
      expect(screen.getByTestId('condition-match-count')).toHaveAttribute('data-count', '5');
    });
    await userEvent.click(
      within(screen.getByTestId('filter-root')).getAllByRole('button', {
        name: 'Add condition group',
      })[0] as HTMLElement,
    );
    expect(screen.getAllByTestId('filter-group')).toHaveLength(2);
    nested.unmount();

    await renderBuilder({ value: { op: 'and', items: [isNew] } });
    await screen.findByLabelText('Operator for Trạng thái');
    expect(screen.queryByRole('button', { name: 'Add condition group' })).toBeNull();
  });

  it('removing a rule moves the focus to its neighbour', async () => {
    serve();
    await renderBuilder({ value: { op: 'and', items: [isNew, isUrgent] } });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove condition on Trạng thái' }),
    );
    expect(screen.getAllByTestId('filter-condition')).toHaveLength(1);
    expect(screen.getByLabelText('Field')).toHaveFocus();
    // One rule left: no pill.
    expect(screen.queryByRole('group', { name: 'Conditions to match' })).toBeNull();
  });
});
