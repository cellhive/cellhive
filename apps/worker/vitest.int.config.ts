import { defineConfig, mergeConfig } from 'vitest/config';

import { integrationConfig } from '../../vitest.shared.js';

export default mergeConfig(
  integrationConfig,
  defineConfig({
    test: {
      // One PostgreSQL 18 container shared by every test file (one database each).
      globalSetup: ['./test/int/global-setup.ts'],
    },
  }),
);
