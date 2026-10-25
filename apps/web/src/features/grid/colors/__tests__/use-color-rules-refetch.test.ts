import { describe, expect, it } from 'vitest';

import { colorRulesKey } from '../use-color-rules-refetch';

const rule = {
  id: 'clr_Saved00000000001',
  enabled: true,
  filter: { op: 'and', items: [] },
  color: 'red',
  target: 'row',
  field_id: null,
} as const;

describe('colorRulesKey', () => {
  it('ignores the color (a repaint) but not what decides the match', () => {
    const off = { ...rule, enabled: false };
    expect(colorRulesKey([rule])).toBe(colorRulesKey([{ ...rule, color: 'blue' }]));
    expect(colorRulesKey([rule])).not.toBe(colorRulesKey([off]));
    expect(colorRulesKey([rule])).not.toBe(colorRulesKey([{ ...rule, target: 'cell' }]));
    expect(colorRulesKey(undefined)).toBe(colorRulesKey([]));
  });
});
