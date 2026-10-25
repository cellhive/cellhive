import { GridCellKind } from '@glideapps/glide-data-grid';

import { initialsOf } from '../display/text';

import { colorOfId, EMPTY_CELL, type CellRenderer } from './common';

export { initialsOf };

import type { UserBadge, UsersCell } from '../customCells/users';
import type { CellRenderContext } from '../types';
import type { GridCell } from '@glideapps/glide-data-grid';

interface UserValue {
  readonly id: string;
  readonly name?: string | undefined;
  readonly email?: string | undefined;
}

function isUserValue(value: unknown): value is UserValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string'
  );
}

/**
 * Users of a `user`, `created_by` or `updated_by` value (CONTRACTS §2): an
 * array of `{ id, name, email }` for `user`, one object for the system
 * types. A former member comes as `{ id }` only and is labelled as such.
 */
export function usersCell(value: unknown, ctx: CellRenderContext): GridCell {
  const users = (Array.isArray(value) ? value : [value]).filter(isUserValue);
  if (users.length === 0) return EMPTY_CELL;
  const badges: UserBadge[] = users.map((user) => {
    const known = user.name ?? user.email;
    return {
      name: known ?? ctx.labels.formerMember,
      initials: known === undefined ? '?' : initialsOf(known),
      // Same color as the user's avatar in the DOM (`paletteIndexOf` hashes the id alike).
      color: colorOfId(user.id, ctx.palette.avatars),
    };
  });
  const cell: UsersCell = {
    kind: GridCellKind.Custom,
    allowOverlay: false,
    readonly: true,
    copyData: badges.map((badge) => badge.name).join(', '),
    data: { kind: 'ob-users', users: badges },
  };
  return cell;
}

/** `user`: avatar with initials + name for each user. */
export const renderUser: CellRenderer<'user'> = (value, _config, ctx) => usersCell(value, ctx);
