import {
  recordListResponseSchema,
  recordsResponseSchema,
  type Id,
  type RealtimeServerMessage,
  type RecordDto,
} from '@cellhive/contracts';
import {
  BaseRoleMembersRepository,
  BaseRolesRepository,
  orgScope,
  SchemaService,
  systemAuditContext,
  type Db,
  type JsonObject,
} from '@cellhive/server-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import { buildRecordFixture, type RecordFixture } from './record-fixture.js';
import { startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { RoleConfigInput } from '@cellhive/permissions';
import type { LightMyRequestResponse } from 'fastify';

type Message = RealtimeServerMessage;

/**
 * A read rule that uses `current_user_groups` depends on the membership of
 * the user's groups, even when the user holds the role directly: changing a
 * group's members bumps `permission_version` of such bases, so realtime
 * subscribers are re-checked with the new membership (SPEC §14.1, §15).
 *
 * U (`u_out`) has a direct custom role on base B2 that reads Notes owned by
 * members of U's groups; U is the only member of group G2. V (`u_reader`)
 * owns a note in B2 and has no role there.
 */
describe('group membership changes and current_user_groups (realtime)', () => {
  let database: TestDatabase;
  let db: Db;
  let app: TestApp;
  let url: string;
  let fx: RecordFixture;
  let b2: Id<'bse'>;
  let notes: Id<'tbl'>;
  let noteTitle: Id<'fld'>;
  let noteOwner: Id<'fld'>;
  let g2: Id<'grp'>;
  let vNote: Id<'rec'>;
  let channel: string;
  const sockets: TestSocket[] = [];

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    app = await startTestApp({ DATABASE_URL: database.url });
    url = await listen(app.app);
    fx = await buildRecordFixture(app, db);
    const scope = orgScope(fx.orgId);

    const workspace = await fx.call('owner', 'POST', `/orgs/${fx.orgId}/workspaces`, {
      name: 'Notes',
    });
    expect(workspace.statusCode, workspace.body).toBe(201);
    const base = await fx.call(
      'owner',
      'POST',
      `/workspaces/${workspace.json<{ id: Id<'wsp'> }>().id}/bases`,
      { name: 'B2' },
    );
    expect(base.statusCode, base.body).toBe(201);
    b2 = base.json<{ id: Id<'bse'> }>().id;

    const schema = app.app.get(SchemaService);
    const context = systemAuditContext();
    const created = await schema.createTable(
      scope,
      { baseId: b2, name: 'Notes', primaryFieldName: 'title' },
      context,
    );
    notes = created.table.id;
    noteTitle = created.primaryField.id;
    noteOwner = (
      await schema.addField(
        scope,
        notes,
        { name: 'owner', type: 'user', options: { multiple: false } },
        context,
      )
    ).id;

    const config: RoleConfigInput = {
      tables: {
        [notes]: {
          perm: 'read_only',
          record_rule: {
            read_scope: 'filter',
            read_filter: {
              op: 'and',
              items: [
                {
                  field: noteOwner,
                  operator: 'has_any_of',
                  value: [{ $var: 'current_user_groups' }],
                },
              ],
            },
          },
          field_rule: { mode: 'all_read' },
        },
      },
    };
    const role = await new BaseRolesRepository(db).create(scope, {
      baseId: b2,
      name: 'Team notes',
      kind: 'custom',
      config: config as unknown as JsonObject,
    });
    await new BaseRoleMembersRepository(db).assign(scope, {
      baseId: b2,
      roleId: role.id,
      principalType: 'user',
      principalId: fx.users.u_out.id,
    });

    const group = await fx.call('owner', 'POST', `/orgs/${fx.orgId}/groups`, { name: 'G2' });
    expect(group.statusCode, group.body).toBe(201);
    g2 = group.json<{ id: Id<'grp'> }>().id;
    expect((await addMember('u_out')).statusCode).toBe(201);

    const [note] = records(
      await fx.call('owner', 'POST', notesUrl(), {
        records: [
          {
            fields: {
              [noteTitle]: 'V note',
              [noteOwner]: [{ id: fx.users.u_reader.id }],
            },
          },
        ],
      }),
    );
    vNote = note?.id as Id<'rec'>;
    channel = `table:${notes}`;
  });

  afterAll(async () => {
    await closeSockets(sockets);
    await app.close();
    await db.destroy();
    await database.drop();
  });

  const notesUrl = () => `/tables/${notes}/records?field_key_type=id`;
  const addMember = (user: 'u_out' | 'u_reader') =>
    fx.call('owner', 'POST', `/groups/${g2}/members`, { user_id: fx.users[user].id });

  function records(response: LightMyRequestResponse): RecordDto[] {
    expect(response.statusCode, response.body).toBeLessThan(300);
    return recordsResponseSchema.parse(response.json()).records;
  }

  async function permissionVersion(baseId: Id<'bse'>): Promise<bigint> {
    const row = await db.kysely
      .selectFrom('meta.bases')
      .select('permission_version')
      .where('id', '=', baseId)
      .executeTakeFirstOrThrow();
    return row.permission_version;
  }

  async function visibleNotes(): Promise<Id<'rec'>[]> {
    const response = await fx.call('u_out', 'GET', notesUrl());
    expect(response.statusCode, response.body).toBe(200);
    return recordListResponseSchema.parse(response.json()).records.map((record) => record.id);
  }

  const aboutNote = (message: Message): boolean =>
    ('record_id' in message && message.record_id === vNote) ||
    ('record_ids' in message && message.record_ids.includes(vNote));

  const renameNote = async (title: string) =>
    records(
      await fx.call('owner', 'PATCH', notesUrl(), {
        records: [{ id: vNote, fields: { [noteTitle]: title } }],
      }),
    );

  it('adding V to U’s group bumps B2 and re-checks U’s subscription; V’s note then reaches U', async () => {
    const socket = await TestSocket.connect(url, {
      origin: TEST_PUBLIC_URL,
      cookie: await fx.cookie('u_out'),
    });
    sockets.push(socket);
    expect(await socket.subscribe(channel)).toMatchObject({ type: 'subscribed' });
    expect(await socket.subscribe(`base:${b2}`)).toMatchObject({ type: 'subscribed' });
    expect(await visibleNotes()).toEqual([]);
    await renameNote('hidden edit');
    await socket.expectNone(aboutNote);

    const before = await permissionVersion(b2);
    const untouched = await permissionVersion(fx.baseId);
    expect((await addMember('u_reader')).statusCode).toBe(201);
    expect(await permissionVersion(b2)).toBe(before + 1n);
    // The fixture base has no role using current_user_groups and G2 has no role there.
    expect(await permissionVersion(fx.baseId)).toBe(untouched);
    // The client of `base:` learns that access changed; `table:` is re-checked in place.
    expect(await socket.next((message) => message.type === 'permission.changed')).toEqual({
      type: 'permission.changed',
      channel: `base:${b2}`,
    });

    expect(await visibleNotes()).toEqual([vNote]);
    await renameNote('visible edit');
    expect(
      await socket.next((message) => message.type === 'record.updated' && aboutNote(message)),
    ).toMatchObject({ record_id: vNote, fields: { [noteTitle]: 'visible edit' } });
  });

  it('removing V from the group hides V’s note again', async () => {
    const socket = await TestSocket.connect(url, {
      origin: TEST_PUBLIC_URL,
      cookie: await fx.cookie('u_out'),
    });
    sockets.push(socket);
    expect(await socket.subscribe(channel)).toMatchObject({ type: 'subscribed' });
    expect(await socket.subscribe(`base:${b2}`)).toMatchObject({ type: 'subscribed' });

    const before = await permissionVersion(b2);
    const removed = await fx.call(
      'owner',
      'DELETE',
      `/groups/${g2}/members/${fx.users.u_reader.id}`,
    );
    expect(removed.statusCode, removed.body).toBe(204);
    expect(await permissionVersion(b2)).toBe(before + 1n);
    await socket.next((message) => message.type === 'permission.changed');

    expect(await visibleNotes()).toEqual([]);
    await renameNote('hidden again');
    await socket.expectNone(aboutNote);
  });

  it('deleting a group bumps bases whose roles use current_user_groups', async () => {
    const before = await permissionVersion(b2);
    const deleted = await fx.call('owner', 'DELETE', `/orgs/${fx.orgId}/groups/${g2}`);
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect(await permissionVersion(b2)).toBe(before + 1n);
  });
});
