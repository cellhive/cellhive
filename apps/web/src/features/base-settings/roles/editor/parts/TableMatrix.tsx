import { buttonVariants, cn } from '@cellhive/ui';
import { ChevronRight, Sparkles, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { effectiveFieldPerm, isReadOnlyRole, type DraftIssue, type EditorTable } from '../model';

import { tableLevelOptions } from './levels';
import { Segmented } from './Segmented';

import type { RoleAdjustmentDto, RoleKind } from '@cellhive/contracts';
import type { TablePerm, TableRule } from '@cellhive/permissions';

export interface TableRowModel {
  readonly table: EditorTable;
  readonly rule: TableRule;
  /** Table-level adjustments of the last save. */
  readonly adjustments: readonly RoleAdjustmentDto[];
  /** Field adjustments of the last save on this table. */
  readonly fieldAdjustments: number;
  readonly issues: readonly DraftIssue[];
}

export interface TableMatrixProps {
  readonly kind: RoleKind;
  readonly rows: readonly TableRowModel[];
  readonly narrow: boolean;
  /** `?table=` link of a table's detail. */
  readonly detailHref: (tableId: string) => string;
  readonly onLevel: (tableId: string, perm: TablePerm) => void;
  readonly reasonText: (adjustment: RoleAdjustmentDto) => string;
}

/** One line on what the role reads of the table (views, records, fields). */
function useRowSummary() {
  const { t } = useTranslation('baseSettings');
  return (row: TableRowModel): string => {
    const { rule, table } = row;
    if (rule.perm === 'no_perm') return t('editor.matrix.summary.noAccess');
    const parts: string[] = [];
    parts.push(
      rule.record_rule.read_scope === 'all'
        ? t('editor.matrix.summary.allRecords')
        : t('editor.matrix.summary.someRecords'),
    );
    const hidden = table.fields.filter((field) => effectiveFieldPerm(rule, field) === 'no_perm');
    if (hidden.length > 0)
      parts.push(t('editor.matrix.summary.hiddenFields', { count: hidden.length }));
    if (rule.view_rule.visible_views !== null) {
      parts.push(t('editor.matrix.summary.views', { count: rule.view_rule.visible_views.length }));
    }
    return parts.join(' · ');
  };
}

function RowNotes({
  row,
  reasonText,
}: {
  readonly row: TableRowModel;
  readonly reasonText: (adjustment: RoleAdjustmentDto) => string;
}) {
  const { t } = useTranslation('baseSettings');
  if (row.adjustments.length === 0 && row.fieldAdjustments === 0 && row.issues.length === 0) {
    return null;
  }
  return (
    <ul className="flex flex-col gap-0.5" data-testid={`table-notes-${row.table.id}`}>
      {row.adjustments.map((adjustment) => (
        <li
          key={`${adjustment.reason}:${String(adjustment.from)}`}
          className="flex items-start gap-1 text-label font-normal text-fg"
          data-testid="adjustment"
          data-reason={adjustment.reason}
        >
          <Sparkles aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-accent" />
          {reasonText(adjustment)}
        </li>
      ))}
      {row.fieldAdjustments > 0 ? (
        <li className="flex items-start gap-1 text-label font-normal text-fg">
          <Sparkles aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-accent" />
          {t('editor.matrix.fieldsAdjusted', { count: row.fieldAdjustments })}
        </li>
      ) : null}
      {row.issues.map((issue) => (
        <li key={issue} className="flex items-start gap-1 text-label font-normal text-danger">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {t(`editor.issues.${issue}`)}
        </li>
      ))}
    </ul>
  );
}

function DetailLink({ row, href }: { readonly row: TableRowModel; readonly href: string }) {
  const { t } = useTranslation('baseSettings');
  return (
    <Link
      to={href}
      className={cn(buttonVariants({ variant: 'secondary', size: 'toolbar' }), 'w-fit')}
      aria-label={t('editor.matrix.detailsOf', { name: row.table.name })}
      data-testid={`table-details-${row.table.id}`}
    >
      {t('editor.matrix.details')}
      <ChevronRight aria-hidden="true" />
    </Link>
  );
}

const TH = 'h-[34px] px-3 text-left text-label font-medium whitespace-nowrap text-fg-muted';
const TD = 'px-3 py-2.5 align-top';

/**
 * The tables of the base and the role's level on each (S6-research §4 #1):
 * a real `table` (`th scope`) from 768 px, one card per table below; each
 * level is a `radiogroup` (text + icon); "Details" opens the table's views,
 * records and fields. The server's adjustments of the last save show on the
 * row they changed.
 */
export function TableMatrix({
  kind,
  rows,
  narrow,
  detailHref,
  onLevel,
  reasonText,
}: TableMatrixProps) {
  const { t } = useTranslation('baseSettings');
  const summary = useRowSummary();
  const options = tableLevelOptions(t, kind);
  const readOnly = isReadOnlyRole(kind);
  const level = (row: TableRowModel, inCell = false) => (
    <Segmented
      className={inCell ? 'sm:grid-cols-2 @min-[34rem]:grid-cols-4' : undefined}
      label={t('editor.matrix.levelOf', { name: row.table.name })}
      value={row.rule.perm}
      options={options}
      disabled={readOnly}
      data-testid={`table-level-${row.table.id}`}
      onChange={(perm) => {
        onLevel(row.table.id, perm);
      }}
    />
  );

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-line bg-surface p-6 text-body text-fg-muted">
        {t('editor.matrix.empty')}
      </p>
    );
  }

  if (narrow) {
    return (
      <ul
        aria-label={t('editor.matrix.caption')}
        className="flex flex-col gap-3"
        data-testid="table-cards"
      >
        {rows.map((row) => (
          <li
            key={row.table.id}
            data-testid="table-row"
            data-table-id={row.table.id}
            className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
          >
            <span className="flex flex-col gap-0.5">
              <span className="font-medium break-words text-fg">{row.table.name}</span>
              <span className="text-label font-normal text-fg-muted">{summary(row)}</span>
            </span>
            {level(row)}
            <RowNotes row={row} reasonText={reasonText} />
            <DetailLink row={row} href={detailHref(row.table.id)} />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full border-collapse text-body" data-testid="table-matrix">
        <caption className="sr-only">{t('editor.matrix.caption')}</caption>
        <thead className="bg-surface-sunken">
          <tr>
            <th scope="col" className={TH}>
              {t('editor.matrix.columns.table')}
            </th>
            <th scope="col" className={TH}>
              {t('editor.matrix.columns.level')}
            </th>
            <th scope="col" className={cn(TH, 'text-right')}>
              <span className="sr-only">{t('editor.matrix.columns.details')}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row) => (
            <tr key={row.table.id} data-testid="table-row" data-table-id={row.table.id}>
              <th scope="row" className={cn(TD, 'w-[32%] text-left font-normal')}>
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium break-words text-fg">{row.table.name}</span>
                  <span className="text-label font-normal text-fg-muted">{summary(row)}</span>
                </span>
              </th>
              <td className={cn(TD, 'min-w-[22rem]')}>
                {/* Four segments in one line only when the cell fits their labels (T720:
                    beside the settings and role lists the cell is ~20rem wide even at
                    1440 px, which truncated "No access" / "Không truy cập"). */}
                <div className="@container flex flex-col gap-1.5">
                  {level(row, true)}
                  <RowNotes row={row} reasonText={reasonText} />
                </div>
              </td>
              <td className={cn(TD, 'w-0 text-right whitespace-nowrap')}>
                <DetailLink row={row} href={detailHref(row.table.id)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
