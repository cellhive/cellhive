import { GridCellKind, measureTextCached } from '@glideapps/glide-data-grid';

import {
  AVATAR_FONT_WEIGHT,
  avatarBaseline,
  avatarDiameter,
  avatarInkLeft,
  layoutAvatar,
} from './avatar';
import { CHIP_GAP, fitText, fontOf, withCellClip } from './draw';

import type { ChipColor } from '../theme';
import type { CustomCell, CustomRenderer } from '@glideapps/glide-data-grid';

export interface UserBadge {
  readonly initials: string;
  readonly name: string;
  readonly color: ChipColor;
}

export interface UsersCellData {
  readonly kind: 'ob-users';
  readonly users: readonly UserBadge[];
}

export type UsersCell = CustomCell<UsersCellData>;

const NAME_GAP = 6;
const USER_GAP = CHIP_GAP * 3;

/**
 * Users as avatar (white initials on a solid color derived from the user
 * id, as in the DOM) + name,
 * one after the other; the ones that do not fit end with "+N". The avatar
 * is the DOM one of a user value (T420, `layoutAvatar`): 24 px on compact
 * rows, 28 px from 44 px, 12–13 px medium initials measured to fit.
 */
export const usersCellRenderer: CustomRenderer<UsersCell> = {
  kind: GridCellKind.Custom,
  isMatch: (cell): cell is UsersCell => (cell.data as { kind?: unknown }).kind === 'ob-users',
  needsHover: false,
  draw: (args, cell) => {
    const { ctx, rect, theme } = args;
    const { users } = cell.data;
    if (users.length === 0) return;
    const nameFont = fontOf(theme.baseFontStyle, theme.fontFamily);
    const initialsFont = (size: number) =>
      fontOf(`${String(AVATAR_FONT_WEIGHT)} ${String(size)}px`, theme.fontFamily);
    // Device pixels per CSS pixel: the circle's center lands on whole device pixels.
    const dpr = ctx.getTransform().a || 1;
    const snap = (value: number) => Math.round(value * dpr) / dpr;
    const size = avatarDiameter(rect.height);
    withCellClip(ctx, rect, () => {
      const middle = snap(rect.y + rect.height / 2);
      const right = rect.x + rect.width - theme.cellHorizontalPadding;
      let x = rect.x + theme.cellHorizontalPadding;
      for (const [index, user] of users.entries()) {
        if (index > 0 && x + size > right) {
          ctx.font = nameFont;
          ctx.fillStyle = theme.textMedium;
          ctx.fillText(`+${String(users.length - index)}`, x, middle);
          return;
        }
        const avatar = layoutAvatar(user.initials, rect.height, (text, fontSize) => {
          ctx.font = initialsFont(fontSize);
          return ctx.measureText(text).width;
        });
        const center = snap(x + avatar.diameter / 2);
        ctx.beginPath();
        ctx.arc(center, middle, avatar.diameter / 2, 0, Math.PI * 2);
        ctx.fillStyle = user.color.bg;
        ctx.fill();
        ctx.font = initialsFont(avatar.fontSize);
        ctx.fillStyle = user.color.fg;
        ctx.textAlign = 'left';
        // Centered on the ink of the initials, not on the font's em box and
        // advance width (`avatarBaseline`, `avatarInkLeft`).
        const textBaseline = ctx.textBaseline;
        ctx.textBaseline = 'alphabetic';
        const ink = ctx.measureText(avatar.text);
        const baseline = avatarBaseline(middle, ink);
        const left = avatarInkLeft(center, ink, avatar.scaleX);
        if (avatar.scaleX < 1) {
          ctx.save();
          ctx.translate(left, baseline);
          ctx.scale(avatar.scaleX, 1);
          ctx.fillText(avatar.text, 0, 0);
          ctx.restore();
        } else {
          ctx.fillText(avatar.text, left, baseline);
        }
        ctx.textBaseline = textBaseline;
        ctx.textAlign = 'left';
        x += avatar.diameter + NAME_GAP;
        ctx.font = nameFont;
        ctx.fillStyle = theme.textDark;
        const reserved = index < users.length - 1 ? USER_GAP + size : 0;
        const name = fitText(ctx, user.name, right - x - reserved);
        ctx.fillText(name, x, middle);
        x += measureTextCached(name, ctx, nameFont).width + USER_GAP;
      }
    });
  },
  measure: (ctx, cell, theme) =>
    cell.data.users.reduce(
      (width, user) =>
        width +
        avatarDiameter(Number.POSITIVE_INFINITY) +
        NAME_GAP +
        measureTextCached(user.name, ctx, fontOf(theme.baseFontStyle, theme.fontFamily)).width +
        USER_GAP,
      theme.cellHorizontalPadding * 2,
    ),
};
