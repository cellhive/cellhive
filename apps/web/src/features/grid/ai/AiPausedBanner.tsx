import { Button, Spinner } from '@cellhive/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CirclePause, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { aiCellStateOf, aiPausedOf } from '../../../lib/ai/ai-field';
import { aiApi } from '../../../lib/api/ai';
import { keys } from '../../../lib/query/keys';
import { showErrorToast, showToast } from '../../../lib/toast/toast';

import type { AiFieldGenerateRequest, FieldDto, RecordListResponse } from '@cellhive/contracts';
import type { QueryClient } from '@tanstack/react-query';

/** Most record ids one generate request takes (`scope: records`, CONTRACTS §29.5). */
const MAX_IDS = 1_000;

/** Paused cells of `fieldId` in the grid's loaded blocks (their `record.meta.ai`). */
export function pausedRecordIds(client: QueryClient, tableId: string, fieldId: string): string[] {
  const ids = new Set<string>();
  for (const [, page] of client.getQueriesData<RecordListResponse>({
    queryKey: keys.recordBlocks(tableId),
  })) {
    // Every entry under the prefix is a page of records (blocks, tree levels, kanban columns).
    const records = Array.isArray(page?.records) ? page.records : [];
    for (const record of records) {
      if (aiCellStateOf(record, fieldId) === 'paused') ids.add(record.id);
      if (ids.size >= MAX_IDS) return [...ids];
    }
  }
  return [...ids];
}

export interface AiPausedBannerProps {
  readonly tableId: string;
  readonly fields: readonly FieldDto[];
  /** Schema rights on the table: "Resume" generates (CONTRACTS §29.5). */
  readonly canManage: boolean;
  /** "Organization settings › AI" for owners/admins, `null` for others. */
  readonly settingsPath: string | null;
}

/**
 * AI fields whose generation is paused (T915, research S8 §5.6, like the
 * computed banner of F§4.8): the quota of the day is used up, or AI / record
 * values were turned off for the organization — from the field's `ai_state`
 * (`schema.changed` keeps it current). Quota: "Resume" (schema managers)
 * generates the paused cells again now (a raised quota), else they go on
 * by themselves after the daily reset; AI or record data off: the settings
 * page for owners/admins.
 */
export function AiPausedBanner({ tableId, fields, canManage, settingsPath }: AiPausedBannerProps) {
  const { t } = useTranslation('grid');
  const queryClient = useQueryClient();
  const resume = useMutation({
    mutationFn: (field: FieldDto) => {
      // Any generate request resumes every paused row of the field; it needs one id at least.
      const ids = pausedRecordIds(queryClient, tableId, field.id);
      const body: AiFieldGenerateRequest =
        ids.length > 0
          ? { scope: 'records', record_ids: ids as AiFieldGenerateRequest['record_ids'] }
          : { scope: 'empty' };
      return aiApi.generateField(field.id, body);
    },
    onSuccess: (_result, field) => {
      showToast({ variant: 'success', message: t('ai.banner.resumed', { name: field.name }) });
      void queryClient.invalidateQueries({ queryKey: keys.fields(tableId) });
      void queryClient.invalidateQueries({ queryKey: keys.recordBlocks(tableId) });
    },
    onError: (error) => {
      showErrorToast(error);
    },
  });
  const paused = fields.flatMap((field) => {
    const state = aiPausedOf(field);
    return state === null || field.locked === true ? [] : [{ field, ...state }];
  });
  if (paused.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-col" data-testid="ai-paused-banner">
      {paused.map(({ field, count, reason }) => (
        <div
          key={field.id}
          role="status"
          className="flex min-h-10 items-center gap-2 border-b border-option-3 bg-option-3 px-4 py-1.5 text-label font-normal text-on-option-3 motion-safe:animate-reveal max-md:flex-wrap"
        >
          <CirclePause aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            <strong className="font-semibold">
              {t('ai.banner.title', { name: field.name, count })}
            </strong>{' '}
            {t(`ai.banner.reason.${reason ?? 'quota'}`)}
          </span>
          {reason === 'quota' || reason === null ? (
            canManage ? (
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 text-on-option-3 max-lg:h-control"
                disabled={resume.isPending}
                data-testid="ai-resume"
                onClick={() => {
                  resume.mutate(field);
                }}
              >
                {resume.isPending ? <Spinner /> : <Play aria-hidden="true" className="size-3.5" />}
                {t('ai.banner.resume')}
              </Button>
            ) : null
          ) : settingsPath === null ? null : (
            <Link
              to={settingsPath}
              className="inline-flex min-h-7 shrink-0 items-center rounded-md px-2 font-medium underline-offset-2 hover:underline max-lg:min-h-control"
            >
              {t('ai.banner.settings')}
            </Link>
          )}
        </div>
      ))}
    </div>
  );
}

export default AiPausedBanner;
