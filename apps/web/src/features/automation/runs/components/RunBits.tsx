import { cn } from '@cellhive/ui';
import {
  CircleCheck,
  CircleMinus,
  CircleX,
  Clock,
  Hourglass,
  LoaderCircle,
  Ban,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { batchOverflowOf, textParam } from '../model/runs';

import type { Formatters } from '../../../../lib/i18n/format';
import type { RecordTitle } from '../use-record-titles';
import type {
  AutomationRunDto,
  AutomationRunError,
  AutomationRunStatus,
} from '@cellhive/contracts';
import type { TFunction } from 'i18next';

const STATUS_LOOK: Record<AutomationRunStatus, { icon: LucideIcon; className: string }> = {
  queued: { icon: Clock, className: 'bg-accent-soft text-accent' },
  running: { icon: LoaderCircle, className: 'bg-accent-soft text-accent' },
  waiting: { icon: Hourglass, className: 'bg-option-3 text-on-option-3' },
  succeeded: { icon: CircleCheck, className: 'bg-success/10 text-success' },
  failed: { icon: CircleX, className: 'bg-danger/10 text-danger' },
  skipped: { icon: CircleMinus, className: 'bg-surface-sunken text-fg-muted' },
  cancelled: { icon: Ban, className: 'bg-surface-sunken text-fg-muted' },
};

/** Status of a run or step: icon + word (never color alone). */
export function StatusBadge({
  status,
  className,
}: {
  readonly status: AutomationRunStatus;
  readonly className?: string;
}) {
  const { t } = useTranslation('automationRuns');
  const look = STATUS_LOOK[status];
  const Icon = look.icon;
  return (
    <span
      className={cn(
        'inline-flex h-[22px] shrink-0 items-center gap-1 rounded-sm px-2 text-label font-medium whitespace-nowrap',
        look.className,
        className,
      )}
      data-status={status}
    >
      <Icon aria-hidden="true" className="size-3" />
      {t(`status.${status}`)}
    </span>
  );
}

/** Icon of a step in the timeline (`null` status: the action did not run). */
export function StepIcon({ status }: { readonly status: AutomationRunStatus | null }) {
  if (status === null) {
    return <CircleMinus aria-hidden="true" className="size-[18px] text-fg-subtle" />;
  }
  const look = STATUS_LOOK[status];
  const Icon = look.icon;
  const color =
    status === 'succeeded'
      ? 'text-success'
      : status === 'failed'
        ? 'text-danger'
        : status === 'waiting'
          ? 'text-warning'
          : status === 'running' || status === 'queued'
            ? 'text-accent'
            : 'text-fg-muted';
  return <Icon aria-hidden="true" className={cn('size-[18px]', color)} />;
}

/** "84 ms", "1.2 s", "3 min" (the active time of a run or a step). */
export function formatDuration(ms: number, format: Formatters, t: TFunction): string {
  if (ms < 1000) return t('automationRuns:duration.ms', { value: format.number(Math.round(ms)) });
  if (ms < 60_000) {
    const seconds = new Intl.NumberFormat(format.locale, { maximumFractionDigits: 1 }).format(
      ms / 1000,
    );
    return t('automationRuns:duration.s', { value: seconds });
  }
  if (ms < 3_600_000) {
    return t('automationRuns:duration.min', { value: format.number(Math.round(ms / 60_000)) });
  }
  const hours = new Intl.NumberFormat(format.locale, { maximumFractionDigits: 1 }).format(
    ms / 3_600_000,
  );
  return t('automationRuns:duration.h', { value: hours });
}

export interface ErrorTextContext {
  readonly t: TFunction;
  readonly format: Formatters;
  /** Name of a user id (`cancelled_by_user`), `null` when unknown. */
  readonly userName: (userId: string) => string | null;
}

function params(error: Pick<AutomationRunError, 'params'>): Readonly<Record<string, unknown>> {
  return error.params ?? {};
}

/**
 * A run or step error as a sentence (BACKLOG T523 "lỗi có mã → thông báo
 * i18n"): one message per code of `AUTOMATION_RUN_ERROR_CODES`, with the
 * params the engine stores (codes and ids only, never record values);
 * an unknown code reads as a generic message (the code is shown beside it).
 */
export function runErrorText(
  error: Pick<AutomationRunError, 'code' | 'params'>,
  ctx: ErrorTextContext,
) {
  const { t, format } = ctx;
  const p = params(error);
  const time = (key: string) => {
    const value = textParam(p, key);
    return value === null || Number.isNaN(Date.parse(value)) ? null : format.dateTime(value);
  };
  switch (error.code) {
    case 'permission_denied': {
      const scope = textParam(p, 'scope');
      return t(
        scope === 'record' || scope === 'table' || scope === 'base'
          ? `automationRuns:error.permission_denied_${scope}`
          : 'automationRuns:error.permission_denied',
      );
    }
    case 'invalid_value': {
      const field = textParam(p, 'field');
      const code = textParam(p, 'error');
      if (field === 'record_id') return t('automationRuns:error.invalid_value_record_id');
      if (field === 'until') return t('automationRuns:error.invalid_value_until');
      return code === null
        ? t('automationRuns:error.invalid_value')
        : t('automationRuns:error.invalid_value_code', { code });
    }
    case 'too_many_records':
      return t('automationRuns:error.too_many_records', {
        limit: format.number(Number(textParam(p, 'limit') ?? 0)),
      });
    case 'temporary_error': {
      const cause = textParam(p, 'cause');
      return t('automationRuns:error.temporary_error', {
        cause: t(`automationRuns:cause.${cause ?? 'server_error'}`, {
          defaultValue: cause ?? '',
        }),
      });
    }
    case 'email_quota_exceeded': {
      const retry = time('retry_at');
      return retry === null
        ? t('automationRuns:error.email_quota_exceeded')
        : t('automationRuns:error.email_quota_exceeded_until', { time: retry });
    }
    case 'too_many_recipients':
      return t('automationRuns:error.too_many_recipients', {
        count: Number(textParam(p, 'count') ?? 0),
        limit: format.number(Number(textParam(p, 'limit') ?? 0)),
      });
    case 'record_deleted':
      return t(
        textParam(p, 'state') === 'trashed'
          ? 'automationRuns:error.record_deleted_trashed'
          : 'automationRuns:error.record_deleted',
      );
    case 'cancelled_by_user': {
      const userId = textParam(p, 'user_id');
      const name = userId === null ? null : ctx.userName(userId);
      return name === null
        ? t('automationRuns:error.cancelled_by_user')
        : t('automationRuns:error.cancelled_by_user_named', { name });
    }
    case 'secret_unavailable':
      // HTTP steps (T605) name the purpose of the secret; Telegram steps do not.
      return t(
        textParam(p, 'purpose') === null
          ? 'automationRuns:error.secret_unavailable'
          : 'automationRuns:error.secret_unavailable_http',
      );
    case 'secret_host_not_allowed':
      // T701: the URL's host is not an allowed host of the secret (or a legacy one expired).
      return t(
        textParam(p, 'reason') === 'legacy_expired'
          ? 'automationRuns:error.secret_host_not_allowed_legacy_expired'
          : 'automationRuns:error.secret_host_not_allowed',
      );
    case 'ssrf_blocked': {
      const reason = textParam(p, 'reason');
      return t(`automationRuns:error.ssrf_blocked_${reason ?? 'unknown'}`, {
        defaultValue: t('automationRuns:error.ssrf_blocked'),
      });
    }
    case 'http_status':
      return t('automationRuns:error.http_status', { status: textParam(p, 'status') ?? '?' });
    case 'batch_fanout_exceeded':
      return t('automationRuns:error.batch_fanout_exceeded', {
        limit: format.number(Number(textParam(p, 'limit') ?? 0)),
        count: Number(textParam(p, 'skipped') ?? 0),
      });
    default:
      return t(`automationRuns:error.${error.code}`, {
        defaultValue: t('automationRuns:error.unknown'),
      });
  }
}

/** When a run waiting for a retry (or a step that failed and will retry) runs again. */
export function retryAtOf(
  error: {
    readonly params?: Readonly<Record<string, unknown>> | undefined;
    readonly retry_at?: string | undefined;
  } | null,
): string | null {
  if (error === null) return null;
  return error.retry_at ?? textParam(error.params, 'retry_at');
}

/**
 * How a run is named (board "S5 · Run history": the record's title, a batch
 * for the fan-out stand-in run, else the kind of trigger): the trigger
 * record's title when the viewer can read it, "Record you cannot see"
 * otherwise.
 */
export function runLabelText(
  run: Pick<AutomationRunDto, 'error' | 'trigger'>,
  title: RecordTitle | null,
  t: TFunction,
  format: Formatters,
): string {
  const overflow = batchOverflowOf(run);
  if (overflow !== null) {
    return overflow.size === null
      ? t('automationRuns:list.overflowUnknown')
      : t('automationRuns:list.overflow', {
          count: overflow.size,
          size: format.number(overflow.size),
        });
  }
  if (title !== null) {
    if (title.state === 'readable') {
      return title.title === '' ? t('automationRuns:list.untitled') : title.title;
    }
    if (title.state === 'hidden') return t('automationRuns:list.recordHidden');
    return t('automationRuns:list.recordLoading');
  }
  const type = run.trigger.event_type;
  return type === null
    ? t('automationRuns:trigger.none')
    : t(`automationRuns:trigger.${type}`, { defaultValue: type });
}
