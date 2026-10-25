import { defineConfig, mergeConfig } from 'vitest/config';

import { integrationConfig } from '../../vitest.shared.js';

export default mergeConfig(
  integrationConfig,
  defineConfig({
    test: {
      // Containers shared by every test file (PostgreSQL, Valkey, Garage).
      globalSetup: ['./test/int/global-setup.ts'],
    },
  }),
);
