import { describe, expect, it } from 'vitest';

import { placeEditor, VIEWPORT_MARGIN } from '../editors/shell';

const CELL = 34;
const WINDOW = 900;

describe('placeEditor (popover of a cell editor stays in the window, S2 QA)', () => {
  it.each([
    // [cell top, popover height, expected]
    ['fits below', 200, 300, { above: false, maxHeight: undefined }],
    [
      'exactly fits below',
      WINDOW - 300 - VIEWPORT_MARGIN,
      300,
      { above: false, maxHeight: undefined },
    ],
    ['near the bottom: opens above', 800, 300, { above: true, maxHeight: undefined }],
    [
      'no room either way, more above: above, shrunk',
      500,
      800,
      { above: true, maxHeight: 500 + CELL - VIEWPORT_MARGIN },
    ],
    [
      'no room either way, more below: below, shrunk',
      100,
      850,
      { above: false, maxHeight: WINDOW - 100 - VIEWPORT_MARGIN },
    ],
  ])('%s', (_name, cellTop, height, expected) => {
    expect(placeEditor(cellTop, CELL, height, WINDOW)).toEqual(expected);
  });

  it('never shrinks below the cell (the input keeps its height)', () => {
    expect(
      placeEditor(WINDOW - 10, CELL, 400, WINDOW).maxHeight ?? Infinity,
    ).toBeGreaterThanOrEqual(CELL);
  });
});
