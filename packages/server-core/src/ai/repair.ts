import { zodIssuesToProblemErrors } from '../errors/zod-issues.js';

import type { z } from 'zod';

/** Repair rounds after the first answer (S§12.2 #1: at most 2), then `AI_INVALID_OUTPUT`. */
export const AI_MAX_REPAIR_ROUNDS = 2;

/** Problems sent back to the model per round. */
export const MAX_REPAIR_PROBLEMS = 10;

/**
 * One reason an answer cannot be used, sent back to the model. A feature's
 * `validate` only names what the model was given (the digest): never a
 * hidden field, a record value or an id it did not see.
 */
export interface AiOutputProblem {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

/** The verdict of a feature's engine on a parsed answer. */
export type AiValidation<R> =
  | { readonly ok: true; readonly value: R }
  | { readonly ok: false; readonly problems: readonly AiOutputProblem[] };

export const NOT_JSON_PROBLEM: AiOutputProblem = {
  path: '',
  code: 'INVALID_JSON',
  message: 'The answer does not contain a JSON object.',
};

/** zod issues as problems (the received value is never repeated). */
export function zodProblems(error: z.ZodError): AiOutputProblem[] {
  return zodIssuesToProblemErrors(error.issues).map(({ path, code, message }) => ({
    path,
    code,
    message,
  }));
}

/** The user message of a repair round. */
export function repairMessage(problems: readonly AiOutputProblem[]): string {
  return (
    'Your previous answer cannot be used. Problems (path, code, message):\n' +
    `${JSON.stringify(problems.slice(0, MAX_REPAIR_PROBLEMS))}\n` +
    'Answer again with the corrected JSON object only.'
  );
}
