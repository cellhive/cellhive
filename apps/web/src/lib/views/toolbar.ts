import type { AskAiEntryProps } from '../ai/ask';
import type { SummaryBarProps } from './summary/types';
import type { ViewConfigState } from './use-view-config';
import type { FieldDto, ViewDto } from '@cellhive/contracts';
import type { ComponentType } from 'react';

/**
 * Label of a toolbar button (T320b): below 1280 px only the icon shows (the
 * button keeps its name), so the toolbar stays on one row. A viewport query,
 * not a container query: a container would trap the fixed bottom sheet of
 * the popovers on phones.
 */
export const TOOLBAR_LABEL = 'truncate max-xl:hidden';

/**
 * Props of the view toolbar's filter and sort controls
 * (`features/view/toolbar`, T311).
 */
export interface ViewToolbarProps {
  readonly view: ViewDto;
  /** Fields the user reads, in server order: the only ones the builders list. */
  readonly fields: readonly FieldDto[];
  /** Organization of the base (user pickers of the filter builder). */
  readonly orgId: string;
  /** The view's effective config and how to change it (`useViewConfig`). */
  readonly state: ViewConfigState;
  /**
   * The error of the last record query, if any: `422 INVALID_FILTER` marks
   * the conditions of the (temporary) filter it names.
   */
  readonly queryError?: unknown;
  /**
   * Collapse / expand every group of a grouped grid (T320a): shown in the
   * group panel (with the header menu, the keyboard way to them).
   */
  readonly groupActions?: {
    readonly collapseAll: () => void;
    readonly expandAll: () => void;
  };
  /**
   * (T816) The grid offers its color rules here (grid views of the member
   * app only; shared views and boards do not).
   */
  readonly colorRules?: boolean;
  /**
   * Sub-record tree of a grid view (T417): how many levels open by default
   * for this user (1…10) and whether they may turn sub-records on for the
   * table (schema rights). Absent: the tree control is not shown.
   */
  readonly treeActions?: {
    readonly levels: number;
    readonly openLevels: (levels: number) => void;
    readonly canEnable: boolean;
  };
}

/** Props of the view's search box (Ctrl/⌘+F focuses it while it is shown). */
export interface ViewSearchProps {
  /** Fields the user reads: search looks in the primary field, so it needs it. */
  readonly fields: readonly FieldDto[];
  readonly search: string;
  readonly onSearchChange: (search: string) => void;
  /** Escape in an empty box: the focus goes back to the records. */
  readonly onLeaveSearch?: (() => void) | undefined;
}

/**
 * The toolbar parts a view screen of another feature (the grid) gets from
 * the route, like the field tools (FRONTEND §1.2). The screen keeps the
 * search text: it is part of its record query (`viewRecordQuery`).
 */
export interface ViewToolbarComponents {
  /** (T472) The summary bar under a grid; absent: the record count alone. */
  readonly SummaryBar?: ComponentType<SummaryBarProps>;
  readonly Controls: ComponentType<ViewToolbarProps>;
  readonly Search: ComponentType<ViewSearchProps>;
  /**
   * (T914) "Ask AI" of the table, before the search box: renders nothing
   * while AI is not available in the organization; its panel is lazy.
   */
  readonly AskAi?: ComponentType<AskAiEntryProps>;
}
