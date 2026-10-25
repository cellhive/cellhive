import { defineConfig, mergeConfig } from 'vitest/config';

import { sharedConfig } from '../../vitest.shared.js';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      // Pure package: coverage ≥ 90% (SPEC §25), enforced in CI by `test:coverage`.
      coverage: {
        include: ['src/**/*.ts'],
        thresholds: {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
      },
    },
  }),
);
