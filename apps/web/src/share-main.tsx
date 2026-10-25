import '@fontsource/be-vietnam-pro/400.css';
import '@fontsource/be-vietnam-pro/500.css';
import '@fontsource/be-vietnam-pro/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles/index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';

import { RootErrorBoundary } from './app/errors';
import { Providers } from './app/providers';
import { createShareRoutes } from './app/share-routes';
import { initI18n } from './lib/i18n/i18n';
import { createQueryClient } from './lib/query/client';
import { initTheme } from './lib/theme/theme';
import { Toaster } from './lib/toast/Toaster';

/**
 * Entry of the public share pages (`share.html`, served for `/s/*`; T317,
 * FRONTEND §11.1): the share page and what it needs, without the app
 * router, its guards or the app shell — a lighter first load for people
 * outside the organization. No WebSocket is ever opened here.
 */
initTheme();

const container = document.getElementById('root');
if (container !== null) {
  const root = createRoot(container);
  void initI18n().then((i18n) => {
    const queryClient = createQueryClient();
    const router = createBrowserRouter(createShareRoutes());
    root.render(
      <StrictMode>
        <Providers queryClient={queryClient} i18n={i18n}>
          <RootErrorBoundary>
            <RouterProvider router={router} />
            <Toaster />
          </RootErrorBoundary>
        </Providers>
      </StrictMode>,
    );
  });
}
