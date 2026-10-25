import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../../../test/axe';
import { gapHeight, gutterContent, gutterWidth } from '../customCells/group-card';
import {
  HEADER_PADDING,
  layoutHeader,
  summaryText,
  type TextMetrics,
} from '../customCells/group-header';
import { GroupStickyPath } from '../GroupStickyPath';

import type { GridGroupRow } from '../rows';

/** 7 px per character; `fit` cuts with "…" like the canvas helper. */
const metrics: TextMetrics = {
  width: (text) => text.length * 7,
  fit: (text, maxWidth) => {
    if (text.length * 7 <= maxWidth) return text;
    const room = Math.floor(maxWidth / 7) - 1;
    return room <= 0 ? '' : `${text.slice(0, room)}…`;
  },
};

const chip = (label: string) => ({ label, color: { bg: '#eee', fg: '#111' } });

describe('group header layout (T320a)', () => {
  it.each([
    {
      name: 'fits the frozen area: the count is right-aligned against the divider',
      chips: [chip('Đang thực hiện')],
      headWidth: 300,
      rowWidth: 1_000,
      overflow: false,
      label: 'Đang thực hiện',
    },
    {
      name: 'wider than the frozen area: the chip keeps its natural width, the count follows',
      chips: [chip('Phạm Thị Hương — Phòng kinh doanh miền Bắc')],
      headWidth: 200,
      rowWidth: 1_000,
      overflow: true,
      label: 'Phạm Thị Hương — Phòng kinh doanh miền Bắc',
    },
    {
      name: 'wider than the whole row: only then is the chip shortened',
      chips: [chip('x'.repeat(200))],
      headWidth: 200,
      rowWidth: 600,
      overflow: true,
      label: `${'x'.repeat(65)}…`,
    },
  ])('$name', ({ chips, headWidth, rowWidth, overflow, label }) => {
    const layout = layoutHeader(
      { chips, text: '', count: '470 bản ghi', headWidth, rowWidth },
      metrics,
      'sans-serif',
    );
    expect(layout.overflow).toBe(overflow);
    expect(layout.chips[0]?.label).toBe(label);
    expect(layout.chips[0]?.x).toBe(HEADER_PADDING);
    const chipEnd = (layout.chips[0]?.x ?? 0) + (layout.chips[0]?.width ?? 0);
    if (overflow) {
      expect(layout.countX).toBe(chipEnd + 12);
    } else {
      // Right-aligned: count + caret end at the frozen divider minus the padding.
      expect(layout.caretX + 8).toBe(headWidth - HEADER_PADDING);
    }
    expect(layout.caretX).toBeGreaterThan(layout.countX);
  });

  it('a value without chips is text; several chips follow each other', () => {
    const text = layoutHeader(
      { chips: null, text: '(Trống)', count: '3 bản ghi', headWidth: 300, rowWidth: 900 },
      metrics,
      'sans-serif',
    );
    expect(text.text).toEqual({ label: '(Trống)', x: HEADER_PADDING });
    expect(text.chips).toEqual([]);
    const many = layoutHeader(
      { chips: [chip('A'), chip('Bb')], text: '', count: '1', headWidth: 300, rowWidth: 900 },
      metrics,
      'sans-serif',
    );
    expect(many.chips.map((item) => item.x)).toEqual([HEADER_PADDING, HEADER_PADDING + 23 + 4]);
  });
});

describe('group cards geometry', () => {
  it('spacers: 16 px between top-level cards, 8 px inside a card', () => {
    expect([0, 1, 2].map(gapHeight)).toEqual([16, 8, 8]);
  });

  it('the gutter makes room for nested cards; the number sits in the innermost one', () => {
    expect(gutterWidth(1, 40)).toBe(46);
    expect(gutterWidth(3, 40)).toBe(78);
    const rect = { x: 0, y: 0, width: 78, height: 34 };
    expect(gutterContent(rect, { depth: 3, top: false, bottom: false })).toEqual({
      x: 38,
      y: 0,
      width: 40,
      height: 34,
    });
    expect(gutterContent(rect, { depth: 1, top: true, bottom: false }).x).toBe(6);
  });
});

describe('GroupStickyPath', () => {
  const group = (level: number, value: string): GridGroupRow => ({
    key: `k${String(level)}`,
    level,
    field: undefined,
    value,
    count: 4,
    collapsed: false,
    rest: false,
    nested: level === 0,
  });

  it('pins the headers of the current groups; a click toggles one; no axe violations', async () => {
    const onToggle = vi.fn();
    const { container } = render(
      <GroupStickyPath
        groups={[group(0, 'Đang thực hiện'), group(1, 'Cao')]}
        top={37}
        rowHeight={34}
        gutter={62}
        headWidth={240}
        describe={(item) => ({
          display: { text: String(item.value), chips: null },
          count: '4 bản ghi',
          label: `Trạng thái ${String(item.value)}: 4 bản ghi, đang mở`,
        })}
        onToggle={onToggle}
        onWheel={() => undefined}
      />,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Đang thực hiện4 bản ghi',
      'Cao4 bản ghi',
    ]);
    expect(buttons[0]).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(
      screen.getByRole('button', { name: 'Trạng thái Cao: 4 bản ghi, đang mở' }),
    );
    expect(onToggle).toHaveBeenCalledWith('k1');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('renders nothing without a group scrolled away', () => {
    const { container } = render(
      <GroupStickyPath
        groups={[]}
        top={37}
        rowHeight={34}
        gutter={62}
        headWidth={240}
        describe={() => ({ display: { text: '', chips: null }, count: '', label: '' })}
        onToggle={() => undefined}
        onWheel={() => undefined}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('summaryText (QA S4b M6: summaries of group headers in narrow columns)', () => {
  const measure = {
    label: (text: string) => text.length * 7,
    value: (text: string) => text.length * 7,
  };
  it.each([
    // width, label, value → label and value shown (7 px per character, 10 px padding each side)
    [200, 'Sum', '24.961.750', 'Sum', '24.961.750'],
    [119, 'Sum', '1.250', null, '1.250'],
    [130, 'Average', '24.961.750', null, '24.961.750'],
    [80, 'Sum', '24.961.750.000', null, '24.961.…'],
  ] as const)('%i px: %s %s', (width, label, value, wantLabel, wantValue) => {
    expect(
      summaryText(width, label, value, measure, (text, max) => metrics.fit(text, max, '')),
    ).toEqual({
      label: wantLabel,
      value: wantValue,
    });
  });
});
