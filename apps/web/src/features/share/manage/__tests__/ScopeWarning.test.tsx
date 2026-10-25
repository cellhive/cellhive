import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../../../../../test/axe';
import { createTestI18n } from '../../../../../test/i18n';
import { ScopeWarning } from '../components/ScopeWarning';

import type { ShareLinkPreview } from '@cellhive/contracts';

const NAME = 'fld_Name000000000001';
const CUSTOMER = 'fld_Customer00000001';
const OWNER = 'fld_Owner00000000001';

function preview(targetType: 'form' | 'view'): ShareLinkPreview {
  return {
    target_type: targetType,
    record_count: targetType === 'form' ? null : 12,
    record_count_estimated: false,
    fields: [
      { id: NAME, name: 'Name', type: 'text', access: targetType === 'form' ? 'create' : 'read' },
      {
        id: CUSTOMER,
        name: 'Customer',
        type: 'link',
        access: targetType === 'form' ? 'create' : 'read',
      },
      { id: OWNER, name: 'Owner', type: 'user', access: targetType === 'form' ? 'create' : 'read' },
    ],
  };
}

async function renderWarning(targetType: 'form' | 'view', audience: 'org' | 'public') {
  const i18n = await createTestI18n('en');
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nextProvider i18n={i18n}>
        <ScopeWarning
          preview={preview(targetType)}
          error={null}
          audience={audience}
          acknowledged={false}
          onAcknowledge={vi.fn()}
        />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

const listed = () =>
  within(screen.getByTestId('share-scope-fields'))
    .getAllByRole('listitem')
    .map((item) => item.textContent);

describe('ScopeWarning (T421a)', () => {
  it('a public form leaves out the link and people questions it hides; forms speak of filling in', async () => {
    const { container } = await renderWarning('form', 'public');
    expect(screen.getByTestId('share-scope-warning')).toHaveTextContent(
      'People can create records filling in this field:',
    );
    expect(listed()).toEqual(['Name']);
    expect(screen.queryByTestId('share-scope-links')).toBeNull();
    expect(
      screen.getByRole('checkbox', { name: 'I understand who will be able to fill in this form' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/The view's filter always applies/u)).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('an org form asks every question and says link questions show titles of another table', async () => {
    await renderWarning('form', 'org');
    expect(listed()).toEqual(['Name', 'Customer', 'Owner']);
    expect(screen.getByTestId('share-scope-links')).toHaveTextContent(
      'Link fields show the titles of records of another table: Customer',
    );
  });

  it('a view link says its link fields show titles of another table', async () => {
    await renderWarning('view', 'public');
    expect(listed()).toEqual(['Name', 'Customer', 'Owner']);
    expect(screen.getByTestId('share-scope-links')).toHaveTextContent(
      'Link fields show the titles of records of another table: Customer',
    );
    expect(
      screen.getByRole('checkbox', { name: 'I understand who will be able to see this data' }),
    ).toBeInTheDocument();
  });
});
