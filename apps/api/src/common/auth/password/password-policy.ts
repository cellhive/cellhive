import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_TOO_COMMON,
  type ProblemErrorItem,
} from '@cellhive/contracts';
import { AppError } from '@cellhive/server-core/errors';

import { COMMON_PASSWORDS_TEXT } from './common-passwords.js';

let commonPasswords: ReadonlySet<string> | undefined;

/** The common-password list, built on first use. */
function commonPasswordSet(): ReadonlySet<string> {
  commonPasswords ??= new Set(COMMON_PASSWORDS_TEXT.split('\n'));
  return commonPasswords;
}

/** Whether `password` is in the bundled common-password list (case-insensitive). */
export function isCommonPassword(password: string): boolean {
  return commonPasswordSet().has(password.toLowerCase());
}

/**
 * Problems of a new password under SPEC §14.2: at least 10 characters (at
 * most 256) and not a common password. Request schemas already check the
 * length; this also covers passwords that do not come through a schema.
 */
export function passwordProblems(password: string, path = 'password'): ProblemErrorItem[] {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return [
      {
        path,
        code: 'TOO_SMALL',
        message: `Must be at least ${String(PASSWORD_MIN_LENGTH)} characters`,
        params: { minimum: PASSWORD_MIN_LENGTH, inclusive: true, origin: 'string' },
      },
    ];
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return [
      {
        path,
        code: 'TOO_BIG',
        message: `Must be at most ${String(PASSWORD_MAX_LENGTH)} characters`,
        params: { maximum: PASSWORD_MAX_LENGTH, inclusive: true, origin: 'string' },
      },
    ];
  }
  if (isCommonPassword(password)) {
    return [
      { path, code: PASSWORD_TOO_COMMON, message: 'This password is too common; choose another' },
    ];
  }
  return [];
}

/** Throws `422 VALIDATION_FAILED` when `password` breaks the policy. */
export function assertPasswordPolicy(password: string, path = 'password'): void {
  const errors = passwordProblems(password, path);
  if (errors.length > 0) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'The password does not meet the password policy.',
      errors,
    });
  }
}
