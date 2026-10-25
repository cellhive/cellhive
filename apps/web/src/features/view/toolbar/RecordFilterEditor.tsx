import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { fieldsQuery } from '../../../lib/query/queries';

import { checkFilter, filterableFields, fromFilter, type GroupItem } from './filter-model';
import { FilterBuilder } from './FilterBuilder';

import type { RecordFilterEditorProps } from '../../../lib/schema/field-tools';

/**
 * The conditions of a link field (`record_filter`, T413): the view filter
 * builder (T311) over the fields of the linked table the user reads. Only
 * a complete, valid tree reaches `onChange` (incomplete conditions are kept
 * here, shown as not applied); the server validates it again on save.
 */
export function RecordFilterEditor({
  tableId,
  orgId,
  value,
  onChange,
  emptyText,
}: RecordFilterEditorProps) {
  const { t } = useTranslation('toolbar');
  const fields = useQuery(fieldsQuery(tableId));
  const filterable = useMemo(() => filterableFields(fields.data?.items ?? []), [fields.data]);
  const [root, setRoot] = useState<GroupItem>(() => fromFilter(value));
  const checked = useMemo(() => checkFilter(root, filterable), [root, filterable]);
  if (fields.isPending) return null;
  if (filterable.length === 0) {
    return <p className="text-body text-fg-muted">{t('filter.noFields')}</p>;
  }
  return (
    <div
      className="flex min-w-0 flex-col gap-2 overflow-x-auto rounded-md border border-line p-3"
      onKeyDown={(event) => {
        // Enter in a value box must not submit the field dialog around it.
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
          event.preventDefault();
        }
      }}
    >
      <FilterBuilder
        root={root}
        fields={filterable}
        issues={checked.issues}
        incomplete={checked.incomplete}
        orgId={orgId}
        // Not a view: the conditions narrow the linked table's records (T421a).
        emptyText={emptyText ?? t('filter.emptyLinked')}
        onChange={(next) => {
          setRoot(next);
          const result = checkFilter(next, filterable);
          if (result.issues.size > 0) return;
          onChange(result.filter as Readonly<Record<string, unknown>> | null);
        }}
      />
    </div>
  );
}
