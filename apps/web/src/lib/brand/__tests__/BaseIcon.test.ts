import { describe, expect, it } from 'vitest';

import { baseIconValue, baseLook } from '../BaseIcon';

describe('baseLook', () => {
  it.each([
    ['support:5', { glyph: 'support', color: 5 }],
    ['database:0', { glyph: 'database', color: 0 }],
  ])('reads %s', (icon, look) => {
    expect(baseLook({ id: 'bse_Any0000000000001', icon })).toEqual(look);
    expect(baseIconValue(look as never)).toBe(icon);
  });

  it.each([null, '', 'support:8', 'unknown:3', '🚀', 'support:5:x'])(
    'falls back for %j: database glyph, a color 1–7 from the ID, the same each time',
    (icon) => {
      const look = baseLook({ id: 'bse_Any0000000000001', icon });
      expect(look.glyph).toBe('database');
      expect(look.color).toBeGreaterThanOrEqual(1);
      expect(look.color).toBeLessThanOrEqual(7);
      expect(baseLook({ id: 'bse_Any0000000000001', icon: null })).toEqual(look);
    },
  );

  it('spreads IDs over the colors', () => {
    const colors = new Set(
      Array.from(
        { length: 40 },
        (_, index) => baseLook({ id: `bse_${String(index)}`, icon: null }).color,
      ),
    );
    expect(colors.size).toBeGreaterThanOrEqual(5);
  });
});
