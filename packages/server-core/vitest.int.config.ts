import { defineConfig, mergeConfig } from 'vitest/config';

import { integrationConfig } from '../../vitest.shared.js';

export default mergeConfig(
  integrationConfig,
  defineConfig({
    test: {
      // One PostgreSQL 18 container shared by the DB tests (one database each).
      globalSetup: ['./test/support/postgres-global-setup.ts'],
    },
  }),
);
