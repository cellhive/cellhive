import react from '@vitejs/plugin-react';
import { defineConfig, mergeConfig } from 'vitest/config';

import { sharedConfig } from '../../vitest.shared.js';

import { GLIDE_OVERLAY_EDITOR_ALIAS } from './vite.config.ts';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    plugins: [react()],
    resolve: { alias: [GLIDE_OVERLAY_EDITOR_ALIAS] },
    test: {
      environment: 'jsdom',
      include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
      setupFiles: ['./test/setup.ts'],
      // App-level tests render the router, whose first render loads every
      // lazy route chunk through Vite's transform; on a loaded machine that
      // alone can pass the 5 s default.
      testTimeout: 15_000,
    },
  }),
);
