import { ROW_HEIGHTS as VIEW_ROW_HEIGHTS } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  AVATAR_FONT_WEIGHT,
  AVATAR_MIN_FONT_SIZE,
  AVATAR_MIN_SCALE_X,
  avatarBaseline,
  avatarInkLeft,
  avatarInnerWidth,
  layoutAvatar,
} from '../customCells/avatar';
import { initialsOf } from '../display/text';
import { ROW_HEIGHTS } from '../theme';

/**
 * Widths close to the UI font at weight 500: most capitals ≈ 0.72 em, the
 * wide ones (M, W) ≈ 0.9 em, an emoji 1.2 em.
 */
function measure(text: string, fontSize: number): number {
  let width = 0;
  for (const character of text) {
    if (/\p{Extended_Pictographic}/u.test(character)) width += 1.2 * fontSize;
    else if (/[MWmw]/u.test(character)) width += 0.9 * fontSize;
    else if (/\p{M}/u.test(character)) width += 0;
    else width += 0.72 * fontSize;
  }
  return width;
}

const NAMES = [
  'Nguyễn Văn An',
  'Nguyễn Văn Ánh',
  'Mai Wang',
  'An',
  '😀 Minh',
  'Ｗide Ｍan',
  'Nguye\u0302\u0303n Tha\u0300nh', // decomposed accents (NFD)
];

describe('avatar layout (T420)', () => {
  // The four view row heights × pixel ratio 1 and 2: the layout is in CSS
  // pixels, the drawing snaps it to device pixels.
  const cases = VIEW_ROW_HEIGHTS.flatMap((rowHeight) =>
    [1, 2].flatMap((dpr) => NAMES.map((name) => [rowHeight, dpr, name] as const)),
  );

  it.each(cases)(
    '%s rows at DPR %s: the initials of %s fit the circle',
    (viewHeight, dpr, name) => {
      // As the page maps them (`densityOf`): short → compact, taller → comfortable.
      const rowHeight = ROW_HEIGHTS[viewHeight === 'short' ? 'compact' : 'comfortable'];
      const layout = layoutAvatar(initialsOf(name), rowHeight, measure);
      // The circle leaves at least 5 px above and below in the row.
      expect(layout.diameter).toBeLessThanOrEqual(rowHeight - 10);
      // Whole device pixels: the circle edge is crisp.
      expect(Number.isInteger(layout.diameter * dpr)).toBe(true);
      expect(layout.fontSize).toBeGreaterThanOrEqual(AVATAR_MIN_FONT_SIZE);
      expect(Array.from(layout.text).length).toBeLessThanOrEqual(2);
      expect(layout.text.length).toBeGreaterThan(0);
      expect(layout.scaleX).toBeGreaterThanOrEqual(AVATAR_MIN_SCALE_X);
      expect(measure(layout.text, layout.fontSize) * layout.scaleX).toBeLessThanOrEqual(
        avatarInnerWidth(layout.diameter) + 1e-9,
      );
    },
  );

  it('matches the DOM avatar of a user value: 24 px, 12 px medium on compact rows', () => {
    const layout = layoutAvatar('NA', ROW_HEIGHTS.compact, measure);
    expect(layout).toEqual({ diameter: 24, fontSize: 12, text: 'NA', scaleX: 1 });
    expect(AVATAR_FONT_WEIGHT).toBe(500);
    expect(layoutAvatar('NA', ROW_HEIGHTS.comfortable, measure)).toMatchObject({
      diameter: 28,
      fontSize: 13,
      text: 'NA',
    });
  });

  it('"Nguyễn Văn An" draws "NA" whole', () => {
    expect(layoutAvatar(initialsOf('Nguyễn Văn An'), 34, measure).text).toBe('NA');
  });

  it('squeezes wide initials a little, then keeps only the first one', () => {
    const squeezed = layoutAvatar('MW', 34, measure);
    expect(squeezed.text).toBe('MW');
    expect(squeezed.scaleX).toBeLessThan(1);
    const wider = layoutAvatar('MW', 34, (text, size) => measure(text, size) * 1.2);
    expect(wider.text).toBe('M');
  });

  it('keeps an emoji whole', () => {
    expect(layoutAvatar(initialsOf('😀 😎'), 34, measure).text).toBe('😀');
  });

  // Ink of the initials at 12 px: capitals ≈ 8.6 px tall, an acute accent
  // adds ≈ 3 px, a stacked Vietnamese one (Ấ) ≈ 5 px, "Q" ≈ 2 px below.
  it.each([
    ['NA', 8.6, 0],
    ['NÁ', 11.6, 0],
    ['NẤ', 13.6, 0],
    ['QA', 8.6, 2],
  ])('centers the ink of %s on the circle, whatever the font metrics', (_, ascent, descent) => {
    const middle = 17;
    const baseline = avatarBaseline(middle, {
      actualBoundingBoxAscent: ascent,
      actualBoundingBoxDescent: descent,
    });
    const top = baseline - ascent;
    const bottom = baseline + descent;
    expect((top + bottom) / 2).toBeCloseTo(middle, 9);
    // Inside a 24 px circle with room on both sides (the E2E checks ≥ 2.5 px).
    expect(top - (middle - 12)).toBeGreaterThanOrEqual(5);
    expect(middle + 12 - bottom).toBeGreaterThanOrEqual(5);
  });

  it.each([
    // [initials, ink left of the anchor, ink right of it, scaleX]
    ['NÁ', -0.9, 16.2, 1],
    ['MW', -0.4, 21.5, 0.82],
    ['A', 0.1, 8.2, 1],
  ])(
    'centers the ink of %s across the circle, whatever the side bearings',
    (_, left, right, scaleX) => {
      const center = 20;
      const anchor = avatarInkLeft(
        center,
        { actualBoundingBoxLeft: left, actualBoundingBoxRight: right },
        scaleX,
      );
      // `actualBoundingBoxLeft` is positive to the left of the anchor.
      const inkLeft = anchor - scaleX * left;
      const inkRight = anchor + scaleX * right;
      expect((inkLeft + inkRight) / 2).toBeCloseTo(center, 9);
    },
  );
});
