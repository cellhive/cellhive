import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useFormatters } from '../../../lib/i18n/format';
import { fieldsQuery, tableQuery } from '../../../lib/query/queries';
import { describeNotification, fieldIdsOf, needsTableName, type ItemView } from '../model/types';

import type { NotificationDto } from '@cellhive/contracts';

/** Names in the panel do not need to follow schema changes closely. */
const NAMES_STALE_MS = 5 * 60_000;

/**
 * The fields of the item's table as the viewer reads them now (`no_perm`
 * fields are absent, CONTRACTS §2), when the item names fields; one
 * request per table, shared with the table screens' cache.
 */
export function useItemFields(item: NotificationDto) {
  const enabled = item.table_id !== null && item.base !== null && fieldIdsOf(item).length > 0;
  return useQuery({
    ...fieldsQuery(item.table_id ?? ''),
    enabled,
    staleTime: NAMES_STALE_MS,
  });
}

/**
 * Title, body, status chip and extras of a notification (T552): the pure
 * renderer of its type (`model/types/*`) with the viewer's language, time
 * zone and the names they can still read (fields; the table of an import).
 */
export function useItemView(item: NotificationDto): ItemView {
  const { t, i18n } = useTranslation('notifications');
  const format = useFormatters();
  const fields = useItemFields(item);
  const table = useQuery({
    ...tableQuery(item.table_id ?? ''),
    enabled: needsTableName(item),
    staleTime: NAMES_STALE_MS,
  });
  const names = useMemo(
    () => new Map((fields.data?.items ?? []).map((field) => [field.id as string, field.name])),
    [fields.data],
  );
  const tableName = table.data?.name ?? null;
  return useMemo(
    () =>
      describeNotification(item, {
        t: (key, options) => (options === undefined ? t(key) : t(key, options)),
        locale: i18n.language,
        format,
        fieldName: (fieldId) => names.get(fieldId) ?? null,
        tableName,
        now: new Date(),
      }),
    [item, t, i18n.language, format, names, tableName],
  );
}
