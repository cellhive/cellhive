import { DropdownMenuItem } from '@cellhive/ui';
import { render, screen, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';

import { createTestI18n } from '../../../../test/i18n';
import { TreeRowMenu } from '../tree/TreeRowMenu';

describe('TreeRowMenu (T417) with the follow item (T553)', () => {
  it('shows "Follow record" right after "Open"', async () => {
    const i18n = await createTestI18n('en');
    render(
      <I18nextProvider i18n={i18n}>
        <TreeRowMenu
          title="Order 1"
          anchor={{ x: 0, y: 0, width: 10, height: 10 }}
          canAddChild={false}
          canAddSibling={false}
          canMove={false}
          canOutdent={false}
          canIndent={false}
          canDelete={false}
          onAction={() => undefined}
          onClose={() => undefined}
          followItem={<DropdownMenuItem>Follow record</DropdownMenuItem>}
        />
      </I18nextProvider>,
    );
    const menu = await screen.findByTestId('tree-row-menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Open recordSpace', 'Follow record', 'View cell history']);
  });
});
