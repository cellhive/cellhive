import { render } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { beforeAll, describe, expect, it } from 'vitest';

import { createTestI18n } from '../../../../../test/i18n';
import { CellValue } from '../../../../grid/display/CellValue';
import { sharedGridField, toFieldDto } from '../fields';

import type { i18n as I18n } from 'i18next';

let i18n: I18n;

beforeAll(async () => {
  i18n = await createTestI18n('en');
});

const textField = (style: 'phone' | 'email' | 'url') =>
  sharedGridField(
    toFieldDto(
      {
        id: 'fld_Phone00000000001',
        name: 'Phone',
        type: 'text',
        options: { style: { type: style } },
        is_primary: false,
        description: null,
      },
      'tbl_Customers0000001',
      1,
    ),
  );

function renderValue(style: 'phone' | 'email' | 'url', value: string, links?: boolean) {
  return render(
    <I18nextProvider i18n={i18n}>
      <CellValue
        field={textField(style)}
        value={value}
        locale={{ locale: 'en', timeZone: 'UTC' }}
        {...(links === undefined ? {} : { links })}
      />
    </I18nextProvider>,
  );
}

describe('cell values inside interactive rows (T421b: no nested links)', () => {
  it.each([
    ['phone', '020 4661 7418', 'tel:02046617418'],
    ['email', 'lan@example.vn', 'mailto:lan@example.vn'],
    ['url', 'cellhive.io', 'https://cellhive.io/'],
  ] as const)('%s: a link by default', (style, value, href) => {
    const { container } = renderValue(style, value);
    expect(container.querySelector('a')).toHaveAttribute('href', href);
    // T470: a 24 px tall target (WCAG 2.5.8) in the record panel too, not only in compact cells.
    expect(container.querySelector('a')).toHaveClass('inline-block', 'leading-6');
  });

  it.each([
    ['phone', '020 4661 7418'],
    ['email', 'lan@example.vn'],
    ['url', 'cellhive.io'],
  ] as const)('%s: plain text inside a button or a clickable card', (style, value) => {
    const { container } = renderValue(style, value, false);
    expect(container.querySelector('a')).toBeNull();
    expect(container).toHaveTextContent(value);
  });
});
