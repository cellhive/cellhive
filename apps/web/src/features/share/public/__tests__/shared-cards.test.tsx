import { sharedFormCoverUrl, type SharedFieldDto } from '@cellhive/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../../../../../test/axe';
import { createTestI18n } from '../../../../../test/i18n';
import { ShareApi } from '../api';
import { SharedCardList } from '../components/SharedCardList';
import { sharedGridField, toFieldDto } from '../fields';

import type { GridRecord } from '../../../../grid';
import type { ReactElement } from 'react';

const TABLE = 'tbl_Orders0000000001';
const shared = (field: Omit<SharedFieldDto, 'description'>, index: number) =>
  sharedGridField(toFieldDto({ ...field, description: null }, TABLE, index));

const COLUMNS = [
  shared(
    { id: 'fld_Title00000000001', name: 'Title', type: 'text', options: {}, is_primary: true },
    0,
  ),
  shared(
    {
      id: 'fld_Photos0000000001',
      name: 'Photos',
      type: 'attachment',
      options: {},
      is_primary: false,
    },
    1,
  ),
];

const RECORD: GridRecord = {
  id: 'rec_Order00000000001',
  version: 1,
  fields: {
    fld_Title00000000001: 'Order 1',
    fld_Photos0000000001: [
      {
        id: 'att_Photo00000000001',
        name: 'front.png',
        size: 2048,
        mime: 'image/png',
        url: '/api/v1/shares/t/files/att_Photo00000000001',
        thumbnail_url: null,
      },
    ],
  },
} as unknown as GridRecord;

async function renderWith(ui: ReactElement) {
  const i18n = await createTestI18n('en');
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

function list(props: Partial<Parameters<typeof SharedCardList>[0]>) {
  return (
    <SharedCardList
      fields={COLUMNS}
      rowCount={1}
      rowHeader={() => undefined}
      getRecord={() => RECORD}
      dataVersion={1}
      onViewportChange={() => undefined}
      locale={{ locale: 'en', timeZone: 'UTC' }}
      label="Records"
      allowCopy
      scrollResetKey=""
      {...props}
    />
  );
}

/** T419: files of a card open the viewer when the link hides the record detail. */
describe('shared cards: files without the record detail (T419)', () => {
  it('makes the files of a card a button that opens the viewer', async () => {
    const onViewFiles = vi.fn();
    await renderWith(list({ onViewFiles }));
    const button = screen.getByRole('button', { name: 'Photos: view 1 file' });
    await userEvent.click(button);
    expect(onViewFiles).toHaveBeenCalledWith(RECORD, 'fld_Photos0000000001');
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('keeps the whole card one button when it opens the record detail', async () => {
    const onOpen = vi.fn();
    await renderWith(list({ onOpen, onViewFiles: vi.fn() }));
    expect(screen.queryByTestId('share-card-files')).toBeNull();
    await userEvent.click(screen.getByRole('button'));
    expect(onOpen).toHaveBeenCalledWith(RECORD.id);
  });
});

/** T419: the page builds the cover route itself (no cover schemas in its first load). */
describe('share api: form cover route (T419)', () => {
  it('matches the contract', () => {
    const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ABCDE';
    expect(new ShareApi(token).formCoverUrl('att_Cover00000000001')).toBe(
      sharedFormCoverUrl(token, 'att_Cover00000000001'),
    );
  });
});
