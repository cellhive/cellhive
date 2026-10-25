import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';

import { createTestI18n } from '../../../../test/i18n';
import { AttachmentChange, attachmentDiff } from '../components/AttachmentChange';

/** History values hold `{ id, name, size, mime }` (CONTRACTS §20). */
const file = (id: string, name: string) => ({
  id: `att_${id.padEnd(16, '0')}`,
  name,
  size: 10,
  mime: 'application/pdf',
});
const FRONT = file('Front', 'mat-truoc.jpg');
const SIDE = file('Side', 'canh-ben.jpg');
const GUIDE = file('Guide', 'huong-dan.pdf');

describe('attachment changes in the history (T418)', () => {
  it('lists files added and removed, or a new order', () => {
    const diff = attachmentDiff([FRONT, SIDE], [SIDE, GUIDE]);
    expect(diff.added.map((item) => item.name)).toEqual(['huong-dan.pdf']);
    expect(diff.removed.map((item) => item.name)).toEqual(['mat-truoc.jpg']);
    expect(diff.reordered).toBe(false);
    expect(attachmentDiff([FRONT, SIDE], [SIDE, FRONT]).reordered).toBe(true);
    expect(attachmentDiff(null, [FRONT]).added.map((item) => item.id)).toEqual([FRONT.id]);
  });

  it('strikes removed files through and names both kinds for screen readers', async () => {
    const i18n = await createTestI18n('vi');
    render(
      <I18nextProvider i18n={i18n}>
        <AttachmentChange from={[FRONT]} to={[GUIDE]} />
      </I18nextProvider>,
    );
    const change = screen.getByTestId('history-attachments');
    expect(change).toHaveTextContent('đã thêmhuong-dan.pdf');
    expect(change).toHaveTextContent('đã gỡmat-truoc.jpg');
    expect(change.querySelector('s')).toHaveTextContent('mat-truoc.jpg');
  });
});
