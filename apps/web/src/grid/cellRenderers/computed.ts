import { formatComputedText, type ComputedResultType } from '@cellhive/field-types';
import { GridCellKind } from '@glideapps/glide-data-grid';

import { computedCellShape, hyperlinkOf, type ComputedColumn } from '../display/computed';
import { withAlphaHex } from '../theme';

import { renderAttachment } from './attachment';
import { EMPTY_CELL, textCell } from './common';
import { renderLink } from './link';
import { openLink } from './text';
import { usersCell } from './user';

import type { Chip, ChipsCell } from '../customCells/chips';
import type { ComputedMarkCell } from '../customCells/computed';
import type { CellRenderContext, GridField } from '../types';
import type { BooleanCell, GridCell, NumberCell, Theme, UriCell } from '@glideapps/glide-data-grid';

/**
 * Cells of `formula` and `lookup` fields (T468, CONTRACTS §2, SPEC §9.4):
 * always read-only, drawn by `result_type` with the renderers of the
 * matching types — numbers right-aligned in their `style` (a `sum` lookup
 * in VND reads `1.500.000 ₫`), dates in their format, booleans as a check
 * box (decision #12), users as avatars, records as link chips, files as
 * thumbnails, lists of other values as neutral chips; a `HYPERLINK` text
 * `[label](url)` shows its label, a link only for http/https/mailto
 * (decision #9). Locked cells, field-level errors and new fields still
 * being computed are marks (`customCells/computed.ts`); values of a field
 * being recomputed are dimmed (decision #6).
 */

/** Opacity of the old values of a field being recomputed. */
const DIM_ALPHA = 0.5;

const dimThemes = new WeakMap<object, Partial<Theme>>();

/** Text colors of a dimmed cell (one object per palette: glide compares by reference). */
function dimTheme(ctx: CellRenderContext): Partial<Theme> {
  let theme = dimThemes.get(ctx.palette);
  if (theme === undefined) {
    theme = {
      textDark: withAlphaHex(ctx.palette.text, DIM_ALPHA),
      textMedium: withAlphaHex(ctx.palette.textMuted, DIM_ALPHA),
      textLight: withAlphaHex(ctx.palette.textSubtle, DIM_ALPHA),
      linkColor: withAlphaHex(ctx.palette.accent, DIM_ALPHA),
    };
    dimThemes.set(ctx.palette, theme);
  }
  return theme;
}

function mark(
  kind: ComputedMarkCell['data']['mark'],
  text: string,
  a11y: string,
  ctx: CellRenderContext,
  align: 'left' | 'right',
): ComputedMarkCell {
  return {
    kind: GridCellKind.Custom,
    allowOverlay: false,
    readonly: true,
    copyData: a11y,
    data: {
      kind: 'ob-computed-mark',
      mark: kind,
      text,
      color: ctx.palette.textSubtle,
      fontCode: ctx.palette.fontCode,
      align,
    },
  };
}

function withDim<T extends GridCell>(cell: T, dim: boolean, ctx: CellRenderContext): T {
  if (!dim || cell === EMPTY_CELL) return cell;
  return { ...cell, themeOverride: { ...cell.themeOverride, ...dimTheme(ctx) } };
}

function numberAlign(resultType: ComputedResultType | null): 'left' | 'right' {
  return resultType?.kind === 'number' && !resultType.list ? 'right' : 'left';
}

function listChips(
  items: readonly unknown[],
  computed: ComputedColumn & { resultType: ComputedResultType },
  ctx: CellRenderContext,
  dim: boolean,
): GridCell {
  const scalar: ComputedResultType = { kind: computed.resultType.kind, list: false };
  const grey = ctx.palette.options[0] ?? { bg: ctx.palette.sunken, fg: ctx.palette.text };
  const color = dim
    ? { bg: withAlphaHex(grey.bg, DIM_ALPHA), fg: withAlphaHex(grey.fg, DIM_ALPHA) }
    : grey;
  const chips: Chip[] = items
    .map((item) => formatComputedText(item, scalar, computed.style, ctx.locale))
    .filter((label) => label !== '')
    .map((label) => ({ label, color }));
  if (chips.length === 0) return EMPTY_CELL;
  const cell: ChipsCell = {
    kind: GridCellKind.Custom,
    allowOverlay: false,
    readonly: true,
    copyData: chips.map((chip) => chip.label).join(', '),
    data: { kind: 'ob-chips', chips },
  };
  return cell;
}

function textValueCell(text: string): GridCell {
  const link = hyperlinkOf(text);
  if (link === null) return textCell(text);
  const href = link.href;
  // Another scheme (`javascript:`…) is plain text: never a link (FRONTEND §12).
  if (href === null) return { ...textCell(link.label), copyData: text };
  const cell: UriCell = {
    kind: GridCellKind.Uri,
    data: link.label,
    displayData: link.label,
    allowOverlay: false,
    readonly: true,
    hoverEffect: true,
    copyData: text,
    onClickUri: (args) => {
      args.preventDefault();
      openLink(href);
    },
  };
  return cell;
}

/** The glide cell of a computed value (`computed` = `field.computed`). */
export function renderComputed(
  value: unknown,
  computed: ComputedColumn,
  ctx: CellRenderContext,
  field: GridField,
): GridCell {
  const shape = computedCellShape(computed, value);
  const align = numberAlign(computed.resultType);
  const labels = ctx.labels.computed;
  switch (shape.kind) {
    case 'locked':
      return mark('lock', '', labels?.locked ?? '', ctx, align);
    case 'error':
      return mark('token', shape.token, shape.token, ctx, align);
    case 'pending':
      return mark('pending', '…', labels?.pending ?? '…', ctx, align);
    case 'value':
      break;
  }
  const dim = shape.dim;
  if (value === null || value === undefined || value === '') return EMPTY_CELL;
  const resultType = computed.resultType;
  if (resultType === null) {
    // Unknown result type (share links before T462): the value as text.
    const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    return text === '' ? EMPTY_CELL : withDim(textCell(text), dim, ctx);
  }
  switch (resultType.kind) {
    case 'user':
      return usersCell(value, ctx);
    case 'record':
      return renderLink(value, ctx);
    case 'attachment':
      return renderAttachment(value, { type: 'attachment', options: {} } as never, ctx, field);
    default:
      break;
  }
  if (resultType.list) {
    if (!Array.isArray(value)) return EMPTY_CELL;
    return listChips(value, { ...computed, resultType }, ctx, dim);
  }
  const text = formatComputedText(value, resultType, computed.style, ctx.locale);
  switch (resultType.kind) {
    case 'number': {
      if (text === '' || typeof value !== 'number') {
        return text === '' ? EMPTY_CELL : withDim(textCell(text, { align: 'right' }), dim, ctx);
      }
      const cell: NumberCell = {
        kind: GridCellKind.Number,
        data: value,
        displayData: text,
        allowOverlay: false,
        readonly: true,
        contentAlign: 'right',
        copyData: text,
      };
      return withDim(cell, dim, ctx);
    }
    case 'boolean': {
      // A check box (decision #12), like a checkbox field; `false` is an empty box.
      const checked = value === true;
      const cell: BooleanCell = {
        kind: GridCellKind.Boolean,
        data: checked,
        allowOverlay: false,
        readonly: true,
        contentAlign: 'center',
        copyData: checked ? '✓' : '',
        ...(checked
          ? {
              themeOverride: {
                textMedium: dim ? withAlphaHex(ctx.palette.accent, DIM_ALPHA) : ctx.palette.accent,
              },
            }
          : {}),
      };
      return cell;
    }
    case 'text':
      return text === '' ? EMPTY_CELL : withDim(textValueCell(text), dim, ctx);
    default:
      return text === '' ? EMPTY_CELL : withDim(textCell(text), dim, ctx);
  }
}
