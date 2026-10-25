import { cn } from '@cellhive/ui';

export interface DataTableColumn {
  readonly key: string;
  readonly label: string;
  /** Right-aligned, tabular digits. */
  readonly numeric: boolean;
}

export interface DataTableProps {
  readonly caption: string;
  readonly columns: readonly DataTableColumn[];
  /** Formatted cells, one array per row in `columns` order; the first cell names the row. */
  readonly rows: readonly (readonly string[])[];
  /** Rows drawn muted (the "Other" group). */
  readonly mutedRows?: ReadonlySet<number> | undefined;
  readonly testId?: string;
}

/**
 * A plain `<table>` of a widget's numbers (T811): the pivot table widget and
 * "View as table" of every chart (FRONTEND §9.2 — a text alternative with
 * the same numbers). Column headers `scope="col"`, the first cell of each
 * row a row header; scrolls inside the widget, never the page.
 */
const CELL_CLASS = 'border-b border-line px-2 py-1.5 align-top';
const NUMERIC_CLASS = 'text-right tabular-nums';

export function DataTable({ caption, columns, rows, mutedRows, testId }: DataTableProps) {
  return (
    <div
      className="size-full overflow-auto"
      // A keyboard user must be able to scroll it (axe `scrollable-region-focusable`).
      tabIndex={0}
      role="region"
      aria-label={caption}
    >
      <table className="w-full border-collapse text-left text-body" data-testid={testId}>
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 bg-surface">
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  'border-b border-line px-2 py-1.5 text-label font-medium text-fg-muted',
                  column.numeric && 'text-right',
                )}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className={cn(mutedRows?.has(rowIndex) === true && 'text-fg-muted')}>
              {row.map((cell, cellIndex) => {
                const column = columns[cellIndex];
                const className = cn(CELL_CLASS, column?.numeric === true && NUMERIC_CLASS);
                return cellIndex === 0 ? (
                  <th
                    key={column?.key ?? cellIndex}
                    scope="row"
                    className={cn(className, 'font-normal')}
                  >
                    {cell}
                  </th>
                ) : (
                  <td key={column?.key ?? cellIndex} className={className}>
                    {cell}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
