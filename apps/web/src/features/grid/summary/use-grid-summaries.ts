import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../lib/api/client';
import { keys, stableQueryHash } from '../../../lib/query/keys';
import { sameValue } from '../../../lib/views/config';
import { formatSummary, type SummaryTexts } from '../../../lib/views/summary/format';
import { alignsRight, applicableSummaries } from '../../../lib/views/summary/functions';
import { summaryRequestOf, useSummaries } from '../../../lib/views/summary/use-summaries';
import { groupKey } from '../groups/group-model';

import type { GridGroupRow, GroupSummary } from '../../../grid';
import type { EffectiveRecordQuery } from '../../../lib/query/keys';
import type { ViewConfigState } from '../../../lib/views/use-view-config';
import type { FieldDto, SummaryFunction } from '@cellhive/contracts';
import type { LocaleContext } from '@cellhive/field-types';

export interface GridSummariesOptions {
  readonly tableId: string;
  readonly state: ViewConfigState;
  /** The grid's record query (view, temporary filter, search, group). */
  readonly query: EffectiveRecordQuery;
  readonly permissionVersion: number;
  /** Fields the user reads. */
  readonly fields: readonly FieldDto[];
  readonly locale: LocaleContext;
  /** The bar is on screen (a grid view with the summary bar component). */
  readonly enabled: boolean;
}

/**
 * `422 UNKNOWN_FIELD` on `summaries.*`: a field of the request the user no
 * longer reads or that became `locked` for them (CONTRACTS §1.4, T501) —
 * the field schema on screen is older than the user's access.
 */
export function isStaleSummaryField(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.status === 422 &&
    error.errors.some((item) => item.code === 'UNKNOWN_FIELD' && item.path.startsWith('summaries.'))
  );
}

/**
 * The summary bar of a grid view (T472, FRONTEND §3.3): the summaries on
 * screen (saved ⊕ temporary, entries no longer valid skipped), their data,
 * how to change one (a temporary change, saved with the view's Save bar —
 * S4b decision 8) and the summaries of each group header, matched by the
 * group's key (field ids and values of its levels, like the group layout).
 *
 * Race (T501): the access changes between loading the fields and asking for
 * the summaries, so a temporary summary names a field that is now `locked`
 * or unreadable → `422 UNKNOWN_FIELD`. The fields are loaded again (the bar
 * then leaves the field out and asks again with a new request) or, when
 * they did not change, the same request is sent again — once per request,
 * shown as busy, never as an error unless that second answer fails too.
 */
export function useGridSummaries({
  tableId,
  state,
  query,
  permissionVersion,
  fields,
  locale,
  enabled,
}: GridSummariesOptions) {
  const { t } = useTranslation('grid');
  const effective = state.config.summaries;
  const saved = state.saved.summaries;
  const config = useMemo(() => applicableSummaries(effective, fields), [effective, fields]);
  const request = useMemo(
    () =>
      summaryRequestOf({
        query,
        // Unchanged: the saved ones as they are (the server skips stale entries itself).
        summaries: sameValue(effective ?? {}, saved ?? {}) ? (saved ?? {}) : config,
        saved,
      }),
    [query, effective, saved, config],
  );
  const hasSummaries = Object.keys(config).length > 0;
  const data = useSummaries({
    tableId,
    request,
    permissionVersion,
    enabled: enabled && hasSummaries,
  });
  const queryClient = useQueryClient();
  const requestKey = `${tableId}:${String(permissionVersion)}:${stableQueryHash(request)}`;
  const staleField = isStaleSummaryField(data.error);
  const recoveryStarted = useRef<string | null>(null);
  const [recoveredFor, setRecoveredFor] = useState<string | null>(null);
  useEffect(() => {
    if (!staleField || recoveryStarted.current === requestKey) return;
    recoveryStarted.current = requestKey;
    const fieldsKey = keys.fields(tableId);
    const before = queryClient.getQueryData(fieldsKey);
    const summariesKey = keys.summaries(tableId, stableQueryHash(request), permissionVersion);
    void queryClient
      .invalidateQueries({ queryKey: fieldsKey })
      .then(() =>
        // New fields give a new request (without the field); same fields: send it again.
        queryClient.getQueryData(fieldsKey) === before
          ? queryClient.refetchQueries({ queryKey: summariesKey, exact: true, type: 'active' })
          : undefined,
      )
      .catch(() => undefined)
      .finally(() => {
        setRecoveredFor(requestKey);
      });
  }, [staleField, requestKey, queryClient, tableId, request, permissionVersion]);
  const recovering = staleField && recoveredFor !== requestKey;

  const { change } = state;
  const onChange = useCallback(
    (fieldId: string, fn: SummaryFunction | null) => {
      const next = Object.fromEntries(
        Object.entries(effective ?? {}).filter(([id]) => id !== fieldId),
      ) as Record<string, SummaryFunction>;
      if (fn !== null) next[fieldId] = fn;
      change({ summaries: next }, { temporary: true });
    },
    [effective, change],
  );

  const texts = useMemo<SummaryTexts>(
    () => ({
      label: (fn) => t(`summary.short.${fn}`),
      days: (days) => t('summary.days', { count: days }),
    }),
    [t],
  );
  const result = hasSummaries ? data.data : undefined;
  const byKey = useMemo(() => {
    const map = new Map<string, readonly GroupSummary[]>();
    if (result === undefined || result.groups.length === 0) return map;
    const byId = new Map(fields.map((field) => [field.id as string, field]));
    const fieldIds = result.group.map((level) => level.field);
    for (const group of result.groups) {
      const items: GroupSummary[] = [];
      for (const [fieldId, summary] of Object.entries(group.summaries)) {
        const field = byId.get(fieldId);
        if (field === undefined || config[fieldId] !== summary.fn) continue;
        const shown = formatSummary(field, summary, locale, texts);
        items.push({ fieldId, label: shown.label, value: shown.value, right: alignsRight(field) });
      }
      map.set(groupKey(fieldIds.slice(0, group.values.length), group.values), items);
    }
    return map;
  }, [result, fields, config, locale, texts]);
  const groupSummaries = useCallback(
    (group: GridGroupRow) => (byKey.size === 0 ? undefined : byKey.get(group.key)),
    [byKey],
  );

  return {
    config,
    result,
    busy: data.busy || recovering,
    error: hasSummaries && !recovering ? data.error : null,
    retry: data.retry,
    onChange,
    onMessage: data.onMessage,
    groupSummaries,
  };
}
