import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { createMemoryRouter, Outlet, RouterProvider, type RouteObject } from 'react-router';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../../../test/axe';
import { createTestI18n } from '../../../test/i18n';
import { ApiError } from '../../lib/api/client';
import { lazyRoute, RELOAD_KEY } from '../../lib/lazy/lazy-route';
import { RootErrorBoundary, RouteErrorPage, RouteErrorPanel, RouterRoot } from '../errors';

import type { i18n as I18n } from 'i18next';

let i18n: I18n;

beforeAll(async () => {
  i18n = await createTestI18n('en');
});

beforeEach(() => {
  sessionStorage.clear();
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

/** A route module whose chunk fails `failures` times, then loads (T902). */
function flakyChunk(failures: number) {
  let left = failures;
  return vi.fn(() =>
    left-- > 0
      ? Promise.reject(
          new TypeError(
            'Failed to fetch dynamically imported module: http://localhost/assets/Page.js',
          ),
        )
      : Promise.resolve({ Component: () => <h1>Account</h1> }),
  );
}

function renderRouterRoot(routes: () => RouteObject[]) {
  const create = () => createMemoryRouter(routes(), { initialEntries: ['/'] });
  return render(
    <I18nextProvider i18n={i18n}>
      <RouterRoot router={create()} create={create} />
    </I18nextProvider>,
  );
}

describe('lazy chunks of routes (T902, FRONTEND §8.2)', () => {
  it('opens the page after one automatic retry', async () => {
    const load = flakyChunk(1);
    renderRouterRoot(() => [{ path: '/', lazy: lazyRoute(load) }]);
    expect(await screen.findByRole('heading', { name: 'Account' })).toBeVisible();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shows "Couldn\'t load this page" inside the shell; "Try again" loads it', async () => {
    const load = flakyChunk(2);
    const { container } = renderRouterRoot(() => [
      {
        element: <Shell />,
        errorElement: <RouteErrorPage />,
        children: [{ path: '/', errorElement: <RouteErrorPanel />, lazy: lazyRoute(load) }],
      },
    ]);
    expect(await screen.findByRole('heading', { name: "Couldn't load this page" })).toBeVisible();
    expect(screen.getByRole('navigation', { name: 'Sidebar' })).toBeInTheDocument();
    expect(screen.getByText(/Check your connection and try again/u)).toBeVisible();
    await waitFor(() => {
      expect(document.title).toBe("Couldn't load this page · Cellhive");
    });
    expect(await axeViolations(container)).toEqual([]);

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    // React Router keeps a failed `lazy`: the router is built again and the page opens.
    expect(await screen.findByRole('heading', { name: 'Account' })).toBeVisible();
    expect(screen.getByRole('navigation', { name: 'Sidebar' })).toBeInTheDocument();
  });

  it('shows the full-page screen when a layout chunk fails', async () => {
    renderRouterRoot(() => [
      { path: '/', errorElement: <RouteErrorPage />, lazy: lazyRoute(flakyChunk(2)) },
    ]);
    expect(await screen.findByRole('heading', { name: "Couldn't load this page" })).toBeVisible();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('"Reload page" reloads once and marks it, so it is not offered again at once', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    renderRouterRoot(() => [
      { path: '/', errorElement: <RouteErrorPage />, lazy: lazyRoute(flakyChunk(2)) },
    ]);
    await userEvent.click(await screen.findByRole('button', { name: 'Reload page' }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(RELOAD_KEY)).not.toBeNull();
  });
});
