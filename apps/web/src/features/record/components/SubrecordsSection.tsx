import { Button, Skeleton, Spinner, Tooltip } from '@cellhive/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, CornerDownRight, RotateCw } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { CellValue } from '../../../grid/display/CellValue';
import { TreeIcon } from '../../../grid/tree/TreeIcon';
import { recordTreeApi } from '../../../lib/api/record-tree';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../lib/i18n/format';
import { keys } from '../../../lib/query/keys';
import { showErrorToast } from '../../../lib/toast/toast';
import { childCountOf, childrenKey, childrenQuery, MAX_TREE_LEVELS } from '../tree';

import type { GridField } from '../../../grid/types';
import type { LocaleContext } from '@cellhive/field-types';

export interface SubrecordsSectionProps {
  readonly tableId: string;
  readonly recordId: string;
  /** The primary field: the title of each sub-record. */
  readonly primary: GridField | undefined;
  readonly locale: LocaleContext;
  /** "Add sub-record" is offered (right to add records, panel not locked). */
  readonly canAdd: boolean;
  /** The record is at the deepest level (10): it cannot get sub-records. */
  readonly atMaxDepth: boolean;
  readonly onNavigate: (recordId: string) => void;
}

/** Plain text of a primary field value, for accessible names. */
function plainTitle(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number') return String(value);
  return null;
}

/**
 * "Sub-records" of the record panel (design board S4RecordMobile, T417):
 * the children (first 50, "50 / N" beyond), each opened in the panel, and a
 * dashed "Add sub-record" that creates a child and opens it.
 */
export function SubrecordsSection({
  tableId,
  recordId,
  primary,
  locale,
  canAdd,
  atMaxDepth,
  onNavigate,
}: SubrecordsSectionProps) {
  const { t } = useTranslation('record');
  const format = useFormatters();
  const queryClient = useQueryClient();
  const headingId = useId();
  const children = useQuery(childrenQuery(tableId, recordId));

  const create = useMutation({
    mutationFn: () => recordTreeApi.createChild(tableId, recordId),
    onSuccess: ({ records }) => {
      void queryClient.invalidateQueries({ queryKey: childrenKey(tableId, recordId) });
      void queryClient.invalidateQueries({ queryKey: keys.recordBlocks(tableId) });
      const created = records[0];
      if (created !== undefined) onNavigate(created.id);
    },
    onError: (error) => {
      showErrorToast(error);
    },
  });

  const list = children.data;
  const total = list === undefined ? null : childCountOf(list);
  const shown = list?.records.length ?? 0;
  let count: string | null = null;
  if (total !== null) {
    count =
      total > shown
        ? t('tree.countPartial', { shown: format.number(shown), total: format.number(total) })
        : format.number(total);
  }

  const empty = <span className="text-fg-subtle">{t('untitled')}</span>;
  return (
    <section aria-labelledby={headingId} className="mt-4 flex flex-col gap-2">
      <h3
        id={headingId}
        className="flex items-center gap-1.5 text-label font-normal text-fg-muted sm:px-0"
      >
        <TreeIcon className="size-3.5 shrink-0" />
        <span>{t('tree.subrecords')}</span>
        {count === null ? null : <span data-testid="subrecords-count">{count}</span>}
      </h3>
      {children.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <span className="sr-only">{t('tree.loading')}</span>
          <Skeleton className="h-11 w-full" />
        </div>
      ) : children.isError ? (
        <div className="flex flex-col items-start gap-2">
          <ErrorAlert error={children.error} className="w-full" />
          <Button
            variant="secondary"
            size="toolbar"
            className="px-2.5"
            onClick={() => {
              void children.refetch();
            }}
          >
            <RotateCw aria-hidden="true" />
            {t('tree.retry')}
          </Button>
        </div>
      ) : shown === 0 ? null : (
        <ul aria-labelledby={headingId} className="flex flex-col gap-2">
          {children.data.records.map((child) => {
            const value = primary === undefined ? undefined : child.fields[primary.field.id];
            const title = plainTitle(value) ?? t('untitled');
            return (
              <li
                key={child.id}
                className="flex items-center gap-2 rounded-lg border border-line py-1 pr-1 pl-3"
              >
                <span className="min-w-0 flex-1 truncate font-medium">
                  {primary === undefined ? (
                    title
                  ) : (
                    <CellValue field={primary} value={value} locale={locale} empty={empty} />
                  )}
                </span>
                <Tooltip content={t('tree.open', { title })}>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('tree.open', { title })}
                    onClick={() => {
                      onNavigate(child.id);
                    }}
                  >
                    <ChevronRight aria-hidden="true" />
                  </Button>
                </Tooltip>
              </li>
            );
          })}
        </ul>
      )}
      {!canAdd ? null : atMaxDepth ? (
        <p className="text-label font-normal text-fg-muted">
          {t('tree.maxDepth', { limit: MAX_TREE_LEVELS })}
        </p>
      ) : (
        <Button
          variant="secondary"
          className="w-full rounded-lg border-dashed font-normal lg:h-9"
          disabled={create.isPending}
          onClick={() => {
            create.mutate();
          }}
        >
          {create.isPending ? <Spinner /> : <CornerDownRight aria-hidden="true" />}
          {t('tree.add')}
        </Button>
      )}
    </section>
  );
}
