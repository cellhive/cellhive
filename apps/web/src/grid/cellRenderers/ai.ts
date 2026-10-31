import { GridCellKind } from '@glideapps/glide-data-grid';

import { aiCellStateOf } from '../../lib/ai/ai-field';

import { renderCell } from './index';

import type { AiStateCell } from '../customCells/ai';
import type { ComputedMarkCell } from '../customCells/computed';
import type { CellRenderContext, GridField, GridRecord } from '../types';
import type { GridCell } from '@glideapps/glide-data-grid';

/**
 * Cells of AI fields (T915, CONTRACTS §29.5, FRONTEND §4.10): read-only.
 * Locked (the reader cannot read every field of the prompt) → the padlock
 * of a locked formula; a state in `record.meta.ai` (waiting, generating,
 * failed, paused) → the value under its state (`customCells/ai.ts`); else
 * the value as its type draws it (text, or the option chip).
 */
export function renderAiCell(
  field: GridField,
  record: GridRecord,
  ctx: CellRenderContext,
): GridCell {
  const labels = ctx.labels.ai;
  if (field.ai?.locked === true) {
    const lock: ComputedMarkCell = {
      kind: GridCellKind.Custom,
      allowOverlay: false,
      readonly: true,
      copyData: labels?.locked ?? '',
      data: {
        kind: 'ob-computed-mark',
        mark: 'lock',
        text: '',
        color: ctx.palette.textSubtle,
        fontCode: ctx.palette.fontCode,
        align: 'left',
      },
    };
    return lock;
  }
  const base = renderCell(field, record.fields[field.field.id], ctx);
  const state = aiCellStateOf(record, field.field.id);
  if (state === undefined) return base;
  const text = (base as { copyData?: unknown }).copyData;
  const shown = typeof text === 'string' ? text : '';
  const label = labels?.[state] ?? '';
  const cell: AiStateCell = {
    kind: GridCellKind.Custom,
    allowOverlay: false,
    readonly: true,
    copyData: shown === '' ? label : `${shown} (${label})`,
    data: {
      kind: 'ob-ai',
      state,
      text: shown,
      colors: {
        text: ctx.palette.text,
        muted: ctx.palette.textMuted,
        track: ctx.palette.track,
        accent: ctx.palette.accent,
        warning: ctx.palette.warning,
        danger: ctx.palette.danger,
      },
    },
  };
  return cell;
}
