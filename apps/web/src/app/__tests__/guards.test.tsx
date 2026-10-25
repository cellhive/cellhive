import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderApp, stubApi } from '../../../test/app-harness';

function pathOf(router: Awaited<ReturnType<typeof renderApp>>['router']): string {
  const { pathname, search } = router.state.location;
  return `${pathname}${search}`;
}

describe('route guards (FRONTEND §2)', () => {
  it('sends every visitor to /setup while the instance has no user', async () => {
    stubApi({ setupRequired: true });
    for (const path of ['/', '/login', '/o/acme']) {
      const { router } = await renderApp(path);
      await waitFor(() => {
        expect(pathOf(router)).toBe('/setup');
      });
    }
    expect(await screen.findAllByRole('heading', { name: 'Set up Cellhive' })).not.toHaveLength(0);
  });

  it('closes /setup once the instance is set up', async () => {
    stubApi({ setupRequired: false });
    const { router } = await renderApp('/setup');
    await waitFor(() => {
      expect(pathOf(router)).toBe('/login');
    });
  });

  it('sends a signed-out user to /login with the page as next', async () => {
    stubApi({ signedIn: false });
    const { router } = await renderApp('/o/acme?tab=1');
    await waitFor(() => {
      expect(pathOf(router)).toBe('/login?next=%2Fo%2Facme%3Ftab%3D1');
    });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('lets a signed-in user skip /login, to an internal next only', async () => {
    stubApi({ signedIn: true });
    const internal = await renderApp('/login?next=%2Fo%2Facme');
    await waitFor(() => {
      expect(pathOf(internal.router)).toBe('/o/acme');
    });
  });

  it.each(['https://evil.example/', '//evil.example', '/\\evil.example'])(
    'ignores the external next %s',
    async (next) => {
      stubApi({ signedIn: true });
      const { router } = await renderApp(`/login?next=${encodeURIComponent(next)}`);
      await waitFor(() => {
        expect(pathOf(router)).toBe('/o/acme');
      });
    },
  );

  it('opens the last organization from /', async () => {
    stubApi({ signedIn: true });
    const { router } = await renderApp('/');
    await waitFor(() => {
      expect(pathOf(router)).toBe('/o/acme');
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Acme' })).toBeInTheDocument();
  });

  it('shows 404 for an organization the user does not belong to', async () => {
    stubApi({ signedIn: true });
    await renderApp('/o/unknown');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });

  it('shows 404 for a base the API does not reveal', async () => {
    stubApi({ signedIn: true });
    await renderApp('/b/bse_0123456789ABCDEF');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });

  it('shows 404 for unknown paths to a signed-in user', async () => {
    stubApi({ signedIn: true });
    await renderApp('/no/such/page');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });

  it.each(['/me', '/no/such/page'])(
    'sends a signed-out user from the unknown path %s to /login with next',
    async (path) => {
      stubApi({ signedIn: false });
      const { router } = await renderApp(path);
      await waitFor(() => {
        expect(pathOf(router)).toBe(`/login?next=${encodeURIComponent(path)}`);
      });
    },
  );
});
