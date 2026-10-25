import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { CellValue } from '../../../grid/display/CellValue';
import { toGridField } from '../../../grid/types';
import { useFormatters } from '../../../lib/i18n/format';

import type { FieldDto, WidgetDataDto } from '@cellhive/contracts';

const CELL_CLASS = 'max-w-64 border-b border-line px-2 py-1.5 align-top';

/**
 * A table widget in `records` mode (T811, CONTRACTS §28.3): the top N
 * records with the chosen fields, each cell drawn like the record panel
 * (`CellValue`, the grid's DOM formatter). Its own chunk: `field-types`
 * comes with it only when such a widget is on screen.
 */
export function RecordsTable({
  caption,
  data,
  fields,
}: {
  readonly caption: string;
  readonly data: WidgetDataDto;
  readonly fields: readonly FieldDto[];
}) {
  const { t } = useTranslation('dashboard');
  const format = useFormatters();
  const locale = useMemo(
    () => ({ locale: format.locale, timeZone: format.timeZone }),
    [format.locale, format.timeZone],
  );
  const byId = useMemo(() => new Map(fields.map((field) => [field.id, field])), [fields]);
  const columns = data.columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => column.role === 'field');
  return (
    <div className="size-full overflow-auto" tabIndex={0} role="region" aria-label={caption}>
      <table className="w-full border-collapse text-left text-body" data-testid="widget-records">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 bg-surface">
          <tr>
            {columns.map(({ column }) => (
              <th
                key={column.key}
                scope="col"
                className="border-b border-line px-2 py-1.5 text-label font-medium text-fg-muted"
              >
                {(column.field_id === null ? undefined : byId.get(column.field_id)?.name) ??
                  t('table.unknownField')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => {
            const recordId = typeof row[0] === 'string' ? row[0] : JSON.stringify(row[0]);
            return (
              <tr key={recordId}>
                {columns.map(({ column, index }, position) => {
                  const field = column.field_id === null ? undefined : byId.get(column.field_id);
                  const content =
                    field === undefined ? null : (
                      <CellValue
                        field={toGridField(field)}
                        value={row[index]}
                        locale={locale}
                        compact
                      />
                    );
                  return position === 0 ? (
                    <th key={column.key} scope="row" className={`${CELL_CLASS} font-normal`}>
                      {content}
                    </th>
                  ) : (
                    <td key={column.key} className={CELL_CLASS}>
                      {content}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default RecordsTable;
