import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestI18n } from '../../../test/i18n';
import { ApiError } from '../../lib/api/client';
import { RootErrorBoundary, RouteErrorPage, RouteErrorPanel } from '../errors';

import type { i18n as I18n } from 'i18next';

let i18n: I18n;

beforeAll(async () => {
  i18n = await createTestI18n('en');
});

beforeEach(() => {
  // React reports caught render errors on the console; keep the output clean.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

function Broken(): never {
  throw new TypeError('render failed');
}

function Shell() {
  return (
    <div>
      <nav aria-label="Sidebar">shell</nav>
      <main>
        <Outlet />
      </main>
    </div>
  );
}

function renderRoutes(child: () => React.ReactNode) {
  const router = createMemoryRouter(
    [
      {
        element: <Shell />,
        errorElement: <RouteErrorPage />,
        children: [{ path: '/', Component: child, errorElement: <RouteErrorPanel /> }],
      },
    ],
    { initialEntries: ['/'] },
  );
  render(
    <I18nextProvider i18n={i18n}>
      <RouterProvider router={router} />
    </I18nextProvider>,
  );
}

describe('error boundaries (FRONTEND §8.2)', () => {
  it('keeps the app shell when a page fails to render', async () => {
    renderRoutes(Broken);
    expect(await screen.findByRole('heading', { name: 'Something went wrong' })).toBeVisible();
    expect(screen.getByRole('navigation', { name: 'Sidebar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('shows the shared 404 panel for a NOT_FOUND error, inside the shell', async () => {
    renderRoutes(() => {
      throw new ApiError({ status: 404, code: 'NOT_FOUND' });
    });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeVisible();
    expect(screen.getByRole('navigation', { name: 'Sidebar' })).toBeInTheDocument();
  });

  it('shows the translated API error with its request ID', async () => {
    renderRoutes(() => {
      throw new ApiError({ status: 500, code: 'INTERNAL', request_id: 'req_0123456789ABCDEF' });
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('An unexpected server error occurred.');
    expect(alert).toHaveTextContent('req_0123456789ABCDEF');
  });

  it('has a last-resort boundary around everything', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <RootErrorBoundary>
          <Broken />
        </RootErrorBoundary>
      </I18nextProvider>,
    );
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });
});
