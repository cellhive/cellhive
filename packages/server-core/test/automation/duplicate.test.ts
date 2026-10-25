import { Readable } from 'node:stream';

import {
  automationDefinitionSchema,
  MAX_AUTOMATION_NAME_LENGTH,
  type AutomationDefinition,
  type AutomationDefinitionInput,
  type Id,
} from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  DUPLICATE_NAME_SUFFIXES,
  duplicateAutomationName,
  emailAssetReferencesOf,
  replaceEmailAssetIds,
} from '../../src/automation/index.js';
import { orgScope } from '../../src/db/index.js';
import {
  stageEmailAssetCopies,
  type StageEmailAssetCopiesDeps,
} from '../../src/mail/images/index.js';

import type { EmailAssetRow } from '../../src/db/schema.js';

const ORDERS: Id<'tbl'> = 'tbl_OrdersTable00001';
const A1: Id<'att'> = 'att_SourceImage00001';
const A2: Id<'att'> = 'att_SourceImage00002';
const A3: Id<'att'> = 'att_SourceImage00003';
const C1: Id<'att'> = 'att_CopiedImage00001';
const C2: Id<'att'> = 'att_CopiedImage00002';
const FIELD: Id<'fld'> = 'fld_OrdersPhotos0001';

function sendEmail(id: string, template: string) {
  return {
    id,
    type: 'send_email' as const,
    config: {
      to: [{ literal: 'khach@partner.test' }],
      subject: { template: `Báo cáo asset:${A1}` },
      body: { format: 'markdown' as const, template },
    },
  };
}

function definitionOf(actions: AutomationDefinitionInput['actions']): AutomationDefinition {
  return automationDefinitionSchema.parse({
    trigger: { type: 'record.created', table_id: ORDERS },
    condition: null,
    actions,
  });
}

describe('duplicateAutomationName (T551)', () => {
  const long = 'Đ'.repeat(MAX_AUTOMATION_NAME_LENGTH);
  const emoji = '😀'.repeat(200);
  it.each([
    ['vi', 'Báo khi đơn xong', 'Báo khi đơn xong (bản sao)'],
    ['vi-VN', 'Báo khi đơn xong', 'Báo khi đơn xong (bản sao)'],
    ['VI_vn', 'Báo', 'Báo (bản sao)'],
    ['en', 'Notify on done', 'Notify on done (copy)'],
    ['en-US', 'Notify', 'Notify (copy)'],
    [null, 'Notify', 'Notify (copy)'],
    [undefined, 'Notify', 'Notify (copy)'],
    ['fr', 'Notifier', 'Notifier (copy)'],
    ['video', 'Not a language', 'Not a language (copy)'],
    ['en', '  spaced  ', 'spaced (copy)'],
  ])('%s: %j → %j', (locale, name, expected) => {
    expect(duplicateAutomationName(name, locale)).toBe(expected);
  });

  it.each([
    ['vi', long, DUPLICATE_NAME_SUFFIXES.vi],
    ['en', long, DUPLICATE_NAME_SUFFIXES.en],
  ])('cuts a long name so the copy stays within the limit (%s)', (locale, name, suffix) => {
    const copy = duplicateAutomationName(name, locale);
    expect(copy.length).toBe(MAX_AUTOMATION_NAME_LENGTH);
    expect(copy.endsWith(suffix)).toBe(true);
    expect(copy.startsWith('ĐĐĐ')).toBe(true);
  });

  it('never splits a character made of two UTF-16 units, nor keeps a trailing space', () => {
    const copy = duplicateAutomationName(emoji, 'en');
    expect(copy.length).toBeLessThanOrEqual(MAX_AUTOMATION_NAME_LENGTH);
    expect(copy.endsWith(' (copy)')).toBe(true);
    expect(Array.from(copy.slice(0, -' (copy)'.length)).every((char) => char === '😀')).toBe(true);
    const spaced = duplicateAutomationName(`${'a'.repeat(247)} b`, 'en');
    expect(spaced).toBe(`${'a'.repeat(247)} (copy)`);
  });
});

describe('emailAssetReferencesOf (T551)', () => {
  it.each([
    ['no send_email step', definitionOf([]), []],
    [
      'one step, each asset once, field images left out',
      definitionOf([
        sendEmail(
          'act_mail',
          `![a](asset:${A1})\n![b](asset:${A2} =160) ![a again](asset:${A1}) ![f](field:${FIELD})`,
        ),
      ]),
      [
        { assetId: A1, path: 'definition.actions[0].config.body.template' },
        { assetId: A2, path: 'definition.actions[0].config.body.template' },
      ],
    ],
    [
      'steps inside an if branch; an id outside image syntax is not an image',
      definitionOf([
        sendEmail('act_first', `plain asset:${A3} and \`code\``),
        {
          id: 'act_if',
          type: 'if',
          config: {
            conditions: [{ value: { literal: 1 }, operator: 'is_not_empty' }],
            then: [sendEmail('act_then', `![t](asset:${A3})`)],
            else: [sendEmail('act_else', `![e](asset:${A1})`)],
          },
        },
      ]),
      [
        { assetId: A3, path: 'definition.actions[1].config.then[0].config.body.template' },
        { assetId: A1, path: 'definition.actions[1].config.else[0].config.body.template' },
      ],
    ],
  ])('%s', (_label, definition, expected) => {
    expect(emailAssetReferencesOf(definition)).toEqual(expected);
  });
});

describe('replaceEmailAssetIds (T551)', () => {
  const mapping = new Map<Id<'att'>, Id<'att'>>([
    [A1, C1],
    [A2, C2],
  ]);

  it.each([
    [`![a](asset:${A1})`, `![a](asset:${C1})`],
    [`![a](asset:${A1} =160)![b](asset:${A2})`, `![a](asset:${C1} =160)![b](asset:${C2})`],
    // Not in the mapping: kept as it is.
    [`![c](asset:${A3})`, `![c](asset:${A3})`],
    // A longer id that starts with a mapped one is another id.
    [`asset:${A1}X`, `asset:${A1}X`],
    // Without `asset:` the id is not an image reference.
    [A1, A1],
    [`![f](field:${FIELD})`, `![f](field:${FIELD})`],
  ])('%j → %j', (template, expected) => {
    const definition = definitionOf([sendEmail('act_mail', template)]);
    const copy = replaceEmailAssetIds(definition, mapping);
    const action = copy.actions[0];
    expect(action?.type === 'send_email' ? action.config.body.template : null).toBe(expected);
  });

  it('replaces in every string, nested steps included, and leaves the input unchanged', () => {
    const definition = definitionOf([
      {
        id: 'act_if',
        type: 'if',
        config: {
          conditions: [{ value: { literal: 1 }, operator: 'is_not_empty' }],
          then: [sendEmail('act_then', `![t](asset:${A2})`)],
        },
      },
      sendEmail('act_mail', `![a](asset:${A1})`),
    ]);
    const before = JSON.stringify(definition);
    const copy = replaceEmailAssetIds(definition, mapping);
    expect(JSON.stringify(definition)).toBe(before);
    const text = JSON.stringify(copy);
    expect(text).not.toContain(A1);
    expect(text).not.toContain(A2);
    expect(text).toContain(`asset:${C1}`);
    expect(text).toContain(`asset:${C2}`);
    // The rest is untouched.
    expect(JSON.stringify(replaceEmailAssetIds(copy, new Map()))).toBe(text);
    expect(automationDefinitionSchema.parse(copy)).toEqual(copy);
  });
});

function sourceRow(id: Id<'att'>, size = 3): EmailAssetRow {
  return {
    id,
    organization_id: 'org_DuplicateOrg0001',
    kind: 'automation',
    automation_id: 'aut_DuplicateSource1',
    object_key: `org_DuplicateOrg0001/${id}`,
    filename: 'ảnh.png',
    mime: 'image/png',
    size: BigInt(size),
    width: 4,
    height: 2,
    sha256: 'a'.repeat(64),
    status: 'ready',
    created_by: 'usr_DuplicateUser001',
    created_at: new Date(),
    updated_at: new Date(),
  } as unknown as EmailAssetRow;
}

/** In-memory rows and objects; `failPutAt` makes the n-th `putStream` (1-based) throw. */
function fakes(options: { failPutAt?: number; failDelete?: boolean; missing?: string[] } = {}) {
  const rows = new Map<string, EmailAssetRow>();
  const objects = new Map<string, string>([
    ['org_DuplicateOrg0001/att_SourceImage00001', 'one'],
    ['org_DuplicateOrg0001/att_SourceImage00002', 'two'],
  ]);
  for (const key of options.missing ?? []) objects.delete(key);
  let copies = 0;
  let puts = 0;
  const deps: StageEmailAssetCopiesDeps = {
    assets: {
      insertCopy: (_scope, source, createdBy) => {
        copies += 1;
        const id = `att_CopiedImage0000${String(copies)}` as Id<'att'>;
        const row = {
          ...source,
          id,
          automation_id: null,
          object_key: `org_DuplicateOrg0001/${id}`,
          created_by: createdBy,
        } as EmailAssetRow;
        rows.set(id, row);
        return Promise.resolve(row);
      },
      deleteByIds: (_scope, ids) => {
        for (const id of ids) rows.delete(id);
        return Promise.resolve(ids.length);
      },
    },
    storage: {
      getStream: (key) => {
        const body = objects.get(key);
        return Promise.resolve(body === undefined ? null : Readable.from([Buffer.from(body)]));
      },
      putStream: async (key, body, put) => {
        puts += 1;
        if (puts === options.failPutAt) throw new Error('storage down');
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(chunk as Buffer);
        objects.set(key, Buffer.concat(chunks).toString());
        return {
          size: put.contentLength,
          contentType: put.contentType,
          etag: null,
          lastModified: null,
        };
      },
      delete: (key) => {
        if (options.failDelete === true) return Promise.reject(new Error('storage down'));
        objects.delete(key);
        return Promise.resolve();
      },
    },
  };
  return { deps, rows, objects };
}

describe('stageEmailAssetCopies (T551)', () => {
  const scope = orgScope('org_DuplicateOrg0001');
  const createdBy: Id<'usr'> = 'usr_DuplicateCaller1';

  it('copies each source once: a new unattached row, then its object', async () => {
    const { deps, rows, objects } = fakes();
    const result = await stageEmailAssetCopies(deps, scope, {
      sources: [sourceRow(A1), sourceRow(A2), sourceRow(A1)],
      createdBy,
    });
    if (!result.ok) throw new Error('expected copies');
    expect([...result.staged.mapping]).toEqual([
      [A1, C1],
      [A2, C2],
    ]);
    expect(result.staged.ids).toEqual([C1, C2]);
    expect([...rows.values()].map((row) => [row.id, row.automation_id, row.created_by])).toEqual([
      [C1, null, createdBy],
      [C2, null, createdBy],
    ]);
    expect(objects.get(`org_DuplicateOrg0001/${C1}`)).toBe('one');
    expect(objects.get(`org_DuplicateOrg0001/${C2}`)).toBe('two');
    // The sources are untouched.
    expect(objects.get(`org_DuplicateOrg0001/${A1}`)).toBe('one');

    expect(await result.staged.discard()).toBe(true);
    expect(rows.size).toBe(0);
    expect(objects.has(`org_DuplicateOrg0001/${C1}`)).toBe(false);
    expect(objects.get(`org_DuplicateOrg0001/${A2}`)).toBe('two');
  });

  it('copies nothing for no source', async () => {
    const { deps, rows } = fakes();
    const result = await stageEmailAssetCopies(deps, scope, { sources: [], createdBy });
    expect(result.ok && result.staged.ids).toEqual([]);
    expect(rows.size).toBe(0);
  });

  it('a source object gone from storage: reports it and keeps nothing', async () => {
    const { deps, rows, objects } = fakes({ missing: [`org_DuplicateOrg0001/${A2}`] });
    const result = await stageEmailAssetCopies(deps, scope, {
      sources: [sourceRow(A1), sourceRow(A2)],
      createdBy,
    });
    expect(result).toEqual({ ok: false, missing: A2 });
    expect(rows.size).toBe(0);
    expect([...objects.keys()]).toEqual([`org_DuplicateOrg0001/${A1}`]);
  });

  it('a storage failure: discards what was staged and rethrows', async () => {
    const { deps, rows, objects } = fakes({ failPutAt: 2 });
    await expect(
      stageEmailAssetCopies(deps, scope, {
        sources: [sourceRow(A1), sourceRow(A2)],
        createdBy,
      }),
    ).rejects.toThrow('storage down');
    expect(rows.size).toBe(0);
    expect([...objects.keys()].sort()).toEqual([
      `org_DuplicateOrg0001/${A1}`,
      `org_DuplicateOrg0001/${A2}`,
    ]);
  });

  it('discard reports what it could not delete (left for the cleanup)', async () => {
    const { deps, rows } = fakes({ failDelete: true });
    const result = await stageEmailAssetCopies(deps, scope, {
      sources: [sourceRow(A1)],
      createdBy,
    });
    if (!result.ok) throw new Error('expected copies');
    expect(await result.staged.discard()).toBe(false);
    // The row stays, unattached: `attachments.cleanup` deletes it with its object.
    expect([...rows.values()].map((row) => row.automation_id)).toEqual([null]);
  });
});
