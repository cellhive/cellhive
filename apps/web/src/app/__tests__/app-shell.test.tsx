import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { use } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';

import { json, renderApp, stubApi } from '../../../test/app-harness';
import { createTestI18n } from '../../../test/i18n';
import { createQueryClient } from '../../lib/query/client';
import AppShell from '../layouts/AppShell';
import { Providers } from '../providers';

describe('AppShell navigation drawer', () => {
  it('closes on Escape and gives the focus back to its button (S2 QA)', async () => {
    stubApi({ signedIn: true });
    await renderApp('/o/acme');
    const user = userEvent.setup();
    const open = await screen.findByRole('button', { name: 'Open navigation' });
    await user.click(open);
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    expect(sidebar).toHaveClass('visible');
    expect(open).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('{Escape}');
    expect(open).toHaveAttribute('aria-expanded', 'false');
    expect(sidebar).toHaveClass('invisible');
    expect(open).toHaveFocus();
  });

  it('stays open when opened while the next page was still loading (CI t290)', async () => {
    // The router renders a navigation inside a transition: the address bar
    // shows the next page at once, the previous page stays on screen until
    // the next one is ready. A tap on the menu meanwhile opened the drawer,
    // which then closed by itself when the next page appeared.
    stubApi({ signedIn: true });
    let release: () => void = () => undefined;
    const nextReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    function NextPage() {
      use(nextReady);
      return <h1>Next page</h1>;
    }
    window.history.replaceState(null, '', '/first');
    try {
      const router = createBrowserRouter([
        {
          element: <AppShell />,
          children: [
            { path: '/first', element: <h1>First page</h1> },
            { path: '/next', element: <NextPage /> },
          ],
        },
      ]);
      render(
        <Providers queryClient={createQueryClient()} i18n={await createTestI18n('en')}>
          <RouterProvider router={router} />
        </Providers>,
      );
      const open = await screen.findByRole('button', { name: 'Open navigation' });
      await act(async () => {
        await router.navigate('/next');
      });
      expect(window.location.pathname).toBe('/next');
      expect(screen.getByRole('heading', { name: 'First page' })).toBeInTheDocument();

      // (An awaited `act`: the urgent render meets the suspended transition.)
      await act(async () => {
        open.click();
        await Promise.resolve();
      });
      expect(open).toHaveAttribute('aria-expanded', 'true');
      await act(async () => {
        release();
        await nextReady;
      });
      expect(await screen.findByRole('heading', { name: 'Next page' })).toBeInTheDocument();
      const menu = screen.getByRole('button', { name: 'Open navigation' });
      expect(menu).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('complementary', { name: 'Sidebar' })).toHaveClass('visible');

      // A navigation started once it is open closes it.
      await act(async () => {
        await router.navigate('/first');
      });
      expect(await screen.findByRole('heading', { name: 'First page' })).toBeInTheDocument();
      expect(menu).toHaveAttribute('aria-expanded', 'false');
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });
});

describe('UserMenu', () => {
  it('links to "Connected accounts" when the server has OIDC providers (T715)', async () => {
    stubApi({
      signedIn: true,
      routes: {
        'GET /setup': () =>
          json({
            setup_required: false,
            auth_config: {
              smtp_enabled: false,
              providers: [{ slug: 'keycloak', name: 'Keycloak' }],
            },
          }),
      },
    });
    const { router } = await renderApp('/o/acme');
    const user = userEvent.setup();
    const menu = (await screen.findAllByRole('button', { name: 'Account menu for An Nguyen' }))[0];
    if (menu === undefined) throw new Error('no account menu');
    await user.click(menu);
    await user.click(await screen.findByRole('menuitem', { name: 'Connected accounts' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/account/connections');
    });
  });

  it('has no "Connected accounts" without providers', async () => {
    stubApi({ signedIn: true });
    await renderApp('/o/acme');
    const user = userEvent.setup();
    const menu = (await screen.findAllByRole('button', { name: 'Account menu for An Nguyen' }))[0];
    if (menu === undefined) throw new Error('no account menu');
    await user.click(menu);
    expect(await screen.findByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Connected accounts' })).toBeNull();
  });
});
