import { defineConfig, mergeConfig } from 'vitest/config';

import { sharedConfig } from '../../vitest.shared.js';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      // Timing budgets (T453 evaluator: 4,000 characters × 1,000 rows < 200 ms) hold for
      // plain Node; v8 coverage instrumentation makes the interpreter ~4× slower.
      env: { FORMULA_ENGINE_COVERAGE: process.argv.includes('--coverage') ? '1' : '' },
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
