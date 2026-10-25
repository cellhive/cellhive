import { describe, expect, it } from 'vitest';

import { isCellOnScreen, isTypedCharacter } from '../GridView';

const key = (value: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean } = {}) => ({
  key: value,
  ctrlKey: modifiers.ctrlKey ?? false,
  metaKey: modifiers.metaKey ?? false,
});

describe('isTypedCharacter (type to edit, S2 QA)', () => {
  it.each([
    ['a', true],
    ['Z', true],
    ['5', true],
    ['?', true],
    // Glide 6.0.3 alone ignores every non-ASCII character.
    ['đ', true],
    ['Đ', true],
    ['é', true],
    ['中', true],
    ['𝒜', true],
    [' ', false],
    ['Enter', false],
    ['F2', false],
    ['Shift', false],
    ['Process', false],
    ['Dead', false],
    ['ArrowDown', false],
  ])('%j → %s', (value, expected) => {
    expect(isTypedCharacter(key(value))).toBe(expected);
  });

  it('shortcuts with Ctrl or ⌘ are not typing', () => {
    expect(isTypedCharacter(key('d', { ctrlKey: true }))).toBe(false);
    expect(isTypedCharacter(key('z', { metaKey: true }))).toBe(false);
  });
});

describe('isCellOnScreen', () => {
  const area = new DOMRect(100, 100, 600, 400);
  it.each([
    ['inside', { x: 120, y: 150, width: 200, height: 34 }, true],
    // A frozen column while the grid is scrolled sideways: still on screen.
    ['frozen column at the left edge', { x: 148, y: 400, width: 240, height: 34 }, true],
    ['partly below the bottom', { x: 120, y: 480, width: 200, height: 34 }, true],
    ['scrolled out below', { x: 120, y: 520, width: 200, height: 34 }, false],
    ['scrolled out above', { x: 120, y: 40, width: 200, height: 34 }, false],
    ['right of the grid', { x: 720, y: 150, width: 200, height: 34 }, false],
  ])('%s', (_name, bounds, expected) => {
    expect(isCellOnScreen(bounds, area)).toBe(expected);
  });
});
