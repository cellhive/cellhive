import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';

import { createTestI18n } from '../../../../test/i18n';
import { LinkChange, linkDiff } from '../components/LinkChange';

/** History values of a link hold `{ id, title }`, `deleted: true` since T465 (CONTRACTS §11.1). */
const ref = (id: string, title: string | null, deleted = false) => ({
  id: `rec_${id.padEnd(16, '0')}`,
  title,
  ...(deleted ? { deleted: true } : {}),
});
const AN = ref('An', 'An Phát');
const BINH = ref('Binh', 'Bình Minh');
const LOCKED = ref('Locked', null);
const GONE = ref('Gone', null, true);

describe('link changes in the history (T465)', () => {
  it('lists records linked and unlinked, or a new order', () => {
    const diff = linkDiff([AN, LOCKED], [LOCKED, BINH]);
    expect(diff.added.map((item) => item.title)).toEqual(['Bình Minh']);
    expect(diff.removed.map((item) => item.id)).toEqual([AN.id]);
    expect(diff.reordered).toBe(false);
    expect(linkDiff([AN, BINH], [BINH, AN]).reordered).toBe(true);
    expect(linkDiff(null, [AN]).added.map((item) => item.id)).toEqual([AN.id]);
    expect(linkDiff([GONE], null).removed).toEqual([{ id: GONE.id, title: null, deleted: true }]);
  });

  it('shows titles, a lock for unreadable records and "deleted" for records deleted since', async () => {
    const i18n = await createTestI18n('vi');
    render(
      <I18nextProvider i18n={i18n}>
        <LinkChange from={[AN, GONE]} to={[BINH, LOCKED]} />
      </I18nextProvider>,
    );
    const change = screen.getByTestId('history-links');
    expect(change).toHaveTextContent('đã liên kếtBình Minh');
    expect(change).toHaveTextContent('đã liên kếtKhông có quyền xem');
    expect(change).toHaveTextContent('đã gỡ liên kếtAn Phát');
    expect(change).toHaveTextContent('đã gỡ liên kếtBản ghi đã xoá');
    const struck = [...change.querySelectorAll('s')].map((node) => node.textContent);
    expect(struck).toEqual(['An Phát', 'Bản ghi đã xoá']);
  });

  it('says when only the order changed', async () => {
    const i18n = await createTestI18n('en');
    render(
      <I18nextProvider i18n={i18n}>
        <LinkChange from={[AN, BINH]} to={[BINH, AN]} />
      </I18nextProvider>,
    );
    expect(screen.getByText('Linked records reordered')).toBeInTheDocument();
  });
});
