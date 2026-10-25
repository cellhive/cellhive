import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { createTestI18n } from '../../../../test/i18n';
import { computedColumnOf } from '../../../grid/display/computed';
import { ComputedErrorPopover } from '../computed/ComputedErrorPopover';
import { computedErrorDetails, retryOptionsOf } from '../computed/error-model';
import { filterFieldIds } from '../computed/RecomputeBanner';

import type { FieldDto } from '@cellhive/contracts';
import type { i18n as I18n } from 'i18next';

const NOW = '2026-09-28T00:00:00.000Z';

function field(id: string, extra: Partial<FieldDto> = {}): FieldDto {
  return {
    id: id as FieldDto['id'],
    table_id: 'tbl_Orders0000000001',
    name: id.slice(4, 10),
    type: 'formula',
    options: { expression: '[Amount] * [Rate]', style: null },
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 1,
    created_at: NOW,
    updated_at: NOW,
    result_type: { kind: 'number', list: false },
    compute_state: 'error',
    compute_error: null,
    ...extra,
  };
}

const RATE = 'fld_Rate000000000001';
const commission = field('fld_Commis0000000001', {
  name: 'Commission',
  compute_error: { code: 'REF', refs: [{ kind: 'field', id: RATE, name: 'Rate' }] },
});
const deletedRate: FieldDto = {
  ...field(RATE, { type: 'number', options: {}, name: 'Rate' }),
  deleted_at: '2026-09-28T09:12:00.000Z',
};

function detailsOf(target: FieldDto, live: FieldDto[], trash?: FieldDto[]) {
  const computed = computedColumnOf(target);
  if (computed === undefined) throw new Error('not computed');
  return computedErrorDetails(target, computed, live, trash);
}

describe('error details of a computed column (T468)', () => {
  it('REF on a field of this table in the trash: restorable, with the deletion time', () => {
    const details = detailsOf(commission, [commission], [commission, deletedRate]);
    expect(details).toMatchObject({
      token: '#REF!',
      variant: 'deleted',
      names: ['Rate'],
      deletedAt: '2026-09-28T09:12:00.000Z',
      restorable: [{ id: RATE, name: 'Rate' }],
    });
  });

  it('REF through a computed field in error: indirect, nothing to restore', () => {
    const inner = field(RATE, {
      name: 'Rate',
      compute_error: { code: 'CIRCLE', refs: [] },
    });
    expect(detailsOf(commission, [commission, inner])).toMatchObject({
      variant: 'indirect',
      restorable: [],
    });
  });

  it('REF on something the reader cannot see names nothing', () => {
    const hidden = field('fld_Hidden0000000001', {
      compute_error: { code: 'REF', refs: [{ kind: 'table', id: null, name: null }] },
    });
    expect(detailsOf(hidden, [hidden])).toMatchObject({ variant: 'hidden', names: [] });
  });

  it.each([
    ['CIRCLE', 'circle', '#CIRCLE!'],
    ['TIMEOUT', 'timeout', '#TIMEOUT!'],
    ['INVALID_CONFIG', 'configHidden', '#VALUE!'],
  ] as const)('%s → %s', (code, variant, token) => {
    const target = field('fld_Target0000000001', { compute_error: { code, refs: [] } });
    expect(detailsOf(target, [target])).toMatchObject({ variant, token });
  });

  it('retry sends the definition unchanged, only when the reader has it', () => {
    expect(retryOptionsOf(commission)).toEqual({ expression: '[Amount] * [Rate]' });
    expect(retryOptionsOf({ ...commission, options: { style: null } })).toBeNull();
    const lookup = field('fld_Lookup0000000001', {
      type: 'lookup',
      options: { from: 'tbl_X', select: 'fld_Y', where: { op: 'and', items: [] }, style: null },
    });
    expect(retryOptionsOf(lookup)).toEqual({
      from: 'tbl_X',
      select: 'fld_Y',
      where: { op: 'and', items: [] },
    });
    const timeout = field('fld_Timeout000000001', {
      compute_error: { code: 'TIMEOUT', refs: [] },
    });
    expect(detailsOf(timeout, [timeout])?.retry).toBe(true);
  });

  it('collects the fields a filter names at any depth', () => {
    const ids = filterFieldIds({
      op: 'and',
      items: [
        { field: 'fld_A', operator: 'eq', value: 1 },
        { op: 'not', item: { op: 'or', items: [{ field: 'fld_B', operator: 'is_empty' }] } },
      ],
    });
    expect([...ids]).toEqual(['fld_A', 'fld_B']);
  });
});

describe('ComputedErrorPopover', () => {
  let i18n: I18n;
  beforeAll(async () => {
    i18n = await createTestI18n('vi');
  });

  it('explains the error and offers restore / edit to schema managers', () => {
    const details = detailsOf(commission, [commission], [commission, deletedRate]);
    if (details === null) throw new Error('no details');
    const onRestore = vi.fn();
    const onEdit = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nextProvider i18n={i18n}>
          <ComputedErrorPopover
            fieldName="Commission"
            type="formula"
            details={details}
            anchor={{ x: 100, y: 100, width: 200, height: 36 }}
            canManage
            busy={null}
            onRestore={onRestore}
            onEdit={onEdit}
            onRetry={vi.fn()}
            onClose={vi.fn()}
          />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    const popover = screen.getByTestId('computed-error-popover');
    expect(popover).toHaveTextContent('#REF!');
    expect(popover).toHaveTextContent('Tham chiếu bị xoá');
    expect(popover).toHaveTextContent('Rate');
    fireEvent.click(screen.getByRole('button', { name: 'Khôi phục trường' }));
    expect(onRestore).toHaveBeenCalledWith(RATE);
    fireEvent.click(screen.getByRole('button', { name: 'Sửa công thức' }));
    expect(onEdit).toHaveBeenCalled();
  });

  it('readers without schema rights only read who can fix it', () => {
    const details = detailsOf(commission, [commission], undefined);
    if (details === null) throw new Error('no details');
    render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nextProvider i18n={i18n}>
          <ComputedErrorPopover
            fieldName="Commission"
            type="formula"
            details={details}
            anchor={{ x: 100, y: 100, width: 200, height: 36 }}
            canManage={false}
            busy={null}
            onRestore={vi.fn()}
            onEdit={vi.fn()}
            onRetry={vi.fn()}
            onClose={vi.fn()}
          />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Sửa công thức' })).toBeNull();
    expect(screen.getByTestId('computed-error-popover')).toHaveTextContent('Nhờ người quản lý');
  });
});
