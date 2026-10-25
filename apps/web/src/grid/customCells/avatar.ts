import { firstGrapheme } from '../display/text';

/**
 * Geometry of a user avatar drawn on the grid canvas (T420): the same
 * circle as the DOM avatar of a user value (`grid/display/Avatar`, size
 * `md`: 24 px, 12 px medium initials), a little larger on comfortable rows.
 * Pure: the text width comes from `measure`, so the initials of any name
 * (accents, emoji, wide letters) are checked against the circle, never cut.
 */

/** Weight of the initials (design token `--text-label--font-weight`). */
export const AVATAR_FONT_WEIGHT = 500;
/** No text under 12 px (T322b). */
export const AVATAR_MIN_FONT_SIZE = 12;
/** Horizontal squeeze allowed before falling back to one initial. */
export const AVATAR_MIN_SCALE_X = 0.8;

export interface AvatarLayout {
  /** Circle diameter, CSS px. */
  readonly diameter: number;
  /** Initials font size, CSS px (≥ 12). */
  readonly fontSize: number;
  /** What is drawn: the two initials, or the first one when two do not fit. */
  readonly text: string;
  /** Horizontal scale of the text (≤ 1) so that it fits the inner width. */
  readonly scaleX: number;
}

/** Circle diameter for a row height: 24 px on compact rows (34 px), 28 px from 44 px. */
export function avatarDiameter(rowHeight: number): number {
  return rowHeight >= 40 ? 28 : 24;
}

/** Width available to the text inside the circle (a side padding of ~14 %). */
export function avatarInnerWidth(diameter: number): number {
  return diameter - 2 * Math.max(3, Math.round(diameter * 0.14));
}

/**
 * Lays the initials out in the circle of a row: the font follows the
 * diameter (12 px at 24, 13 px at 28); two initials wider than the inner
 * width are squeezed down to `AVATAR_MIN_SCALE_X`, beyond that only the
 * first initial is drawn (squeezed too if it must).
 */
export function layoutAvatar(
  initials: string,
  rowHeight: number,
  measure: (text: string, fontSize: number) => number,
): AvatarLayout {
  const diameter = avatarDiameter(rowHeight);
  const fontSize = Math.max(AVATAR_MIN_FONT_SIZE, Math.round(diameter * 0.46));
  const inner = avatarInnerWidth(diameter);
  const fit = (text: string) => {
    const width = measure(text, fontSize);
    return width <= inner ? 1 : inner / width;
  };
  const both = fit(initials);
  if (both >= AVATAR_MIN_SCALE_X) return { diameter, fontSize, text: initials, scaleX: both };
  const first = firstGrapheme(initials);
  return { diameter, fontSize, text: first, scaleX: fit(first) };
}

/** Ink extent of the drawn initials above and below the alphabetic baseline (`TextMetrics`). */
export interface InkMetrics {
  readonly actualBoundingBoxAscent: number;
  readonly actualBoundingBoxDescent: number;
}

/**
 * Alphabetic baseline that centers the initials' ink (accents included) on
 * the circle's `middle`. Not `textBaseline = 'middle'`: that is the middle
 * of the font's em box, and Chromium reads the ascent/descent behind it
 * from the platform's font backend — on Linux "NÁ" sat 3 px high, its
 * accent 2 px from the edge of a 24 px circle. The ink box of the glyphs
 * is the same wherever the font is.
 */
export function avatarBaseline(middle: number, ink: InkMetrics): number {
  return middle + (ink.actualBoundingBoxAscent - ink.actualBoundingBoxDescent) / 2;
}

/** Ink extent of the drawn initials left and right of the anchor of `textAlign = 'left'`. */
export interface InkWidthMetrics {
  readonly actualBoundingBoxLeft: number;
  readonly actualBoundingBoxRight: number;
}

/**
 * Left anchor (`textAlign = 'left'`) that centers the initials' ink on the
 * circle's `center`, the text squeezed by `scaleX`. Not `textAlign =
 * 'center'`: that centers the advance width, and the side bearings of the
 * glyphs differ (on Linux the ink of "NÁ" sat 2 px from the right edge of
 * a 24 px circle).
 */
export function avatarInkLeft(center: number, ink: InkWidthMetrics, scaleX = 1): number {
  return center - (scaleX * (ink.actualBoundingBoxRight - ink.actualBoundingBoxLeft)) / 2;
}
