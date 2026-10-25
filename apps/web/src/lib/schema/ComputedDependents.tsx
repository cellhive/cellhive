import { useQueries, useQuery } from '@tanstack/react-query';
import { Search, Sigma, TriangleAlert } from 'lucide-react';
import { useId, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { fieldsQuery, tablesQuery } from '../query/queries';

/** A formula or lookup field that a change would put in error (T460 `dependents`). */
export interface ComputedDependent {
  readonly id: string;
  readonly table_id?: string | undefined;
  readonly name?: string | undefined;
  /** Known from the response (base trash); else read from the fields of its table. */
  readonly type?: 'formula' | 'lookup' | undefined;
}

/**
 * Token of the cells the fields will show (S4b decision #1): `#REF!` when
 * something they read goes away, `#VALUE!` when a type change makes their
 * definition invalid (`INVALID_CONFIG`).
 */
export type ComputedErrorToken = '#REF!' | '#VALUE!';

export interface ComputedDependentsProps {
  readonly baseId: string | undefined;
  readonly dependents: readonly ComputedDependent[];
  readonly token: ComputedErrorToken;
  /** Heading of the list; default "N formulas and lookups will show #REF!". */
  readonly title?: ReactNode;
  /** Fields left out because the caller cannot read them ("and N fields you cannot see"). */
  readonly hidden?: number;
  readonly 'data-testid'?: string;
}

/**
 * (T469; boards "S4b · Thùng rác base, xoá vĩnh viễn bảng") The formula and
 * lookup fields a delete, a type change, a link direction change or a
 * permanent delete breaks: name, "in <table>", formula or lookup, and the
 * token their cells will show. Table names come from the base's table list,
 * the kind from the fields of that table (both cached by the screens that
 * open these dialogs). Shared by the field, base and trash features.
 */
export function ComputedDependents({
  baseId,
  dependents,
  token,
  title,
  hidden = 0,
  'data-testid': testId = 'computed-dependents',
}: ComputedDependentsProps) {
  const { t, i18n } = useTranslation('common');
  const headingId = useId();
  const tables = useQuery({ ...tablesQuery(baseId ?? ''), enabled: baseId !== undefined });
  const tableIds = useMemo(
    () => [
      ...new Set(
        dependents
          .filter((item) => item.type === undefined && item.table_id !== undefined)
          .map((item) => item.table_id ?? ''),
      ),
    ],
    [dependents],
  );
  const fieldLists = useQueries({ queries: tableIds.map((id) => fieldsQuery(id)) });
  if (dependents.length === 0 && hidden === 0) return null;
  const numbers = new Intl.NumberFormat(i18n.language);
  const typeOf = (item: ComputedDependent): 'formula' | 'lookup' | undefined => {
    if (item.type !== undefined) return item.type;
    const index = tableIds.indexOf(item.table_id ?? '');
    const field = fieldLists[index]?.data?.items.find((candidate) => candidate.id === item.id);
    return field?.type === 'formula' || field?.type === 'lookup' ? field.type : undefined;
  };
  const count = dependents.length + hidden;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5" data-testid={testId}>
      <h4 id={headingId} className="flex items-center gap-1.5 text-label font-semibold text-fg">
        <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-warning" />
        {title ??
          t(token === '#REF!' ? 'dependents.ref' : 'dependents.value', {
            count,
            formatted: numbers.format(count),
          })}
      </h4>
      <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
        {dependents.map((item) => {
          const type = typeOf(item);
          const Icon = type === 'lookup' ? Search : Sigma;
          const table = tables.data?.items.find((candidate) => candidate.id === item.table_id);
          return (
            <li key={item.id} className="flex items-center gap-3 px-3 py-2">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-fg-muted">
                <Icon aria-hidden="true" className="size-4" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-body">
                  <span className="font-medium text-fg">
                    {item.name ?? t('dependents.unnamed')}
                  </span>
                  {table === undefined ? null : (
                    <span className="text-fg-muted">
                      {' '}
                      {t('dependents.inTable', { table: table.name })}
                    </span>
                  )}
                </span>
                <span className="text-label font-normal text-fg-muted">
                  {t(
                    type === 'lookup'
                      ? 'dependents.lookup'
                      : type === 'formula'
                        ? 'dependents.formula'
                        : 'dependents.computed',
                  )}
                </span>
              </span>
              <span aria-hidden="true" className="shrink-0 font-mono text-mono text-danger">
                {token}
              </span>
              <span className="sr-only">{t('dependents.tokenLabel', { token })}</span>
            </li>
          );
        })}
        {hidden > 0 ? (
          <li className="px-3 py-2 text-label font-normal text-fg-muted">
            {t('dependents.hidden', { count: hidden, formatted: numbers.format(hidden) })}
          </li>
        ) : null}
      </ul>
    </section>
  );
}
