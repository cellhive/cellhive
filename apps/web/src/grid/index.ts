/**
 * Grid adapter (FRONTEND §1.3): the only place that knows glide-data-grid.
 * Features import from here; the library itself never leaves `grid/`.
 */
export {
  GridView,
  type GridColumnLayout,
  type GridViewHandle,
  type GridViewport,
  type GridViewProps,
} from './GridView';
export {
  orderFields,
  orderGridFields,
  toGridField,
  type GridField,
  type GridRecord,
} from './types';
export {
  dataRangeOf,
  isDataKind,
  type GridGroupRow,
  type GridRowFrame,
  type GridRowKind,
  type GridRowModel,
} from './rows';
export { ROW_HEIGHTS, type GridDensity } from './theme';
export { RULE_MARK_WIDTH, type GridCellPaint, type GridColorPaint } from './rule-colors';
export {
  readRuleColorTokens,
  rulePainter,
  useRulePainter,
  useRuleColorTokens,
  type PaintedRule,
  type RuleColorTokens,
} from './rule-painter';
export { computedErrorBadges, type HeaderBadge } from './computed-header';
export type { HeaderHint } from './a11y';
export { isEditableField } from './editors/index';
export type { EditorContext, EditorIssue, FileEditorContext, MemberOption } from './editors/types';
export {
  cellClipboardText,
  clipboardContent,
  clipboardKindOf,
  pastedWriteValue,
  parseTsv,
  pastedDisplay,
  serializeTsv,
  toHtmlTable,
  type CellMatrix,
  type ClipboardContent,
} from './clipboard';
export {
  chunkByRecord,
  fillSourceRows,
  pasteArea,
  planWrites,
  UndoHistory,
  UNDO_LIMIT,
  type PasteArea,
  type PlannedWrite,
  type ReplayOutcome,
  type UndoSnapshot,
  type VersionRebase,
  type WritePlan,
} from './commands';
export type {
  ButtonHooks,
  CellAddress,
  CellEditHooks,
  CellEditState,
  CommitOptions,
  EditCommand,
  ColumnHooks,
  FileHooks,
  FileViewerHooks,
  GridInteractionHooks,
  GridSelectionRange,
  GroupHooks,
  GroupSummary,
  HeaderMenuAnchor,
  HeaderMenuHooks,
  LinkChipHover,
  LinkHooks,
  LinkPickerOpen,
  RecordDetailHooks,
  SelectionHooks,
  UndoHooks,
} from './hooks';
export type {
  DropPlacement,
  GridTree,
  GridTreeHooks,
  GridTreeMoves,
  GridTreeNode,
  MoveProblem,
} from './tree/types';
export { treeShortcutLabel } from './tree/keys';
export { TreeIcon } from './tree/TreeIcon';
