import { afterEach, describe, expect, it } from 'vitest';

import {
  attachRun,
  beginClick,
  endClick,
  resetRunningClicks,
  runningClicks,
  takeRun,
} from '../runs';

const CLICK = {
  key: 'rec_1|fld_1',
  tableId: 'tbl_1',
  recordId: 'rec_1',
  fieldId: 'fld_1',
  label: 'Approve',
  recordTitle: 'Order 1',
};

afterEach(() => {
  resetRunningClicks();
});

describe('running clicks (T525)', () => {
  it('runs one click per cell until its run finishes, answered once', () => {
    expect(beginClick(CLICK)).toBe(true);
    // A second press of the same cell is ignored.
    expect(beginClick(CLICK)).toBe(false);
    expect(attachRun(CLICK.key, 'run_1')).toBeUndefined();
    expect(runningClicks().get(CLICK.key)?.runId).toBe('run_1');
    // A run of another tab is none of this one's business.
    expect(takeRun('run_other', 'succeeded')).toBeUndefined();
    expect(runningClicks().has(CLICK.key)).toBe(true);
    expect(takeRun('run_1', 'failed')?.label).toBe('Approve');
    expect(runningClicks().has(CLICK.key)).toBe(false);
    // The grid and the panel both listen: the second one gets nothing.
    expect(takeRun('run_1', 'failed')).toBeUndefined();
  });

  it('keeps the status of a run that ends before its 202 is read', () => {
    beginClick(CLICK);
    expect(takeRun('run_fast', 'succeeded')).toBeUndefined();
    expect(attachRun(CLICK.key, 'run_fast')).toBe('succeeded');
  });

  it('forgets a refused click', () => {
    beginClick(CLICK);
    endClick(CLICK.key);
    expect(runningClicks().size).toBe(0);
    expect(beginClick(CLICK)).toBe(true);
  });
});
