import { Buffer } from 'node:buffer';

import { loadConfig, orgBusChannel, type RealtimeEnvelope } from '@cellhive/server-core';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { jobProgressDelivery, schemaChangedDelivery } from '../../src/modules/realtime/delivery.js';
import { fieldConvertingDelivery } from '../../src/modules/realtime/field-converting-delivery.js';
import {
  RealtimeConnection,
  type Subscriber,
  type Subscription,
} from '../../src/modules/realtime/realtime-connection.js';
import { RealtimeLimits } from '../../src/modules/realtime/realtime-limits.js';
import { RealtimeRouter } from '../../src/modules/realtime/realtime-router.js';
import { RealtimeGateway } from '../../src/modules/realtime/realtime.gateway.js';
import { SubscriptionRegistry } from '../../src/modules/realtime/subscription-registry.js';
import {
  allowedOrigins,
  clientIpOf,
  originAllowed,
  pathOf,
  trustedProxyList,
} from '../../src/modules/realtime/upgrade.js';

import type { BaseAccess } from '../../src/common/access/access.service.js';
import type { Principal } from '../../src/common/auth/principal.js';
import type { AppLogger } from '../../src/common/logging/app-logger.js';
import type { RealtimeBusSubscriber } from '../../src/modules/realtime/bus-subscriber.js';
import type {
  ChannelAuthorizer,
  ChannelGrant,
} from '../../src/modules/realtime/channel-authorizer.js';
import type { Id, RealtimeChannel, RealtimeServerMessage } from '@cellhive/contracts';
import type { IncomingMessage } from 'node:http';

const ORG: Id<'org'> = 'org_A1b2C3d4E5f6G7h8';
const BSE: Id<'bse'> = 'bse_A1b2C3d4E5f6G7h8';
const TBL: Id<'tbl'> = 'tbl_A1b2C3d4E5f6G7h8';
const HIDDEN: Id<'tbl'> = 'tbl_Z1b2C3d4E5f6G7h8';
const FLD: Id<'fld'> = 'fld_A1b2C3d4E5f6G7h8';
const NO_PERM_FLD: Id<'fld'> = 'fld_Z1b2C3d4E5f6G7h8';
const USR: Id<'usr'> = 'usr_A1b2C3d4E5f6G7h8';
const OTHER_USR: Id<'usr'> = 'usr_Z1b2C3d4E5f6G7h8';

function config(env: Record<string, string> = {}) {
  return loadConfig({
    PUBLIC_URL: 'https://cellhive.example/app/',
    DATABASE_URL: 'postgres://localhost/x',
    CACHE_URL: 'redis://localhost',
    APP_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
    SESSION_SECRET: 'x'.repeat(32),
    ...env,
  });
}

describe('handshake helpers', () => {
  it('allows PUBLIC_URL and CORS_ORIGINS', () => {
    expect([...allowedOrigins(config())]).toEqual(['https://cellhive.example']);
    expect([
      ...allowedOrigins(config({ CORS_ORIGINS: 'https://a.example,http://localhost:5173' })),
    ]).toEqual(['https://a.example', 'http://localhost:5173', 'https://cellhive.example']);
  });

  it.each<[string | string[] | undefined, boolean]>([
    ['https://cellhive.example', true],
    ['HTTPS://CELLHIVE.EXAMPLE', true],
    ['https://cellhive.example:443', true],
    ['https://cellhive.example.evil.test', false],
    ['http://cellhive.example', false],
    ['https://cellhive.example:8443', false],
    ['null', false],
    ['file://', false],
    [undefined, false],
    [['https://cellhive.example'], false],
  ])('origin %j → %s', (origin, allowed) => {
    expect(originAllowed(origin, allowedOrigins(config()))).toBe(allowed);
  });

  it.each([
    ['/ws', '/ws'],
    ['/ws?x=1', '/ws'],
    [undefined, '/'],
  ])('path of %s', (url, path) => {
    expect(pathOf(url)).toBe(path);
  });

  // T706: the per-IP limit on failed Bearer handshakes keys on the address
  // Fastify would give `request.ip` with `trustProxy: TRUSTED_PROXIES`.
  it.each<[string | undefined, string | undefined, string | null]>([
    ['198.51.100.7', undefined, '198.51.100.7'],
    ['::ffff:198.51.100.7', undefined, '198.51.100.7'],
    ['198.51.100.7', '203.0.113.9', '198.51.100.7'],
    ['127.0.0.1', '203.0.113.9', '203.0.113.9'],
    ['::ffff:127.0.0.1', '203.0.113.9', '203.0.113.9'],
    ['127.0.0.1', '203.0.113.9, 172.16.0.5', '203.0.113.9'],
    ['127.0.0.1', '10.0.0.1, 203.0.113.9', '203.0.113.9'],
    ['127.0.0.1', '172.16.0.4, 172.16.0.5', '172.16.0.4'],
    ['::1', '2001:db8::1', '2001:db8::1'],
    ['127.0.0.1', 'garbage', null],
    [undefined, '203.0.113.9', null],
  ])('client ip of peer %s with X-Forwarded-For %j → %s', (peer, forwarded, ip) => {
    const proxies = trustedProxyList(config().security.trustedProxies);
    const request = {
      socket: { remoteAddress: peer },
      headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
    } as unknown as IncomingMessage;
    expect(clientIpOf(request, proxies)).toBe(ip);
  });
});

function access(tables: Record<string, readonly string[]>, isAdmin = false): BaseAccess {
  return {
    access: {
      is_admin: isAdmin,
      tables: Object.fromEntries(
        Object.entries(tables).map(([id, fields]) => [
          id,
          { fields: Object.fromEntries(fields.map((field) => [field, 'read'])) },
        ]),
      ),
    },
  } as unknown as BaseAccess;
}

function subscriber(
  channel: string,
  base: BaseAccess | null,
  previousBase: BaseAccess | null = null,
  userId: Id<'usr'> = USR,
): Subscriber {
  return {
    channel,
    target: { kind: 'table', id: TBL },
    tables: null,
    userId,
    connectionId: 1,
    base,
    previousBase,
    variables: null,
    view: null,
  };
}

const schemaEnvelope = (
  entity: 'table' | 'field',
  entityId: string,
  action: 'created' | 'updated' | 'deleted' = 'updated',
  tableId: Id<'tbl'> = TBL,
) =>
  ({
    v: 1,
    type: 'schema.changed',
    organization_id: ORG,
    base_id: BSE,
    table_id: tableId,
    entity,
    entity_id: entityId,
    action,
  }) as const;

describe('schemaChangedDelivery', () => {
  it('names the table and base channels for table changes, the table channel for fields', () => {
    expect(schemaChangedDelivery.channels(schemaEnvelope('table', TBL))).toEqual([
      `table:${TBL}`,
      `base:${BSE}`,
    ]);
    expect(schemaChangedDelivery.channels(schemaEnvelope('field', FLD))).toEqual([`table:${TBL}`]);
  });

  it.each<[string, ReturnType<typeof schemaEnvelope>, Subscriber, boolean]>([
    [
      'visible field',
      schemaEnvelope('field', FLD),
      subscriber('t', access({ [TBL]: [FLD] })),
      true,
    ],
    [
      'no_perm field',
      schemaEnvelope('field', NO_PERM_FLD),
      subscriber('t', access({ [TBL]: [FLD] })),
      false,
    ],
    [
      'admin sees every field',
      schemaEnvelope('field', NO_PERM_FLD),
      subscriber('t', access({}, true)),
      true,
    ],
    [
      'hidden table',
      schemaEnvelope('table', HIDDEN, 'updated', HIDDEN),
      subscriber('b', access({ [TBL]: [] })),
      false,
    ],
    [
      'hidden table seen before, not a deletion',
      schemaEnvelope('table', HIDDEN, 'updated', HIDDEN),
      subscriber('b', access({ [TBL]: [] }), access({ [TBL]: [], [HIDDEN]: [] })),
      false,
    ],
    [
      'deletion of a table seen before the re-check',
      schemaEnvelope('table', HIDDEN, 'deleted', HIDDEN),
      subscriber('b', access({ [TBL]: [] }), access({ [TBL]: [], [HIDDEN]: [] })),
      true,
    ],
    [
      'deletion of a field seen before the re-check',
      schemaEnvelope('field', FLD, 'deleted'),
      subscriber('t', access({ [TBL]: [] }), access({ [TBL]: [FLD] })),
      true,
    ],
    ['no access at all', schemaEnvelope('field', FLD), subscriber('t', null), false],
  ])('%s', async (_name, envelope, target, delivered) => {
    const deliveries = await schemaChangedDelivery.deliver(envelope, [target]);
    expect(deliveries.length).toBe(delivered ? 1 : 0);
    if (delivered) {
      expect(deliveries[0]?.message).toEqual({
        type: 'schema.changed',
        channel: target.channel,
        entity: envelope.entity,
        entity_id: envelope.entity_id,
        action: envelope.action,
      });
    }
  });
});

describe('schemaChangedDelivery for views (T301)', () => {
  const VIW: Id<'viw'> = 'viw_A1b2C3d4E5f6G7h8';
  const OTHER_VIW: Id<'viw'> = 'viw_Z1b2C3d4E5f6G7h8';
  const viewEnvelope = (
    ownerId: Id<'usr'> | null,
    action: 'created' | 'updated' | 'deleted' = 'updated',
    viewId: Id<'viw'> = VIW,
  ) => ({ ...schemaEnvelope('table', viewId, action), entity: 'view' as const, owner_id: ownerId });
  /** Table access with `visible_views`. */
  function withViews(visible: readonly Id<'viw'>[] | null): BaseAccess {
    const base = access({ [TBL]: [FLD] });
    const table = base.access.tables[TBL] as unknown as Record<string, unknown>;
    table.view_rule = { allow_edit: false, visible_views: visible };
    return base;
  }

  it.each<[string, ReturnType<typeof viewEnvelope>, Subscriber, boolean]>([
    ['shared view, every view visible', viewEnvelope(null), subscriber('t', withViews(null)), true],
    ['shared view in visible_views', viewEnvelope(null), subscriber('t', withViews([VIW])), true],
    [
      'shared view outside visible_views',
      viewEnvelope(null),
      subscriber('t', withViews([OTHER_VIW])),
      false,
    ],
    ['admin sees every shared view', viewEnvelope(null), subscriber('t', access({}, true)), true],
    ['table hidden', viewEnvelope(null), subscriber('t', access({})), false],
    [
      'deleted view that was visible before the re-check',
      viewEnvelope(null, 'deleted'),
      subscriber('t', withViews([OTHER_VIW]), withViews([VIW])),
      true,
    ],
    [
      'updated view that was visible before the re-check',
      viewEnvelope(null, 'updated'),
      subscriber('t', withViews([OTHER_VIW]), withViews([VIW])),
      false,
    ],
    ['own personal view', viewEnvelope(USR), subscriber('t', withViews([])), true],
    [
      'personal view of someone else, even for an admin',
      viewEnvelope(OTHER_USR),
      subscriber('t', access({}, true)),
      false,
    ],
  ])('%s', async (_name, envelope, target, delivered) => {
    const deliveries = await schemaChangedDelivery.deliver(envelope, [target]);
    expect(deliveries.map((delivery) => delivery.message)).toEqual(
      delivered
        ? [
            {
              type: 'schema.changed',
              channel: target.channel,
              entity: 'view',
              entity_id: envelope.entity_id,
              action: envelope.action,
            },
          ]
        : [],
    );
  });
});

describe('jobProgressDelivery', () => {
  it('forwards to the creator only', async () => {
    const envelope = {
      v: 1,
      type: 'job.progress',
      organization_id: ORG,
      user_id: USR,
      job_id: 'job_A1b2C3d4E5f6G7h8',
      progress: 0.5,
      status: 'running',
    } as const;
    expect(jobProgressDelivery.channels(envelope)).toEqual([`user:${USR}`]);
    const mine = subscriber(`user:${USR}`, null);
    const deliveries = await jobProgressDelivery.deliver(envelope, [
      mine,
      subscriber(`user:${USR}`, null, null, OTHER_USR),
    ]);
    expect(deliveries).toEqual([
      {
        subscriber: mine,
        message: {
          type: 'job.progress',
          channel: `user:${USR}`,
          job_id: envelope.job_id,
          progress: 0.5,
          status: 'running',
        },
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Router

class FakeSocket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: RealtimeServerMessage[] = [];
  send(text: string): void {
    this.sent.push(JSON.parse(text) as RealtimeServerMessage);
  }
  ping(): void {}
  close(): void {
    this.readyState = WebSocket.CLOSED;
  }
  terminate(): void {
    this.readyState = WebSocket.CLOSED;
  }
}

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as AppLogger;

function setup(authorize: (channel: RealtimeChannel) => Promise<ChannelGrant | undefined>) {
  let handler: ((channel: string, message: string) => void) | undefined;
  const bus = {
    onMessage: (h: (channel: string, message: string) => void) => {
      handler = h;
    },
    acquire: () => Promise.resolve(false),
    release: () => undefined,
  } as unknown as RealtimeBusSubscriber;
  const registry = new SubscriptionRegistry(bus);
  const authorizer = {
    authorize: (_principal: Principal, channel: RealtimeChannel) => authorize(channel),
  } as unknown as ChannelAuthorizer;
  const router = new RealtimeRouter(
    bus,
    registry,
    authorizer,
    [schemaChangedDelivery, jobProgressDelivery],
    silentLogger,
  );
  const publish = (envelope: RealtimeEnvelope | string, org: Id<'org'> = ORG): void => {
    handler?.(
      orgBusChannel(org),
      typeof envelope === 'string' ? envelope : JSON.stringify(envelope),
    );
  };
  async function subscribe(
    channel: string,
    target: RealtimeChannel,
    base: BaseAccess | null,
    userId: Id<'usr'> = USR,
  ): Promise<{ socket: FakeSocket; subscription: Subscription }> {
    const socket = new FakeSocket();
    const connection = new RealtimeConnection(
      socket as unknown as WebSocket,
      { userId } as Principal,
      'token',
      () => 1024,
    );
    const subscription: Subscription = {
      connection,
      channel,
      target,
      userId,
      connectionId: connection.id,
      orgIds: [ORG],
      baseId: target.kind === 'user' ? null : BSE,
      base,
      previousBase: null,
      variables: null,
      view: null,
      tables: null,
      viewRequest: null,
    };
    await registry.add(subscription);
    return { socket, subscription };
  }
  return { router, registry, publish, subscribe, bus, authorizer };
}

/** Lets the router's queue drain. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('RealtimeRouter', () => {
  it('delivers to the subscribers of the named channels only', async () => {
    const { publish, subscribe } = setup(() => Promise.resolve(undefined));
    const table = await subscribe(
      `table:${TBL}`,
      { kind: 'table', id: TBL },
      access({ [TBL]: [FLD] }),
    );
    const base = await subscribe(
      `base:${BSE}`,
      { kind: 'base', id: BSE },
      access({ [TBL]: [FLD] }),
    );
    publish(schemaEnvelope('field', FLD));
    publish(schemaEnvelope('field', FLD), 'org_Z1b2C3d4E5f6G7h8');
    publish('{broken');
    await settle();
    expect(table.socket.sent).toEqual([
      {
        type: 'schema.changed',
        channel: `table:${TBL}`,
        entity: 'field',
        entity_id: FLD,
        action: 'updated',
      },
    ]);
    expect(base.socket.sent).toEqual([]);
  });

  it('re-checks subscriptions of the bases on permission.changed, before later envelopes', async () => {
    const grants = new Map<string, ChannelGrant | undefined>();
    const { publish, subscribe, registry } = setup(async (channel) => {
      await settle();
      return grants.get(`${channel.kind}:${channel.id}`);
    });
    const before = access({ [TBL]: [FLD], [HIDDEN]: [] });
    const after = access({ [TBL]: [FLD] });
    const base = await subscribe(`base:${BSE}`, { kind: 'base', id: BSE }, before);
    const table = await subscribe(`table:${HIDDEN}`, { kind: 'table', id: HIDDEN }, before);
    const user = await subscribe(`user:${USR}`, { kind: 'user', id: USR }, null);
    grants.set(`base:${BSE}`, {
      orgIds: [ORG],
      baseId: BSE,
      base: after,
      variables: null,
      view: null,
      tables: null,
    });
    grants.set(`table:${HIDDEN}`, undefined);
    grants.set(`user:${USR}`, {
      orgIds: [ORG],
      baseId: null,
      base: null,
      variables: null,
      view: null,
      tables: null,
    });

    publish({ v: 1, type: 'permission.changed', organization_id: ORG, base_ids: [BSE] });
    // Queued behind the re-check: filtered with the new access.
    publish(schemaEnvelope('table', HIDDEN, 'updated', HIDDEN));
    await settle();
    await settle();
    await settle();

    expect(base.socket.sent).toEqual([{ type: 'permission.changed', channel: `base:${BSE}` }]);
    expect(base.subscription.base).toBe(after);
    expect(base.subscription.previousBase).toBe(before);
    expect(table.socket.sent).toEqual([
      { type: 'error', req_id: null, code: 'NOT_FOUND', channel: `table:${HIDDEN}` },
    ]);
    expect(registry.has(table.subscription)).toBe(false);
    expect(user.socket.sent).toEqual([]);
    expect(registry.size).toBe(2);
  });

  it('removes a base subscription that lost access, after telling permission.changed', async () => {
    const { publish, subscribe, registry } = setup(() => Promise.resolve(undefined));
    const base = await subscribe(`base:${BSE}`, { kind: 'base', id: BSE }, access({}));
    publish({ v: 1, type: 'permission.changed', organization_id: ORG, base_ids: [BSE] });
    await settle();
    expect(base.socket.sent).toEqual([
      { type: 'permission.changed', channel: `base:${BSE}` },
      { type: 'error', req_id: null, code: 'NOT_FOUND', channel: `base:${BSE}` },
    ]);
    expect(registry.size).toBe(0);
  });

  it('fails closed when the re-check fails', async () => {
    const { publish, subscribe, registry } = setup(() => Promise.reject(new Error('db down')));
    const table = await subscribe(
      `table:${TBL}`,
      { kind: 'table', id: TBL },
      access({ [TBL]: [] }),
    );
    publish({ v: 1, type: 'permission.changed', organization_id: ORG, base_ids: [BSE] });
    await settle();
    expect(table.socket.sent).toEqual([
      { type: 'error', req_id: null, code: 'DEPENDENCY_UNAVAILABLE', channel: `table:${TBL}` },
    ]);
    expect(registry.size).toBe(0);
  });

  it('ignores other bases and counts permission epochs', async () => {
    const { router, publish, subscribe } = setup(() => Promise.resolve(undefined));
    const base = await subscribe(`base:${BSE}`, { kind: 'base', id: BSE }, access({}));
    const epoch = router.permissionEpoch;
    publish({
      v: 1,
      type: 'permission.changed',
      organization_id: ORG,
      base_ids: ['bse_Z1b2C3d4E5f6G7h8'],
    });
    await settle();
    expect(router.permissionEpoch).toBe(epoch + 1);
    expect(base.socket.sent).toEqual([]);
  });
});

describe('fieldConvertingDelivery (T403)', () => {
  const envelope = (fieldId: Id<'fld'>) =>
    ({
      v: 1,
      type: 'field.converting',
      organization_id: ORG,
      base_id: BSE,
      table_id: TBL,
      field_id: fieldId,
      job_id: 'job_A1b2C3d4E5f6G7h8',
      status: 'running',
      progress: 0.4,
      from_type: 'text',
      to_type: 'number',
      actor_id: OTHER_USR,
    }) as const;

  it('reaches table and base subscribers who see the field, never a no_perm field', () => {
    expect(fieldConvertingDelivery.channels(envelope(FLD))).toEqual([
      `table:${TBL}`,
      `base:${BSE}`,
    ]);
    const visible = subscriber(`base:${BSE}`, access({ [TBL]: [FLD] }));
    const hidden = subscriber(`table:${TBL}`, access({ [TBL]: [] }));
    expect(fieldConvertingDelivery.deliver(envelope(FLD), [visible, hidden])).toEqual([
      {
        subscriber: visible,
        message: {
          type: 'field.converting',
          channel: `base:${BSE}`,
          field_id: FLD,
          job_id: 'job_A1b2C3d4E5f6G7h8',
          status: 'running',
          progress: 0.4,
          from_type: 'text',
          to_type: 'number',
          actor_id: OTHER_USR,
        },
      },
    ]);
    expect(fieldConvertingDelivery.deliver(envelope(NO_PERM_FLD), [visible])).toEqual([]);
  });
});

describe('RealtimeRouter: api_token.revoked (T706)', () => {
  const TOK: Id<'tok'> = 'tok_A1b2C3d4E5f6G7h8';

  it('hands api_token.revoked to the gateway at once, outside the organization queue', async () => {
    const { router, publish, subscribe } = setup(() => Promise.resolve(undefined));
    const received: unknown[] = [];
    router.onApiTokenRevoked((envelope) => received.push(envelope));
    const table = await subscribe(`table:${TBL}`, { kind: 'table', id: TBL }, access({}));
    const revoked: RealtimeEnvelope = {
      v: 1,
      type: 'api_token.revoked',
      organization_id: ORG,
      token_ids: [TOK],
    };
    publish(revoked);
    // Synchronous: no wait for the queue.
    expect(received).toEqual([revoked]);
    publish({ v: 1, type: 'api_token.revoked', organization_id: ORG });
    expect(received).toHaveLength(2);
    // An envelope arriving on another organization's channel is ignored.
    publish(revoked, 'org_Z1b2C3d4E5f6G7h8');
    expect(received).toHaveLength(2);
    await settle();
    // Nothing reaches subscribers.
    expect(table.socket.sent).toEqual([]);
  });
});

describe('RealtimeRouter: user channels', () => {
  const OTHER_ORG: Id<'org'> = 'org_Z1b2C3d4E5f6G7h8';
  const userGrant = (orgIds: readonly Id<'org'>[]): ChannelGrant => ({
    orgIds,
    baseId: null,
    base: null,
    variables: null,
    view: null,
    tables: null,
  });

  it('stops feeding user:<id> from an organization the user left, on permission.changed', async () => {
    let orgIds: readonly Id<'org'>[] = [ORG, OTHER_ORG];
    const { publish, subscribe, registry } = setup(() => Promise.resolve(userGrant(orgIds)));
    const user = await subscribe(`user:${USR}`, { kind: 'user', id: USR }, null);
    // Held on both organizations' buses.
    user.subscription.orgIds = [ORG, OTHER_ORG];
    registry.remove(user.subscription);
    await registry.add(user.subscription);
    const job = (org: Id<'org'>) =>
      ({
        v: 1,
        type: 'job.progress',
        organization_id: org,
        user_id: USR,
        job_id: 'job_A1b2C3d4E5f6G7h8',
        progress: 0.5,
        status: 'running',
      }) as const;

    // Removed from ORG: membership changes bump every base of ORG.
    orgIds = [OTHER_ORG];
    publish({ v: 1, type: 'permission.changed', organization_id: ORG, base_ids: [BSE] });
    await settle();
    publish(job(ORG), ORG);
    publish(job(OTHER_ORG), OTHER_ORG);
    await settle();

    expect(registry.has(user.subscription)).toBe(true);
    expect(user.subscription.orgIds).toEqual([OTHER_ORG]);
    expect(registry.subscribers(ORG, `user:${USR}`)).toEqual([]);
    // Only OTHER_ORG's message arrives, and nothing tells about the re-check.
    expect(user.socket.sent).toEqual([
      {
        type: 'job.progress',
        channel: `user:${USR}`,
        job_id: 'job_A1b2C3d4E5f6G7h8',
        progress: 0.5,
        status: 'running',
      },
    ]);
  });
});

describe('RealtimeGateway: subscribing again', () => {
  interface GatewaySubscribe {
    subscribe(
      connection: RealtimeConnection,
      channel: string,
      reqId: string,
      view: null,
    ): Promise<void>;
  }

  it('never keeps a grant computed before a permission change handled meanwhile', async () => {
    const wide = access({ [TBL]: [FLD, NO_PERM_FLD] });
    const narrow = access({ [TBL]: [FLD] });
    const grantOf = (base: BaseAccess): ChannelGrant => ({
      orgIds: [ORG],
      baseId: BSE,
      base,
      variables: null,
      view: null,
      tables: null,
    });
    let current = wide;
    let race = false;
    let publishLater: () => void = () => undefined;
    const { router, registry, publish, bus, authorizer } = setup(async () => {
      const stale = grantOf(current);
      if (race) {
        race = false;
        // A field is revoked while this grant is in flight; the router
        // re-checks the subscription before the stale grant comes back.
        current = narrow;
        publishLater();
        await settle();
        await settle();
      }
      return stale;
    });
    publishLater = () => {
      publish({ v: 1, type: 'permission.changed', organization_id: ORG, base_ids: [BSE] });
    };
    const gateway = new RealtimeGateway(
      { httpAdapter: null } as unknown as ConstructorParameters<typeof RealtimeGateway>[0],
      config(),
      {} as ConstructorParameters<typeof RealtimeGateway>[2],
      {} as ConstructorParameters<typeof RealtimeGateway>[3],
      {} as ConstructorParameters<typeof RealtimeGateway>[4],
      new RealtimeLimits(),
      authorizer,
      registry,
      router,
      bus,
      silentLogger,
    ) as unknown as GatewaySubscribe;
    const socket = new FakeSocket();
    const connection = new RealtimeConnection(
      socket as unknown as WebSocket,
      { kind: 'session', userId: USR } as unknown as Principal,
      'token',
      () => 1024,
    );
    const channel = `table:${TBL}`;
    await gateway.subscribe(connection, channel, 'first', null);
    expect(connection.subscriptions.get(channel)?.base).toBe(wide);

    race = true;
    await gateway.subscribe(connection, channel, 'again', null);
    await settle();
    const subscription = connection.subscriptions.get(channel);
    expect(subscription === undefined ? undefined : registry.has(subscription)).toBe(true);
    expect(subscription?.base).toBe(narrow);
    expect(socket.sent).toContainEqual({ type: 'subscribed', req_id: 'again', channel });
  });
});
