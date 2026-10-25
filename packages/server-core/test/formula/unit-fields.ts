/**
 * Fields of the compiler unit tests and the LET bench (BACKLOG T454):
 * the field set of T454's interim fixture. Its cases now live in the shared
 * fixture of T453 (`packages/formula-engine/test/fixtures/formula-cases.json`,
 * ids `t454-…`), which adds these fields to its formula table.
 */
import type { FormulaFixtureField } from './fixture-types.js';

export const STATUS_OPTIONS = [
  { id: 'opt_moi0000000000000', name: 'Mới' },
  { id: 'opt_xong000000000000', name: 'Xong' },
  { id: 'opt_dagiao0000000000', name: 'Đã giao' },
];
export const TAG_OPTIONS = [
  { id: 'opt_vip0000000000000', name: 'VIP' },
  { id: 'opt_noibo00000000000', name: 'Nội bộ' },
  { id: 'opt_khan000000000000', name: 'Khẩn' },
];

export const UNIT_FIELDS: readonly FormulaFixtureField[] = [
  { name: 'Title', type: 'text' },
  { name: 'Name', type: 'text' },
  { name: 'Note', type: 'text' },
  { name: 'Amount', type: 'number' },
  { name: 'Qty', type: 'number' },
  { name: 'Done', type: 'checkbox' },
  { name: 'Status', type: 'select', options: { multiple: false, options: STATUS_OPTIONS } },
  { name: 'Tags', type: 'select', options: { multiple: true, options: TAG_OPTIONS } },
  { name: 'Due', type: 'datetime', options: { style: { format: 'dd/MM/yyyy' } } },
  { name: 'At', type: 'datetime', options: { style: { format: 'dd/MM/yyyy HH:mm' } } },
  { name: 'Owner', type: 'user', options: { multiple: true } },
  { name: 'Files', type: 'attachment' },
];
