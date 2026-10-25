import { hash, verify, type Options } from '@node-rs/argon2';

/**
 * argon2id parameters (OWASP Password Storage Cheat Sheet: m = 19 MiB,
 * t = 2, p = 1). `@node-rs/argon2` defaults to argon2id; the parameters are
 * stored in each PHC string, so raising them later keeps old hashes valid.
 */
export const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const satisfies Options;

/** Hashes and verifies passwords with argon2id (SPEC §14.2). */
export class PasswordHasher {
  private dummyHash: Promise<string> | undefined;

  constructor(private readonly options: Options = ARGON2_OPTIONS) {}

  /** PHC string `$argon2id$v=19$m=…,t=…,p=…$salt$hash`. */
  hash(password: string): Promise<string> {
    return hash(password, this.options);
  }

  /** `false` for a wrong password and for a malformed hash. */
  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  /**
   * Spends the same work as a real verification and returns `false`. Called
   * when the email is unknown (or has no password) so that response times
   * do not reveal which accounts exist.
   */
  async verifyDummy(password: string): Promise<false> {
    this.dummyHash ??= this.hash('dummy-password-for-timing');
    await this.verify(await this.dummyHash, password);
    return false;
  }
}
