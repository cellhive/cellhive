import { AuditRefsRepository, type AuditApiTokenRef } from './audit-refs.js';

import type { AuditLogRow } from './audit-logs.repository.js';
import type { Db } from '../db/create-db.js';
import type { OrgScope } from '../db/repository.js';
import type { JsonObject, JsonValue } from '../db/schema.js';
import type { Id } from '@cellhive/contracts';

/**
 * Who reads audit entries (record history, audit list, audit export), for
 * the API token rule of S6 decision #19: organization owners/admins and the
 * token's owner see which token made a change; everyone else does not.
 */
export interface AuditViewer {
  /** `null`: nobody in particular (only organization admins see tokens then). */
  readonly userId: Id<'usr'> | null;
  readonly isOrgAdmin: boolean;
}

/** The part of an entry `via` presentation needs. */
type ViaRow = Pick<AuditLogRow, 'via' | 'actor_type' | 'actor_id'>;

function objectOf(value: JsonValue | null): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

/** `via.api_token_id` of the entries, without duplicates. */
export function viaApiTokenIdsOf(rows: readonly ViaRow[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    const id = objectOf(row.via)?.['api_token_id'];
    if (typeof id === 'string') ids.add(id);
  }
  return [...ids];
}

/**
 * `via` of an entry as `viewer` may see it (CONTRACTS §11.1, ADR-36 §1,
 * S6 decision #19). Without `api_token_id` it is the stored value. With
 * one, an organization owner/admin or the token's owner reads it with
 * `api_token_name` = the token's **current** name (`null` once the token
 * is deleted); anyone else reads `api_token_id: null, api_token_name: null`
 * — the source is still "an API token", never which one. The owner of a
 * deleted token is the entry's user actor (a write through a token is
 * audited as its user).
 */
export function shownViaOf(
  row: ViaRow,
  tokens: ReadonlyMap<string, AuditApiTokenRef>,
  viewer: AuditViewer,
): JsonObject | null {
  const via = objectOf(row.via);
  const id = via?.['api_token_id'];
  if (via === null || typeof id !== 'string') return via;
  const token = tokens.get(id);
  const owner = token?.user_id ?? (row.actor_type === 'user' ? row.actor_id : null);
  const visible = viewer.isOrgAdmin || (viewer.userId !== null && owner === viewer.userId);
  return visible
    ? { ...via, api_token_name: token?.name ?? null }
    : { ...via, api_token_id: null, api_token_name: null };
}

/**
 * Presents the `via` of a page of entries for one viewer: one lookup of the
 * tokens they name (`AuditRefsRepository.apiTokens`, bound to the
 * organization), then `shownViaOf` per entry.
 */
export async function apiTokenViaPresenter(
  db: Db | AuditRefsRepository,
  scope: OrgScope,
  rows: readonly ViaRow[],
  viewer: AuditViewer,
): Promise<(row: ViaRow) => JsonObject | null> {
  const ids = viaApiTokenIdsOf(rows);
  const refs = db instanceof AuditRefsRepository ? db : new AuditRefsRepository(db);
  const tokens = new Map(
    (ids.length === 0 ? [] : await refs.apiTokens(scope, ids)).map((token) => [token.id, token]),
  );
  return (row) => shownViaOf(row, tokens, viewer);
}
