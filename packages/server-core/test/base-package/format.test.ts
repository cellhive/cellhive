import { describe, expect, it } from 'vitest';

import {
  basePackageLimits,
  classifyEntry,
  dataEntry,
  DEFAULT_BASE_PACKAGE_LIMITS,
  fileEntry,
  invalidPackage,
  isInvalidPackage,
  isPackageId,
  jsonNestsDeeperThan,
  linksEntry,
  MAX_PACKAGE_PROBLEMS,
  exceedsEntryRatio,
  maxEntryRatioOf,
  maxUncompressedBytes,
  packageIdPrefixOf,
  packageLinePath,
  packagePath,
  PackageProblems,
  packageTooLarge,
} from '../../src/base-package/index.js';
import { AppError } from '../../src/errors/app-error.js';

describe('entries allowlist (T1016)', () => {
  it.each([
    ['manifest.json', { kind: 'manifest' }],
    ['schema/base.json', { kind: 'schema', name: 'base' }],
    ['schema/automations.json', { kind: 'schema', name: 'automations' }],
    ['files/attachments.json', { kind: 'attachments' }],
    ['data/tbl_0123456789abcdef.ndjson', { kind: 'data', tableId: 'tbl_0123456789abcdef' }],
    ['links/fld_0123456789abcdef.ndjson', { kind: 'links', fieldId: 'fld_0123456789abcdef' }],
    ['files/att_0123456789abcdef', { kind: 'file', attachmentId: 'att_0123456789abcdef' }],
  ])('%s is allowed', (name, kind) => {
    expect(classifyEntry(name)).toEqual(kind);
  });

  it.each([
    'manifest.JSON',
    '/manifest.json',
    './manifest.json',
    'schema/other.json',
    'schema/base.json/',
    'data/tbl_0123456789abcde.ndjson',
    'data/tbl_0123456789abcdef.ndjson.gz',
    'data/fld_0123456789abcdef.ndjson',
    'links/fld_0123456789abcdef.json',
    'files/att_0123456789abcdef.exe',
    'files/att_0123456789abcd-f',
    'files/../manifest.json',
    'files\\att_0123456789abcdef',
    'files/att_0123456789abcdef\n',
    'files/att_０123456789abcdef',
    '',
  ])('%j is not', (name) => {
    expect(classifyEntry(name)).toBeNull();
  });

  it('builds the names of data, links and files', () => {
    expect(dataEntry('tbl_0123456789abcdef')).toBe('data/tbl_0123456789abcdef.ndjson');
    expect(linksEntry('fld_0123456789abcdef')).toBe('links/fld_0123456789abcdef.ndjson');
    expect(fileEntry('att_0123456789abcdef')).toBe('files/att_0123456789abcdef');
  });

  it('knows the ids a package defines', () => {
    expect(isPackageId('wgt_0123456789abcdef')).toBe(true);
    expect(isPackageId('usr_0123456789abcdef')).toBe(false);
    expect(isPackageId('sec_0123456789abcdef')).toBe(false);
    expect(isPackageId(42)).toBe(false);
    expect(packageIdPrefixOf('clr_0123456789abcdef')).toBe('clr');
    expect(packageIdPrefixOf('nope')).toBeNull();
  });
});

describe('limits', () => {
  it('per entry: NDJSON ≤ 200×, JSON and files ≤ 20×; all entries ≤ 4 × cap', () => {
    const limits = basePackageLimits(1000);
    expect(limits).toMatchObject({ ...DEFAULT_BASE_PACKAGE_LIMITS, maxPackageBytes: 1000 });
    expect(maxUncompressedBytes(limits)).toBe(4000);
    const data = classifyEntry('data/tbl_0123456789abcdef.ndjson');
    const links = classifyEntry('links/fld_0123456789abcdef.ndjson');
    const json = classifyEntry('schema/tables.json');
    const file = classifyEntry('files/att_0123456789abcdef');
    const table = [
      [data, 200],
      [links, 200],
      [json, 20],
      [file, 20],
      [classifyEntry('manifest.json'), 20],
      [null, 20],
    ] as const;
    for (const [kind, ratio] of table) {
      expect(maxEntryRatioOf(limits, kind)).toBe(ratio);
      expect(exceedsEntryRatio(limits, kind, 10, 10 * ratio)).toBe(false);
      expect(exceedsEntryRatio(limits, kind, 10, 10 * ratio + 1)).toBe(true);
    }
    // An empty compressed stream counts as one byte.
    expect(exceedsEntryRatio(limits, json, 0, 20)).toBe(false);
    expect(exceedsEntryRatio(limits, json, 0, 21)).toBe(true);
    expect(DEFAULT_BASE_PACKAGE_LIMITS).toEqual({
      maxPackageBytes: 2 * 1024 ** 3,
      maxEntries: 100_000,
      maxEntryRatio: 20,
      maxNdjsonEntryRatio: 200,
      maxUncompressedFactor: 4,
      maxJsonEntryBytes: 64 * 1024 ** 2,
      maxNdjsonLineBytes: 16 * 1024 ** 2,
      maxJsonDepth: 64,
    });
  });
});

describe('problems', () => {
  it('names places with JSON pointers inside entries', () => {
    expect(packagePath('schema/views.json')).toBe('schema/views.json');
    expect(packagePath('schema/views.json', ['views', 0, 'a/b', 'c~d'])).toBe(
      'schema/views.json#/views/0/a~1b/c~0d',
    );
    expect(packageLinePath('data/x.ndjson', 12, ['fields'])).toBe('data/x.ndjson:12#/fields');
  });

  it('collects at most 100 problems, counts the rest', () => {
    const problems = new PackageProblems();
    expect(() => {
      problems.throwIfAny();
    }).not.toThrow();
    for (let index = 0; index < MAX_PACKAGE_PROBLEMS + 5; index += 1) {
      problems.add('DANGLING_REFERENCE', `p${String(index)}`, 'x');
    }
    expect(problems.size).toBe(MAX_PACKAGE_PROBLEMS + 5);
    try {
      problems.throwIfAny();
    } catch (error) {
      expect(isInvalidPackage(error)).toBe(true);
      expect((error as AppError).errors).toHaveLength(MAX_PACKAGE_PROBLEMS);
      expect((error as AppError).params).toEqual({ more_problems: 5 });
    }
    expect(invalidPackage([]).detail).toBe('The package is invalid.');
    expect(isInvalidPackage(new Error('x'))).toBe(false);
  });

  it('PACKAGE_TOO_LARGE is VALIDATION_FAILED with the limit', () => {
    expect(packageTooLarge(10)).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [{ path: '', code: 'PACKAGE_TOO_LARGE', params: { limit: 10 } }],
    });
  });
});

describe('jsonNestsDeeperThan', () => {
  it.each([
    ['{}', 1, false],
    ['{}', 0, true],
    ['[[[]]]', 3, false],
    ['[[[]]]', 2, true],
    ['{"a":"[[[[[["}', 1, false],
    ['{"a":"\\"[[[["}', 1, false],
    ['[{"a":[1,{"b":[]}]}]', 4, true],
  ] as const)('%s, limit %i → %s', (text, limit, deeper) => {
    expect(jsonNestsDeeperThan(text, limit)).toBe(deeper);
  });
});
