import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { keys } from '../../../lib/query/keys';
import { TreeRows, treeLevelBody, type FetchTreeLevel } from '../tree/tree-rows';

import type { RecordListResponse } from '@cellhive/contracts';

const TABLE = 'tbl_Tree0000000000001';
const NOW = '2026-09-26T00:00:00.000Z';
const NAME = 'fld_Name000000000001';

/** Parent → children (ids); `''` the roots. Roots 0…2, root 0 has 3 children, its child 1 has 2. */
const TREE: Record<string, string[]> = {
  '': ['rec_r0', 'rec_r1', 'rec_r2'],
  rec_r0: ['rec_c0', 'rec_c1', 'rec_c2'],
  rec_c1: ['rec_g0', 'rec_g1'],
};

function depthOf(id: string): number {
  for (const [parent, children] of Object.entries(TREE)) {
    if (children.includes(id)) return parent === '' ? 0 : depthOf(parent) + 1;
  }
  return 0;
}

const fetchLevel: FetchTreeLevel = (parentId, index) => {
  const ids = TREE[parentId ?? ''] ?? [];
  const page = ids.slice(index * 200, index * 200 + 200);
  const response: RecordListResponse = {
    records: page.map((id) => ({
      id: id as `rec_${string}`,
      created_at: NOW,
      updated_at: NOW,
      version: 1,
      fields: { [NAME]: id },
      tree: {
        parent_id: parentId as `rec_${string}` | null,
        depth: depthOf(id),
        children_count: TREE[id]?.length ?? 0,
        ancestor_only: id === 'rec_r0',
      },
    })),
    total: ids.length,
    offset: index * 200,
    limit: 200,
  };
  return Promise.resolve(response);
};

async function settle() {
  for (let round = 0; round < 5; round += 1) await vi.advanceTimersByTimeAsync(10);
}

describe('TreeRows (T417, FRONTEND §3.3)', () => {
  let queryClient: QueryClient;
  let open: Set<string>;
  let rows: TreeRows;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    open = new Set();
    rows = new TreeRows({
      queryClient,
      tableId: TABLE,
      query: { view_id: 'viw_1' },
      showAncestors: true,
      permissionVersion: 1,
      parentFieldId: 'fld_Parent00000000001',
      isExpanded: (id) => open.has(id),
      fetchLevel,
    });
    rows.attach();
  });

  afterEach(() => {
    rows.detach();
    queryClient.clear();
    vi.useRealTimers();
  });

  const ids = () =>
    Array.from({ length: rows.getSnapshot().rowCount }, (_, row) => rows.getRecord(row)?.id);

  it('shows the roots first, collapsed', async () => {
    await settle();
    expect(rows.getSnapshot().status).toBe('ready');
    expect(ids()).toEqual(['rec_r0', 'rec_r1', 'rec_r2']);
    const node = rows.nodeAt(0);
    expect(node).toMatchObject({ depth: 0, childCount: 3, expanded: false, ancestorOnly: true });
  });

  it('loads a branch when it opens and lays its rows out under it', async () => {
    await settle();
    open.add('rec_r0');
    rows.setExpansion((id) => open.has(id));
    rows.setViewport(0, 10, false);
    await settle();
    expect(ids()).toEqual(['rec_r0', 'rec_c0', 'rec_c1', 'rec_c2', 'rec_r1', 'rec_r2']);
    open.add('rec_c1');
    rows.setExpansion((id) => open.has(id));
    rows.setViewport(0, 10, false);
    await settle();
    expect(ids()).toEqual([
      'rec_r0',
      'rec_c0',
      'rec_c1',
      'rec_g0',
      'rec_g1',
      'rec_c2',
      'rec_r1',
      'rec_r2',
    ]);
    expect(rows.nodeAt(4)).toMatchObject({ depth: 2, ancestors: ['rec_r0', 'rec_c1'] });
    expect(rows.rowOf('rec_c2')).toBe(5);
    expect((await rows.loadRows(2, 6)).map((record) => record?.id)).toEqual([
      'rec_c1',
      'rec_g0',
      'rec_g1',
      'rec_c2',
      'rec_r1',
    ]);
  });

  it('"open every level" loads the branches level after level', async () => {
    rows.setExpansion(() => true);
    rows.setViewport(0, 0, false);
    await settle();
    expect(ids()).toEqual([
      'rec_r0',
      'rec_c0',
      'rec_c1',
      'rec_g0',
      'rec_g1',
      'rec_c2',
      'rec_r1',
      'rec_r2',
    ]);
  });

  it('collapsing drops the branch rows', async () => {
    open.add('rec_r0');
    // The expand state changed: the hook hands it over (`setExpansion`).
    rows.setExpansion((id) => open.has(id));
    rows.setViewport(0, 10, false);
    await settle();
    expect(rows.getSnapshot().rowCount).toBe(6);
    open.clear();
    rows.setExpansion((id) => open.has(id));
    await settle();
    expect(ids()).toEqual(['rec_r0', 'rec_r1', 'rec_r2']);
  });

  it('writes cells in place and refreshes on a move of the parent field', async () => {
    await settle();
    rows.cache.patch('rec_r1', { [NAME]: 'Renamed' });
    expect(rows.getRecord(1)?.fields[NAME]).toBe('Renamed');
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    rows.cache.patch('rec_r1', { fld_Parent00000000001: { id: 'rec_r0', title: 'rec_r0' } });
    await vi.advanceTimersByTimeAsync(200);
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: keys.recordBlocks(TABLE) }),
    );
  });

  it('sends the tree query without group, with show_ancestors and the level', () => {
    expect(
      treeLevelBody(
        { view_id: 'viw_1', group: [{ field: 'fld_x' }], search: 'a' },
        false,
        'rec_r0',
        1,
      ),
    ).toMatchObject({
      view_id: 'viw_1',
      parent_id: 'rec_r0',
      search: 'a',
      show_ancestors: false,
      offset: 200,
      limit: 200,
      include_total: false,
    });
    expect('group' in treeLevelBody({ group: [] }, true, null, 0)).toBe(false);
  });
});
