import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultView } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import { createTestI18n } from '../../../../test/i18n';
import { ApiError } from '../../../lib/api/client';
import { createQueryClient } from '../../../lib/query/client';
import { keys } from '../../../lib/query/keys';
import { clearToasts, useToasts } from '../../../lib/toast/toast';
import { viewSessions } from '../../../lib/views/session';
import { ExportMenu } from '../components/ExportMenu';

import type { startFileDownload } from '../download';
import type { ViewDto } from '@cellhive/contracts';

const BASE = 'bse_Sales00000000001';
const TABLE = 'tbl_Orders0000000001';
const VIEW = defaultView(TABLE, {
  id: 'viw_Sales00000000001',
  name: 'Đơn của tôi',
}) as unknown as ViewDto;

function base(download: boolean) {
  return {
    id: BASE,
    name: 'Sales',
    permission_version: 1,
    access: {
      role: null,
      is_admin: false,
      base_rule: { copy: false, download, share_link: false },
      tables: {},
      dashboards: {},
    },
  };
}

function Toasts() {
  const toasts = useToasts();
  return (
    <ul aria-label="toasts">
      {toasts.map((toast) => (
        <li key={toast.id}>{toast.message}</li>
      ))}
    </ul>
  );
}

async function renderMenu(download: boolean, view: ViewDto = VIEW) {
  const i18n = await createTestI18n('en');
  const queryClient = createQueryClient();
  queryClient.setQueryData(keys.base(BASE), base(download));
  const startDownload = vi.fn<typeof startFileDownload>(() => () => undefined);
  const utils = render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <ExportMenu baseId={BASE} view={view} startDownload={startDownload} />
        <Toasts />
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { ...utils, startDownload };
}

afterEach(() => {
  clearToasts();
  viewSessions.discard(VIEW.id);
});

describe('ExportMenu', () => {
  it('downloads the saved view as CSV or XLSX through the export URL', async () => {
    const user = userEvent.setup();
    const { startDownload, container } = await renderMenu(true);
    await user.click(screen.getByRole('button', { name: 'Export' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByText('Export view Đơn của tôi')).toBeInTheDocument();
    expect(screen.getByText(/with its saved filter, sort and hidden fields/u)).toBeInTheDocument();
    // Values are formatted for the account: said in the menu and as the formats' tooltip.
    const note = screen.getByTestId('export-locale-note');
    expect(note).toHaveTextContent(/Numbers and dates are written as your account shows them/u);
    expect(screen.getByRole('menuitem', { name: 'CSV (.csv)' })).toHaveAttribute(
      'title',
      note.textContent,
    );
    expect(await axeViolations(container.ownerDocument.body)).toEqual([]);
    await user.click(screen.getByRole('menuitem', { name: 'Excel (.xlsx)' }));
    expect(startDownload).toHaveBeenCalledWith(
      `/api/v1/tables/${TABLE}/export?view_id=${VIEW.id}&format=xlsx`,
      expect.objectContaining({ title: 'Export download' }),
    );
    expect(
      screen.getByText('Exporting Đơn của tôi as Excel (.xlsx). The download starts in a moment.'),
    ).toBeInTheDocument();
    // One export at a time: the button waits a moment before the next one.
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
  });

  it('turns a refusal of the server into a toast', async () => {
    const user = userEvent.setup();
    const { startDownload } = await renderMenu(true);
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(screen.getByRole('menuitem', { name: 'CSV (.csv)' }));
    const [, options] = startDownload.mock.calls[0] ?? [];
    options?.onError(new ApiError({ status: 429, code: 'RATE_LIMITED' }));
    expect(
      await screen.findByText(
        'Another export of yours is still running. Try again when it has finished.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/The download starts in a moment/u)).toBeNull();
  });

  it('says that unsaved changes are not exported', async () => {
    viewSessions.setTemporary(VIEW.id, { hidden_fields: ['fld_Cost000000000001'] });
    const user = userEvent.setup();
    await renderMenu(true);
    await user.click(screen.getByRole('button', { name: 'Export' }));
    expect(screen.getByText(/This view has unsaved changes/u)).toBeInTheDocument();
  });

  it('is disabled with the reason without base_rule.download (P18)', async () => {
    const user = userEvent.setup();
    const { startDownload, container } = await renderMenu(false);
    const button = screen.getByRole('button', { name: 'Export' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAccessibleDescription(
      'Your role does not allow downloading data from this base.',
    );
    await user.click(button);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(startDownload).not.toHaveBeenCalled();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('has no export on form views', async () => {
    await renderMenu(true, { ...VIEW, type: 'form' });
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
  });
});
