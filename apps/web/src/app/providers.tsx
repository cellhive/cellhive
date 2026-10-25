import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';

import type { i18n as I18n } from 'i18next';
import type { ReactNode } from 'react';

/** Context providers shared by the app and component tests. */
export function Providers({
  queryClient,
  i18n,
  children,
}: {
  queryClient: QueryClient;
  i18n: I18n;
  children: ReactNode;
}) {
  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </I18nextProvider>
  );
}
