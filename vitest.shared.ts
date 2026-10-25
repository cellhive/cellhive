import { defineConfig } from 'vitest/config';

/**
 * Shared Vitest settings. Each package extends this with `mergeConfig`:
 * unit tests live in `test/**` or `__tests__/**` as `*.test.ts`,
 * integration tests as `*.int.test.ts` and run through `test:int`.
 */
export const sharedConfig = defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    exclude: ['**/*.int.test.ts', '**/node_modules/**', '**/dist/**'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
  },
});

export const integrationConfig = defineConfig({
  test: {
    include: ['test/**/*.int.test.ts', 'src/**/__tests__/**/*.int.test.ts'],
    passWithNoTests: true,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
