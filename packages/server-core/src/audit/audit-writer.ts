import { newId, type Id } from '@cellhive/contracts';

import { buildAuditRow, type AuditEntryInput } from './audit-entry.js';

import type { Tx } from '../db/create-db.js';
import type { JsonObject } from '../db/schema.js';

export interface WrittenAuditEntry {
  readonly id: Id<'aud'>;
  readonly createdAt: Date;
}

/**
 * Appends to `meta.audit_logs` (ADR-23) on the caller's transaction, so the
 * entry exists if and only if the mutation commits. The table is
 * append-only: there is no update or delete here, and redaction goes through
 * `meta.audit_redact`.
 *
 * Entries never contain secrets (see `AuditEntryInput`); a write with an
 * unknown action, a missing organization outside `auth.*`/system, or a
 * secret-looking key throws before anything is sent to the database.
 *
 * Stateless; one instance can be shared.
 */
export class AuditWriter {
  async write(tx: Tx, entry: AuditEntryInput): Promise<WrittenAuditEntry> {
    const row = buildAuditRow(entry);
    const id = newId('aud');
    const { created_at: createdAt } = await tx
      .insertInto('meta.audit_logs')
      .values({
        id,
        ...row,
        via: row.via === null ? null : ({ ...row.via } as JsonObject),
      })
      .returning('created_at')
      .executeTakeFirstOrThrow();
    return { id, createdAt };
  }

  /**
   * `write` for many entries in one multi-row insert per 1 000 entries (bulk
   * record writes). Every entry is validated before anything is sent.
   */
  async writeMany(tx: Tx, entries: readonly AuditEntryInput[]): Promise<WrittenAuditEntry[]> {
    const rows = entries.map((entry) => {
      const row = buildAuditRow(entry);
      return {
        id: newId('aud'),
        ...row,
        via: row.via === null ? null : { ...row.via },
      };
    });
    const written: WrittenAuditEntry[] = [];
    for (let start = 0; start < rows.length; start += WRITE_MANY_CHUNK) {
      const chunk = rows.slice(start, start + WRITE_MANY_CHUNK);
      const inserted = await tx
        .insertInto('meta.audit_logs')
        .values(chunk)
        .returning(['id', 'created_at'])
        .execute();
      const createdAt = new Map<string, Date>(inserted.map((row) => [row.id, row.created_at]));
      for (const row of chunk) {
        const at = createdAt.get(row.id);
        if (at === undefined) throw new Error('writeMany: an audit row was not returned');
        written.push({ id: row.id, createdAt: at });
      }
    }
    return written;
  }
}

/** Entries per multi-row insert (well below PostgreSQL's 65 535 parameters). */
const WRITE_MANY_CHUNK = 1_000;
