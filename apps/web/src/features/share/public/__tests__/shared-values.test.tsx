import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';

import { createTestI18n } from '../../../../../test/i18n';
import { themeTokens } from '../../../../../test/tokens';
import { renderCell } from '../../../../grid/cellRenderers/index';
import { CellValue } from '../../../../grid/display/CellValue';
import { tokensToAppearance } from '../../../../grid/theme';
import { linkRefsOf } from '../../../../lib/links/values';
import { sharedGridField, toFieldDto } from '../fields';

import type { CellRenderContext } from '../../../../grid/types';
import type { SharedFieldDto } from '@cellhive/contracts';

const LOCKED = { id: null, title: null };
const A = { id: 'rec_AAAAAAAAAAAAAAAA', title: 'An Phát' };

const linkField: SharedFieldDto = {
  id: 'fld_Customer00000001',
  name: 'Customer',
  type: 'link',
  // Through a link: display keys only (CONTRACTS §16A, T409).
  options: { allow_multiple: false },
  is_primary: false,
  description: null,
};

const ctx: CellRenderContext = {
  locale: { locale: 'en', timeZone: 'UTC' },
  palette: tokensToAppearance(themeTokens('light')).palette,
  labels: {
    formerMember: 'Former member',
    noAccess: 'No access',
    linkCount: (count) => `${String(count)} links`,
  },
};

/** T409: link chips on the share page. */
describe('share page link values (T409)', () => {
  const column = sharedGridField(toFieldDto(linkField, 'tbl_Orders0000000001', 1));

  it('keeps a linked record without id as a locked chip', () => {
    expect(linkRefsOf([A, LOCKED])).toEqual([A, { id: '', title: null }]);
    // Anything else without an id is still dropped.
    expect(linkRefsOf([{ id: null, title: 'x' }, { title: null }])).toEqual([]);
  });

  it('draws shared link fields as read-only chips without the linked table', () => {
    expect(column.link).toMatchObject({ allow_multiple: false });
    expect(renderCell(column, [A, LOCKED], ctx)).toMatchObject({
      readonly: true,
      copyData: 'An Phát',
      data: { kind: 'ob-links', chips: [A, { id: '', title: null }] },
    });
    // Only locked records: the count, never an id.
    expect(renderCell(column, [LOCKED], ctx)).toMatchObject({ copyData: '1 links' });
  });

  it('shows a locked record in details without its id', async () => {
    const i18n = await createTestI18n('en');
    render(
      <I18nextProvider i18n={i18n}>
        <CellValue field={column} value={[A, LOCKED]} locale={ctx.locale} />
      </I18nextProvider>,
    );
    expect(screen.getByText('An Phát')).toBeVisible();
    expect(screen.getByText('No access')).toBeVisible();
  });
});
