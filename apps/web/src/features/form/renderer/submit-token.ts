import type { FormAntiSpam, FormClock } from '../../../lib/forms/renderer';
import type { FormSubmitTokenDto } from '@cellhive/contracts';

/** Real time. */
export const SYSTEM_CLOCK: FormClock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

/**
 * The submit token of a link form (CONTRACTS §17, ADR-0030): fetched when
 * the form opens so that the minimum fill time runs while the person types,
 * single use (a sent form asks for a new one), replaced when the server
 * says it is no longer valid. A refused submission gives the token back on
 * the server, so the same token is sent again after a fix.
 */
export class SubmitTokens {
  readonly #antiSpam: FormAntiSpam;
  readonly #clock: FormClock;
  #pending: Promise<FormSubmitTokenDto> | null = null;
  #controller: AbortController | null = null;

  constructor(antiSpam: FormAntiSpam, clock: FormClock) {
    this.#antiSpam = antiSpam;
    this.#clock = clock;
  }

  /** Starts fetching a token (the form opened, or the last one was used). */
  prefetch(): Promise<FormSubmitTokenDto> {
    if (this.#pending !== null) return this.#pending;
    this.#controller = new AbortController();
    const pending = this.#antiSpam.fetchToken(this.#controller.signal);
    this.#pending = pending;
    // A failed fetch is retried by the next `ready()`.
    pending.catch(() => {
      if (this.#pending === pending) this.#pending = null;
    });
    return pending;
  }

  /**
   * A token usable now: waits for the fetch and for `not_before` (the
   * minimum fill time) if the person was quicker.
   */
  async ready(): Promise<string> {
    const token = await this.prefetch();
    const wait = Date.parse(token.not_before) - this.#clock.now();
    if (wait > 0) await this.#clock.sleep(wait);
    return token.submit_token;
  }

  /** The token was used (or refused): the next submission asks for a new one. */
  discard(): void {
    this.#pending = null;
  }

  /** The form is gone: stop a fetch in flight. */
  dispose(): void {
    this.#controller?.abort();
    this.#controller = null;
    this.#pending = null;
  }
}
