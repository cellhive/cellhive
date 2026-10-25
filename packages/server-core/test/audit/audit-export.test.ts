import { describe, expect, it } from 'vitest';

import {
  auditCsvLine,
  auditExportKey,
  auditFilterOf,
  csvCell,
  exportDownloadPath,
  type AuditLogRow,
} from '../../src/audit/index.js';
import { decodeCursor, encodeCursor } from '../../src/db/index.js';
import { AppError } from '../../src/errors/index.js';

describe('csvCell', () => {
  it.each([
    [null, ''],
    ['plain', 'plain'],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['line\nbreak', '"line\nbreak"'],
    ['=SUM(A1)', "'=SUM(A1)"],
    ['+1', "'+1"],
    ['-1', '-1'],
    ['-1.500.000', '-1.500.000'],
    ['-1.500.000 ₫', "'-1.500.000 ₫"],
    ["-2+3+cmd|' /C calc'!A0", `'-2+3+cmd|' /C calc'!A0`],
    ['@cmd', "'@cmd"],
    ['=a,b', `"'=a,b"`],
    ['Nguyễn Văn Ánh', 'Nguyễn Văn Ánh'],
  ])('%j → %j', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });
});

describe('auditCsvLine', () => {
  it('writes every column, JSON for via/before/after', () => {
    const row: AuditLogRow = {
      id: 'aud_A1b2C3d4E5f6G7h8',
      organization_id: 'org_A1b2C3d4E5f6G7h8',
      base_id: null,
      table_id: 'tbl_A1b2C3d4E5f6G7h8',
      actor_type: 'user',
      actor_id: 'usr_A1b2C3d4E5f6G7h8',
      actor_name: 'An',
      actor_view_id: null,
      via: { reverted_from: 'aud_B1b2C3d4E5f6G7h8' },
      action: 'record.updated',
      entity_type: 'record',
      entity_id: 'rec_A1b2C3d4E5f6G7h8',
      batch_id: null,
      request_id: null,
      before: { fld_A1b2C3d4E5f6G7h8: 'x' },
      after: null,
      ip: '203.0.113.1',
      user_agent: null,
      created_at: new Date('2026-09-23T03:15:00.000Z'),
      cursor_at: '2026-09-23T03:15:00.000000Z',
    };
    expect(auditCsvLine(row)).toBe(
      [
        'aud_A1b2C3d4E5f6G7h8',
        '2026-09-23T03:15:00.000Z',
        'user',
        'usr_A1b2C3d4E5f6G7h8',
        'An',
        '"{""reverted_from"":""aud_B1b2C3d4E5f6G7h8""}"',
        'record.updated',
        'record',
        'rec_A1b2C3d4E5f6G7h8',
        '',
        'tbl_A1b2C3d4E5f6G7h8',
        '',
        '',
        '"{""fld_A1b2C3d4E5f6G7h8"":""x""}"',
        '',
        '203.0.113.1',
        '',
      ].join(','),
    );
  });
});

describe('export helpers', () => {
  it('keys and paths never contain user input', () => {
    expect(auditExportKey('org_A1b2C3d4E5f6G7h8', 'job_A1b2C3d4E5f6G7h8')).toBe(
      'org_A1b2C3d4E5f6G7h8/audit-export-job_A1b2C3d4E5f6G7h8.csv',
    );
    expect(exportDownloadPath('job_A1b2C3d4E5f6G7h8')).toBe(
      '/api/v1/files/exports/job_A1b2C3d4E5f6G7h8',
    );
  });

  it.each([
    [
      'a single value (queued before T709)',
      { actor_id: 'usr_A1b2C3d4E5f6G7h8', from: '2026-09-01T00:00:00.000Z' },
      { actorIds: ['usr_A1b2C3d4E5f6G7h8'], from: new Date('2026-09-01T00:00:00.000Z') },
    ],
    [
      'lists, groups and sources',
      {
        actor_id: ['usr_A1b2C3d4E5f6G7h8', 'usr_B1b2C3d4E5f6G7h8'],
        action: ['record.updated'],
        action_prefix: ['record.', 'field.'] as const,
        via: ['api_token'] as const,
        base_id: 'bse_A1b2C3d4E5f6G7h8' as const,
      },
      {
        actorIds: ['usr_A1b2C3d4E5f6G7h8', 'usr_B1b2C3d4E5f6G7h8'],
        actions: ['record.updated'],
        actionPrefixes: ['record.', 'field.'],
        via: ['api_token'],
        baseId: 'bse_A1b2C3d4E5f6G7h8',
      },
    ],
  ])('maps stored filters to repository filters: %s', (_name, stored, expected) => {
    expect(auditFilterOf(stored)).toEqual(expected);
  });
});

describe('keyset cursor', () => {
  const cursor = { at: '2026-09-23T03:15:00.123456Z', id: 'aud_A1b2C3d4E5f6G7h8' };

  it('round-trips', () => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(decodeCursor(undefined)).toBeNull();
  });

  it.each([
    ['not base64url!'],
    [Buffer.from('not json').toString('base64url')],
    [Buffer.from(JSON.stringify({ at: cursor.at })).toString('base64url')],
    [Buffer.from(JSON.stringify(['2026-09-23', cursor.id])).toString('base64url')],
    [Buffer.from(JSON.stringify([cursor.at, "x'; DROP"])).toString('base64url')],
    ['a'.repeat(500)],
  ])('rejects %j with 422 VALIDATION_FAILED', (value) => {
    let error: unknown;
    try {
      decodeCursor(value);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'cursor', code: 'INVALID_FORMAT' }],
    });
  });
});
