import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, problem, stubApi } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import { createTestI18n } from '../../../../test/i18n';
import { createQueryClient } from '../../../lib/query/client';
import { keys } from '../../../lib/query/keys';
import {
  recordFieldConverting,
  resetFieldConversions,
  type FieldConvertingMessage,
} from '../../../lib/realtime/field-conversions';
import { ColumnHeaderMenu } from '../components/ColumnHeaderMenu';
import { ConversionBanners } from '../conversion/ConversionBanners';

import type { FieldDto } from '@cellhive/contracts';

const NOW = '2026-09-26T00:00:00.000Z';
const ORG = 'org_Demo000000000001';
const ME = 'usr_0123456789ABCDEF';
const OTHER = 'usr_Other00000000001';
const JOB = 'job_0000000000000001' as const;

const running = {
  job_id: JOB,
  status: 'running' as const,
  from_type: 'text' as const,
  to_type: 'select' as const,
  revertible_until: '2099-10-03T14:05:00.000Z',
};

function field(conversion: FieldDto['conversion']): FieldDto {
  return {
    id: 'fld_Code000000000001',
    table_id: 'tbl_Customers0000001',
    name: 'Customer code',
    type: conversion?.status === 'succeeded' ? 'select' : 'text',
    options: {},
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 1,
    created_at: NOW,
    updated_at: NOW,
    conversion,
  };
}

function message(overrides: Partial<FieldConvertingMessage> = {}): FieldConvertingMessage {
  return {
    type: 'field.converting',
    channel: 'table:tbl_Customers0000001',
    field_id: 'fld_Code000000000001',
    job_id: JOB,
    status: 'running',
    progress: 0.64,
    from_type: 'text',
    to_type: 'select',
    actor_id: OTHER,
    ...overrides,
  };
}

async function renderBanners(fields: FieldDto[], canManage = true) {
  stubApi({
    signedIn: true,
    routes: {
      [`GET /orgs/${ORG}/members`]: () =>
        json({
          items: [
            {
              user: {
                id: OTHER,
                email: 'ha@example.test',
                display_name: 'Trần Thu Hà',
                avatar_url: null,
              },
              role: 'member',
              joined_at: NOW,
            },
          ],
          total: 1,
          offset: 0,
          limit: 1000,
        }),
      [`GET /jobs/${JOB}`]: () => problem('NOT_FOUND', 404),
    },
  });
  const onRevert = vi.fn();
  const onRetry = vi.fn();
  const i18n = await createTestI18n('en');
  const view = render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={createQueryClient()}>
        <ConversionBanners
          tableId="tbl_Customers0000001"
          fields={fields}
          userId={ME}
          orgId={ORG}
          canManage={canManage}
          onRevert={onRevert}
          onRetry={onRetry}
        />
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { onRevert, onRetry, view };
}

afterEach(() => {
  resetFieldConversions();
  window.localStorage.clear();
});

describe('conversion banners (T414, decision #8)', () => {
  it('shows the running conversion of another user with its progress', async () => {
    recordFieldConverting(message());
    await renderBanners([field(running)]);
    const banner = screen.getByTestId('conversion-banner');
    expect(banner).toHaveAttribute('data-state', 'running');
    expect(banner).toHaveTextContent('Converting Customer code from text to single select');
    expect(await within(banner).findByText(/by Trần Thu Hà/u)).toBeInTheDocument();
    expect(within(banner).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '64');
    expect(await axeViolations(banner)).toEqual([]);
  });

  it('then the result with “Undo (N days left)” for schema managers', async () => {
    recordFieldConverting(message());
    const { onRevert, view } = await renderBanners([field(running)]);
    act(() => {
      recordFieldConverting(message({ status: 'succeeded', progress: 1 }));
    });
    const i18n = await createTestI18n('en');
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={createQueryClient()}>
          <ConversionBanners
            tableId="tbl_Customers0000001"
            fields={[field({ ...running, status: 'succeeded' })]}
            userId={ME}
            orgId={ORG}
            canManage
            onRevert={onRevert}
            onRetry={vi.fn()}
          />
        </QueryClientProvider>
      </I18nextProvider>,
    );
    const banner = screen.getByTestId('conversion-banner');
    expect(banner).toHaveAttribute('data-state', 'succeeded');
    expect(banner).toHaveTextContent('Customer code was converted to single select.');
    const undo = within(banner).getByRole('button', { name: /^Undo \(.+ days left\)$/u });
    await userEvent.click(undo);
    expect(onRevert).toHaveBeenCalledWith('fld_Code000000000001');
    await userEvent.click(within(banner).getByRole('button', { name: 'Hide this message' }));
    expect(screen.queryByTestId('conversion-banner')).not.toBeInTheDocument();
  });

  it('a failed conversion says nothing was lost and offers to try again', async () => {
    recordFieldConverting(message({ status: 'failed', progress: 1 }));
    const { onRetry } = await renderBanners([field(null)]);
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent('Converting Customer code failed.');
    expect(banner).toHaveTextContent('No cell was lost.');
    await userEvent.click(within(banner).getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledWith('fld_Code000000000001');
  });

  it('after a reload: the done banner again while the undo is available (T421b)', async () => {
    // No message heard by this tab: only the field list says it was converted.
    const { onRevert } = await renderBanners([field({ ...running, status: 'succeeded' })]);
    const banner = screen.getByTestId('conversion-banner');
    expect(banner).toHaveAttribute('data-state', 'succeeded');
    expect(banner).toHaveTextContent('Customer code was converted to single select.');
    await userEvent.click(within(banner).getByRole('button', { name: /^Undo \(.+ days left\)$/u }));
    expect(onRevert).toHaveBeenCalledWith('fld_Code000000000001');
    expect(await axeViolations(banner)).toEqual([]);
  });

  it('closing it is remembered for this user (another reload keeps it closed)', async () => {
    const converted = field({ ...running, status: 'succeeded' });
    const { view } = await renderBanners([converted]);
    await userEvent.click(screen.getByRole('button', { name: 'Hide this message' }));
    expect(screen.queryByTestId('conversion-banner')).not.toBeInTheDocument();
    view.unmount();
    resetFieldConversions();
    await renderBanners([converted]);
    expect(screen.queryByTestId('conversion-banner')).not.toBeInTheDocument();
    // A later conversion of the same field shows again.
    cleanup();
    await renderBanners([
      field({ ...running, status: 'succeeded', job_id: 'job_0000000000000002' }),
    ]);
    expect(screen.getByTestId('conversion-banner')).toHaveAttribute('data-state', 'succeeded');
  });

  it('after a reload: nothing once the undo expired, nothing for readers', async () => {
    const { view } = await renderBanners([
      field({ ...running, status: 'succeeded', revertible_until: '2020-01-01T00:00:00.000Z' }),
    ]);
    expect(screen.queryByTestId('conversion-banner')).not.toBeInTheDocument();
    view.unmount();
    await renderBanners([field({ ...running, status: 'succeeded' })], false);
    expect(screen.queryByTestId('conversion-banner')).not.toBeInTheDocument();
  });

  it('a link conversion seen ending by its poll refetches the linked table’s fields (T415)', async () => {
    const LINKED = 'tbl_Orders0000000001';
    const link: FieldDto = {
      ...field({
        ...running,
        from_type: 'link',
        to_type: 'link',
        link_change: 'to_two_way',
      }),
      type: 'link',
      options: { link_table: LINKED },
    };
    stubApi({
      signedIn: true,
      routes: {
        [`GET /jobs/${JOB}`]: () =>
          json({
            id: JOB,
            type: 'field.convert',
            status: 'succeeded',
            progress: 1,
            result: {},
            error: null,
            created_at: NOW,
            started_at: NOW,
            finished_at: NOW,
          }),
      },
    });
    const queryClient = createQueryClient();
    queryClient.setQueryData(keys.fields(link.table_id), { items: [link] });
    queryClient.setQueryData(keys.fields(LINKED), { items: [] });
    const i18n = await createTestI18n('en');
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <ConversionBanners
            tableId={link.table_id}
            fields={[link]}
            userId={ME}
            orgId={ORG}
            canManage
            onRevert={vi.fn()}
            onRetry={vi.fn()}
          />
        </QueryClientProvider>
      </I18nextProvider>,
    );
    await waitFor(() => {
      expect(queryClient.getQueryState(keys.fields(LINKED))?.isInvalidated).toBe(true);
    });
  });

  it('readers get no undo', async () => {
    recordFieldConverting(message({ status: 'succeeded', progress: 1 }));
    await renderBanners([field({ ...running, status: 'succeeded' })], false);
    expect(screen.queryByRole('button', { name: /Undo/u })).not.toBeInTheDocument();
  });
});

describe('column menu while converting (T414)', () => {
  it('disables schema actions and sorting, offers the progress', async () => {
    const i18n = await createTestI18n('en');
    const onAction = vi.fn();
    render(
      <I18nextProvider i18n={i18n}>
        <ColumnHeaderMenu
          field={field(running)}
          anchor={{ x: 10, y: 10, width: 100, height: 36 }}
          canManageSchema
          converting
          onAction={onAction}
          onClose={vi.fn()}
        />
      </I18nextProvider>,
    );
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /Edit field/u })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(within(menu).getByRole('menuitem', { name: /Edit field/u })).toHaveTextContent(
      'Converting, try again when done',
    );
    expect(within(menu).getByRole('menuitem', { name: 'Sort ascending' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(within(menu).getByRole('menuitem', { name: 'Hide field' })).not.toHaveAttribute(
      'aria-disabled',
    );
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Show progress' }));
    expect(onAction).toHaveBeenCalledWith('progress');
  });

  it('offers the undo while the conversion can be reverted', async () => {
    const i18n = await createTestI18n('en');
    const onAction = vi.fn();
    render(
      <I18nextProvider i18n={i18n}>
        <ColumnHeaderMenu
          field={field({ ...running, status: 'succeeded' })}
          anchor={{ x: 10, y: 10, width: 100, height: 36 }}
          canManageSchema
          revertDays={6}
          onAction={onAction}
          onClose={vi.fn()}
        />
      </I18nextProvider>,
    );
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Undo type change (6 days left)' }),
    );
    expect(onAction).toHaveBeenCalledWith('revert');
  });
});
