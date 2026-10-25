import { toIsoDateTime, type Id, type ProblemErrorItem, OffsetQuery } from '@cellhive/contracts';
import { AppError } from '@cellhive/server-core/errors';

import type { Page, User } from '@cellhive/server-core';

/** `UserSummary` (CONTRACTS §12.0) of a user row. */
export function userSummaryOf(user: Pick<User, 'id' | 'email' | 'display_name' | 'avatar_url'>): {
  id: Id<'usr'>;
  email: string;
  display_name: string;
  avatar_url: string | null;
} {
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    avatar_url: user.avatar_url,
  };
}

export function iso(date: Date): string {
  return toIsoDateTime(date);
}

export function isoOrNull(date: Date | null): string | null {
  return date === null ? null : toIsoDateTime(date);
}

/** `{ items, total, offset, limit }` (CONTRACTS §1.1). */
export function offsetList<T, U>(
  page: Page<T>,
  query: OffsetQuery,
  map: (item: T) => U,
): { items: U[]; total: number; offset: number; limit: number } {
  return {
    items: page.items.map(map),
    total: page.total,
    offset: query.offset,
    limit: query.limit,
  };
}

/** `422 VALIDATION_FAILED` with one detail item. */
export function validationFailed(
  detail: string,
  error: Omit<ProblemErrorItem, 'message'> & { message?: string },
): AppError {
  return new AppError('VALIDATION_FAILED', {
    detail,
    errors: [{ ...error, message: error.message ?? detail }],
  });
}
