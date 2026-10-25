import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BasesRepository,
  GLOBAL_TABLES,
  GlobalRepository,
  isOrgScope,
  orgScope,
  TENANT_TABLES,
  TenantRepository,
  type Db,
  type GlobalTableName,
  type OrgScope,
  type TenantTableName,
} from '../../src/db/index.js';

/** Never touched: every call below must fail before reaching the database. */
const NO_DB = new Proxy(
  {},
  {
    get() {
      throw new Error('database must not be used');
    },
  },
) as Db;

class AnyGlobalRepository extends GlobalRepository<GlobalTableName> {
  constructor(table: GlobalTableName) {
    super(NO_DB, table);
  }
}

class AnyTenantRepository extends TenantRepository<TenantTableName> {
  constructor(table: TenantTableName) {
    super(NO_DB, table);
  }
}

describe('orgScope', () => {
  it('creates a frozen, recognised scope', () => {
    const scope = orgScope('org_A1b2C3d4E5f6G7h8');
    expect(scope.organizationId).toBe('org_A1b2C3d4E5f6G7h8');
    expect(scope.tx).toBeUndefined();
    expect(Object.isFrozen(scope)).toBe(true);
    expect(isOrgScope(scope)).toBe(true);
  });

  it.each(['', 'org_short', 'usr_A1b2C3d4E5f6G7h8', 'org_A1b2C3d4E5f6G7h8 '])(
    'rejects %j',
    (value) => {
      expect(() => orgScope(value as 'org_x')).toThrow(TypeError);
    },
  );

  it('does not recognise a look-alike object', () => {
    expect(isOrgScope({ organizationId: 'org_A1b2C3d4E5f6G7h8', tx: undefined })).toBe(false);
  });
});

describe('TenantRepository', () => {
  it('rejects a forged scope at runtime before any query', async () => {
    const repo = new BasesRepository(NO_DB);
    const forged = { organizationId: 'org_A1b2C3d4E5f6G7h8', tx: undefined } as unknown as OrgScope;
    await expect(repo.getById(forged, 'bse_A1b2C3d4E5f6G7h8')).rejects.toThrow(
      /OrgScope from orgScope\(\) is required/,
    );
  });

  it.each(TENANT_TABLES)('accepts tenant table %s', (table) => {
    expect(() => new AnyTenantRepository(table)).not.toThrow();
  });

  it.each(GLOBAL_TABLES)('rejects global table %s', (table) => {
    expect(() => new AnyTenantRepository(table as unknown as TenantTableName)).toThrow(
      /not a tenant table/,
    );
  });
});

describe('tenant repository classes in the repository', () => {
  const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

  async function sourceFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
        files.push(...(await sourceFiles(path)));
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        files.push(path);
      }
    }
    return files;
  }

  it('all declare `implements TenantRepositoryContract<Self>` so a missing scope fails to compile', async () => {
    const roots = [];
    for (const group of ['apps', 'packages']) {
      for (const entry of await readdir(join(ROOT, group), { withFileTypes: true })) {
        if (entry.isDirectory()) roots.push(join(ROOT, group, entry.name, 'src'));
      }
    }
    const offenders: string[] = [];
    let found = 0;
    for (const root of roots) {
      for (const file of await sourceFiles(root)) {
        const source = await readFile(file, 'utf8');
        const pattern =
          /class\s+(\w+)\s+extends\s+TenantRepository<[^>]*>\s*(implements\s+[^{]*)?\{/g;
        for (const match of source.matchAll(pattern)) {
          found += 1;
          const [, name, implementsClause = ''] = match;
          if (!implementsClause.includes(`TenantRepositoryContract<${String(name)}>`)) {
            offenders.push(`${relative(ROOT, file)}: ${String(name)}`);
          }
        }
      }
    }
    expect(found).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});

describe('GlobalRepository', () => {
  it.each(GLOBAL_TABLES)('accepts global table %s', (table) => {
    expect(() => new AnyGlobalRepository(table)).not.toThrow();
  });

  it.each([...TENANT_TABLES, 'tables', 'pg_class'])('rejects %s', (table) => {
    expect(() => new AnyGlobalRepository(table as GlobalTableName)).toThrow(/not a global table/);
  });

  it('is the closed list of SPEC §5.10', () => {
    expect([...GLOBAL_TABLES].sort()).toEqual(
      ['organizations', 'password_resets', 'sessions', 'user_identities', 'users'].sort(),
    );
  });
});
