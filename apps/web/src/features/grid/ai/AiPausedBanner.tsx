import { Button, Spinner } from '@cellhive/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CirclePause, Clock, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { aiPausedOf, aiRetryAtOf } from '../../../lib/ai/ai-field';
import { aiApi } from '../../../lib/api/ai';
import { useFormatters } from '../../../lib/i18n/format';
import { keys } from '../../../lib/query/keys';
import { showErrorToast, showToast } from '../../../lib/toast/toast';

import type { AiFieldStateDto, FieldDto } from '@cellhive/contracts';

export interface AiPausedBannerProps {
  readonly tableId: string;
  readonly fields: readonly FieldDto[];
  /** Schema rights on the table: "Resume" generates (CONTRACTS §29.5). */
  readonly canManage: boolean;
  /** "Organization settings › AI" for owners/admins, `null` for others. */
  readonly settingsPath: string | null;
}

/** Milliseconds from now until just after `at` (a timer in an effect, never during render). */
function msUntil(at: number): number {
  return Math.max(0, at - Date.now()) + 1;
}

/** The sentence that says why the cells of a field are paused (T1002: what the provider rejected). */
export function aiPauseReasonKey(
  reason: AiFieldStateDto['paused_reason'],
  detail: AiFieldStateDto['paused_detail'],
): string {
  if (reason === 'provider_error') return `ai.banner.reason.provider_error.${detail ?? 'unknown'}`;
  return `ai.banner.reason.${reason ?? 'quota'}`;
}

/**
 * AI fields whose generation is paused (T915, research S8 §5.6, like the
 * computed banner of F§4.8), from the field's `ai_state` (`schema.changed`
 * keeps it current): the quota of the day is used up, AI or record values
 * were turned off, or the provider rejected the settings (T1002: the key,
 * the URL or model, a blocked address — each its own sentence). "Resume"
 * (schema managers) generates the paused cells again (`scope: paused`:
 * never a cell that was not queued) — after a raised quota, or once the
 * provider accepts the settings; the settings page for owners/admins. A
 * field whose provider asked to wait says when generating goes on.
 */
export function AiPausedBanner({ tableId, fields, canManage, settingsPath }: AiPausedBannerProps) {
  const { t } = useTranslation('grid');
  const format = useFormatters();
  const queryClient = useQueryClient();
  const resume = useMutation({
    mutationFn: (field: FieldDto) => aiApi.generateField(field.id, { scope: 'paused' }),
    onSuccess: (_result, field) => {
      showToast({ variant: 'success', message: t('ai.banner.resumed', { name: field.name }) });
      void queryClient.invalidateQueries({ queryKey: keys.fields(tableId) });
      void queryClient.invalidateQueries({ queryKey: keys.recordBlocks(tableId) });
    },
    onError: (error) => {
      showErrorToast(error);
    },
  });
  const visible = fields.filter((field) => field.locked !== true);
  const paused = visible.flatMap((field) => {
    const state = aiPausedOf(field);
    return state === null ? [] : [{ field, ...state }];
  });
  const [now, setNow] = useState(() => Date.now());
  const waiting = visible.flatMap((field) => {
    const at = aiRetryAtOf(field, now);
    return at === null ? [] : [{ field, at }];
  });
  // The wait ends by itself: its line goes when the first time passes.
  const next = waiting.reduce((min, item) => Math.min(min, Date.parse(item.at)), Infinity);
  useEffect(() => {
    if (!Number.isFinite(next)) return undefined;
    const timer = setTimeout(() => {
      setNow(Date.now());
    }, msUntil(next));
    return () => {
      clearTimeout(timer);
    };
  }, [next]);
  if (paused.length === 0 && waiting.length === 0) return null;
  const row =
    'flex min-h-10 items-center gap-2 border-b border-option-3 bg-option-3 px-4 py-1.5 text-label font-normal text-on-option-3 motion-safe:animate-reveal max-md:flex-wrap';
  return (
    <div className="flex shrink-0 flex-col" data-testid="ai-paused-banner">
      {paused.map(({ field, count, reason, detail }) => {
        const resumable = reason === 'quota' || reason === null || reason === 'provider_error';
        const toSettings = reason !== 'quota' && reason !== null;
        return (
          <div key={field.id} role="status" className={row} data-reason={reason ?? 'quota'}>
            <CirclePause aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              <strong className="font-semibold">
                {t('ai.banner.title', { name: field.name, count })}
              </strong>{' '}
              {t(aiPauseReasonKey(reason, detail))}
            </span>
            {resumable && canManage ? (
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
            ) : null}
            {toSettings && settingsPath !== null ? (
              <Link
                to={settingsPath}
                className="inline-flex min-h-7 shrink-0 items-center rounded-md px-2 font-medium underline-offset-2 hover:underline max-lg:min-h-control"
              >
                {t('ai.banner.settings')}
              </Link>
            ) : null}
          </div>
        );
      })}
      {waiting.map(({ field, at }) => (
        <div key={field.id} role="status" className={row} data-reason="retry">
          <Clock aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            <strong className="font-semibold">
              {t('ai.banner.waitingTitle', { name: field.name })}
            </strong>{' '}
            {t('ai.banner.waiting', { time: format.dateTime(at) })}
          </span>
        </div>
      ))}
    </div>
  );
}

export default AiPausedBanner;
