import {
  BASE_PACKAGE_DETAIL_CODES,
  PACKAGE_TOO_LARGE,
  type BasePackageLimitReason,
  type ProblemErrorItem,
} from '@cellhive/contracts';

import { AppError } from '../errors/app-error.js';

/** A detail code of `422 INVALID_PACKAGE` (CONTRACTS §6, §12.2). */
export type BasePackageProblem = (typeof BASE_PACKAGE_DETAIL_CODES)[number];

/** Problems kept in one `INVALID_PACKAGE` error; the count of the rest goes in `params`. */
export const MAX_PACKAGE_PROBLEMS = 100;

/**
 * `path` of a problem: an entry of the package (`schema/tables.json`), with
 * `#<JSON pointer>` inside it (RFC 6901) and `:<line>` for an NDJSON line.
 * Built from names the package defines, never a path of the file system.
 */
export function packagePath(entry: string, pointer?: readonly (string | number)[]): string {
  if (pointer === undefined || pointer.length === 0) return entry;
  const escaped = pointer.map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1'));
  return `${entry}#/${escaped.join('/')}`;
}

/** `path` of a problem on line `line` (1-based) of an NDJSON entry. */
export function packageLinePath(
  entry: string,
  line: number,
  pointer?: readonly (string | number)[],
): string {
  return packagePath(`${entry}:${String(line)}`, pointer);
}

/**
 * `422 INVALID_PACKAGE` with the problems found (at most
 * {@link MAX_PACKAGE_PROBLEMS}). Messages describe the structure of the
 * package only, never a value it holds.
 */
export function invalidPackage(items: readonly ProblemErrorItem[], dropped = 0): AppError {
  const first = items[0];
  return new AppError('INVALID_PACKAGE', {
    detail: first === undefined ? 'The package is invalid.' : first.message,
    errors: items,
    ...(dropped > 0 ? { params: { more_problems: dropped } } : {}),
  });
}

/** `INVALID_PACKAGE` with one problem. */
export function packageProblem(
  code: BasePackageProblem,
  path: string,
  message: string,
  params?: Readonly<Record<string, unknown>>,
): AppError {
  return invalidPackage([{ path, code, message, ...(params === undefined ? {} : { params }) }]);
}

/** `ARCHIVE_LIMIT_EXCEEDED` for one cap of CONTRACTS §12.2. */
export function packageLimitProblem(
  path: string,
  reason: BasePackageLimitReason,
  limit: number,
  message: string,
): AppError {
  return packageProblem('ARCHIVE_LIMIT_EXCEEDED', path, message, { reason, limit });
}

/**
 * A package over `BASE_PACKAGE_MAX_BYTES` while it is written (export job):
 * `VALIDATION_FAILED` with `PACKAGE_TOO_LARGE` (`params.limit`).
 */
export function packageTooLarge(limit: number): AppError {
  const message = 'The base is larger than the largest package allowed.';
  return new AppError('VALIDATION_FAILED', {
    detail: message,
    errors: [{ path: '', code: PACKAGE_TOO_LARGE, message, params: { limit } }],
  });
}

/** Whether `error` is an `INVALID_PACKAGE` error. */
export function isInvalidPackage(error: unknown): error is AppError {
  return error instanceof AppError && error.code === 'INVALID_PACKAGE';
}

/**
 * Problems collected while checking a package (references of every shape),
 * thrown together as one `INVALID_PACKAGE`.
 */
export class PackageProblems {
  private readonly items: ProblemErrorItem[] = [];
  private dropped = 0;

  add(
    code: BasePackageProblem,
    path: string,
    message: string,
    params?: Readonly<Record<string, unknown>>,
  ): void {
    if (this.items.length >= MAX_PACKAGE_PROBLEMS) {
      this.dropped += 1;
      return;
    }
    this.items.push({ path, code, message, ...(params === undefined ? {} : { params }) });
  }

  get size(): number {
    return this.items.length + this.dropped;
  }

  list(): readonly ProblemErrorItem[] {
    return this.items;
  }

  throwIfAny(): void {
    if (this.items.length > 0) throw invalidPackage(this.items, this.dropped);
  }
}
