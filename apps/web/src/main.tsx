import '@fontsource/be-vietnam-pro/400.css';
import '@fontsource/be-vietnam-pro/500.css';
import '@fontsource/be-vietnam-pro/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles/index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';

import { RootErrorBoundary } from './app/errors';
import { Providers } from './app/providers';
import { createAppRouter } from './app/router';
import { initI18n } from './lib/i18n/i18n';
import { createQueryClient } from './lib/query/client';
import { initTheme } from './lib/theme/theme';

// Theme first, so the first paint already has the chosen colors.
initTheme();

const container = document.getElementById('root');
if (container !== null) {
  const root = createRoot(container);
  void initI18n().then((i18n) => {
    const queryClient = createQueryClient();
    const router = createAppRouter(queryClient);
    root.render(
      <StrictMode>
        <Providers queryClient={queryClient} i18n={i18n}>
          <RootErrorBoundary>
            <RouterProvider router={router} />
          </RootErrorBoundary>
        </Providers>
      </StrictMode>,
    );
  });
}
