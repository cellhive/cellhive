import type { CommandSink } from './commands';
import type { AttachmentUi } from '../attachments/ui';
import type { LinkComponents } from '../links/picker';
import type {
  BaseDetail,
  FieldDto,
  RecordDto,
  SubrecordDeleteMode,
  ViewDto,
} from '@cellhive/contracts';
import type { ComponentType } from 'react';

/**
 * Record detail panel (T206, `features/record`) and record history
 * (`features/history`), FRONTEND §10. Features may not import each other
 * (FRONTEND §1.2): the route (app layer) loads the three components lazily
 * and hands them to the grid page, which hands the history components to
 * the panel. They talk through these types only.
 */

/** URL search parameter of the open record (`?record=rec_…`, FRONTEND §2). */
export const RECORD_PARAM = 'record';

/** Screen rectangle a popover is attached to. */
export interface AnchorRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What the history components need of the table they belong to. */
export interface HistoryScope {
  /** Base with `access` (revert is offered only for fields the user may edit). */
  readonly base: BaseDetail;
  readonly tableId: string;
  readonly recordId: string;
  /** Live fields of the table (`GET /tables/:id/fields`). */
  readonly fields: readonly FieldDto[];
}

/** The "History" tab / column of the panel (FRONTEND §10.3). */
export type RecordHistoryProps = HistoryScope;

/** History of one cell, in a popover (FRONTEND §10.3 "Xem lịch sử ô"). */
export interface CellHistoryProps extends HistoryScope {
  readonly fieldId: string;
  readonly anchor: AnchorRect;
  readonly onClose: () => void;
}

/** Previous / next record of the grid, `null` at an end or when not loaded. */
export interface RecordNeighbors {
  readonly previous: string | null;
  readonly next: string | null;
}

export interface RecordPanelProps {
  readonly base: BaseDetail;
  readonly tableId: string;
  readonly tableName: string;
  readonly recordId: string;
  /** Live fields of the table. */
  readonly fields: readonly FieldDto[];
  /** Fields hidden in the view: grouped, collapsed, under "Hidden fields". */
  readonly hiddenFieldIds: readonly string[];
  /** The record as the grid holds it: shown at once while the panel loads it. */
  readonly initialRecord?: RecordDto | undefined;
  readonly neighbors: RecordNeighbors;
  /** Another record (previous / next). */
  readonly onNavigate: (recordId: string) => void;
  readonly onClose: () => void;
  /** Below 768 px the panel covers the screen (FRONTEND §9.4). */
  readonly fullScreen: boolean;
  /** Edits of the panel as undo steps of the table (T205, FRONTEND §6.1). */
  readonly onCommand?: CommandSink | undefined;
  /**
   * Moves the record to the trash (T322a, the panel's "⋯" menu); resolves to
   * the number of records deleted. Absent: the user may not delete records.
   * A record with sub-records (T417) asks what happens to them in the same
   * confirmation: `children` is `promote` (they become roots, the default)
   * or `delete` (the whole branch goes to the trash).
   */
  readonly onDelete?:
    ((recordId: string, children?: SubrecordDeleteMode) => Promise<number>) | undefined;
  readonly History: ComponentType<RecordHistoryProps>;
  readonly CellHistory: ComponentType<CellHistoryProps>;
  /** The link picker for link fields (T413); absent: link fields are read-only here. */
  readonly Link?: LinkComponents | undefined;
  /** Attachment fields (T418, `features/attachment`): shown as a section of files. */
  readonly Attachments?: AttachmentUi | undefined;
  /**
   * The view open behind the panel (T416): the columns of the embedded
   * sub-tables are saved to its config (`record_detail.link_columns`).
   */
  readonly view?: ViewDto | undefined;
}

/** The three lazily loaded components the route gives the grid page. */
export interface RecordDetailComponents {
  readonly Panel: ComponentType<RecordPanelProps>;
  readonly History: ComponentType<RecordHistoryProps>;
  readonly CellHistory: ComponentType<CellHistoryProps>;
  /**
   * The attachment popover and panel section (T418, `features/attachment`):
   * lazy too, and given alongside the panel for the same reason.
   */
  readonly Attachments?: AttachmentUi | undefined;
}
