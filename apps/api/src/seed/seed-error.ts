/**
 * Expected failure of `pnpm seed:demo` (production guard, data already
 * present, broken invariant): printed without a stack, exit code 1.
 */
export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedError';
  }
}
