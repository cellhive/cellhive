import { Suspense } from 'react';
import { Outlet } from 'react-router';

import { Logo } from '../../lib/brand/Logo';
import { LanguageThemeControls } from '../preferences-controls';

import { PageLoading } from './RootLayout';

/** Centered card layout of setup, sign-in, password and invitation screens. */
export function AuthLayout() {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="flex items-center justify-between gap-4 px-6 py-4">
        <Logo />
        <LanguageThemeControls />
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-8 pb-16 sm:pt-16">
        <div className="w-full max-w-md">
          <Suspense fallback={<PageLoading />}>
            <Outlet />
          </Suspense>
        </div>
      </main>
    </div>
  );
}

export default AuthLayout;
