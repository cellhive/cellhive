import { AuditWriter } from '../../audit/audit-writer.js';
import { publishRealtime } from '../../realtime/bus.js';
import { REALTIME_ENVELOPE_VERSION } from '../../realtime/envelope.js';

import type { AuditContext } from '../../audit/audit-entry.js';
import type { Db, Tx } from '../../db/create-db.js';
import type { Id, UserChannelKind } from '@cellhive/contracts';

const audit = new AuditWriter();

/**
 * `channel.changed` (CONTRACTS §7, §22.7) to `user:<userId>` only, after
 * `tx` commits: kind and status, never a chat id or a Telegram name.
 */
export async function publishChannelChanged(
  db: Db,
  tx: Tx | undefined,
  change: {
    readonly organizationId: Id<'org'>;
    readonly userId: Id<'usr'>;
    readonly kind: UserChannelKind;
    readonly status: 'linked' | 'error' | 'unlinked';
  },
): Promise<void> {
  await publishRealtime(db, tx, {
    v: REALTIME_ENVELOPE_VERSION,
    type: 'channel.changed',
    organization_id: change.organizationId,
    user_id: change.userId,
    kind: change.kind,
    status: change.status,
  });
}

/** Context of a change the member made from Telegram (`/start`, `/stop`): no request. */
export function telegramChatContext(userId: Id<'usr'>): AuditContext {
  return {
    actor: { type: 'user', id: userId },
    via: null,
    batch_id: null,
    request_id: null,
    ip: null,
    user_agent: null,
  };
}

/**
 * Audit of a personal channel linked or removed (CONTRACTS §8, audit only):
 * `entity_type = user`, `entity_id` = the member; `before`/`after` =
 * `{ kind, source }` (`source`: `telegram_start`, `telegram_stop`, `api`) —
 * never the chat id, the Telegram name or the token.
 */
export async function auditUserChannel(
  tx: Tx,
  entry: {
    readonly action: 'user_channel.linked' | 'user_channel.unlinked';
    readonly organizationId: Id<'org'>;
    readonly userId: Id<'usr'>;
    readonly kind: UserChannelKind;
    readonly source: 'telegram_start' | 'telegram_stop' | 'api';
    readonly context: AuditContext;
  },
): Promise<void> {
  const snapshot = { kind: entry.kind, source: entry.source };
  await audit.write(tx, {
    action: entry.action,
    organizationId: entry.organizationId,
    baseId: null,
    entityType: 'user',
    entityId: entry.userId,
    before: entry.action === 'user_channel.unlinked' ? snapshot : null,
    after: entry.action === 'user_channel.linked' ? snapshot : null,
    context: entry.context,
  });
}
