import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EXPAND,
  isExpanded,
  openLevels,
  parseExpand,
  serializeExpand,
  setExpanded,
  toggleExpanded,
} from '../tree/expand-state';

describe('tree expand state (T417)', () => {
  it('opens the roots only by default (one level shown)', () => {
    expect(isExpanded(DEFAULT_EXPAND, 'rec_a', 0)).toBe(false);
  });

  it('opens N levels, then remembers the branches toggled against it', () => {
    const three = openLevels(3);
    expect(isExpanded(three, 'rec_a', 0)).toBe(true);
    expect(isExpanded(three, 'rec_a', 1)).toBe(true);
    expect(isExpanded(three, 'rec_a', 2)).toBe(false);
    const closed = toggleExpanded(three, 'rec_a');
    expect(isExpanded(closed, 'rec_a', 0)).toBe(false);
    expect(setExpanded(closed, 'rec_a', 0, false)).toBe(closed);
    expect(isExpanded(setExpanded(closed, 'rec_a', 0, true), 'rec_a', 0)).toBe(true);
  });

  it('clamps the levels to 1…10', () => {
    expect(openLevels(0).levels).toBe(1);
    expect(openLevels(42).levels).toBe(10);
  });

  it('round-trips through storage and rejects anything else', () => {
    const state = toggleExpanded(openLevels(2), 'rec_abc');
    expect(parseExpand(serializeExpand(state))).toEqual(state);
    expect(serializeExpand(DEFAULT_EXPAND)).toBeNull();
    expect(parseExpand('not json')).toEqual(DEFAULT_EXPAND);
    expect(parseExpand('{"levels":"x","except":["rec_a",1,"<script>"]}')).toEqual({
      levels: 1,
      except: ['rec_a'],
    });
  });
});
