import { Button, Tooltip } from '@cellhive/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, LoaderCircle, RefreshCw, TriangleAlert, Undo2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useFormatters } from '../../../lib/i18n/format';
import {
  conversionDismissedPreferenceKey,
  readPreference,
  writePreference,
} from '../../../lib/preferences';
import { keys } from '../../../lib/query/keys';
import { jobQuery, orgMembersQuery } from '../../../lib/query/queries';
import { invalidateLinkedFields } from '../../../lib/realtime/channels';
import {
  dismissFieldConversion,
  etaSeconds,
  recordFieldConverting,
  useFieldConversionProgress,
  type FieldConversionProgress,
} from '../../../lib/realtime/field-conversions';
import { JOB_POLL_MS } from '../../../lib/realtime/jobs';
import { daysLeft, isFieldConverting, revertibleConversion } from '../../../lib/schema/conversion';

import type { FieldDto } from '@cellhive/contracts';
import type { TFunction } from 'i18next';

/** Id of the banner of a field (the column menu's "Show progress" moves the focus there). */
export function conversionBannerId(fieldId: string): string {
  return `conversion-banner-${fieldId}`;
}

export interface ConversionBannersProps {
  readonly tableId: string;
  /** Live fields of the table, as `GET /tables/:id/fields` lists them. */
  readonly fields: readonly FieldDto[];
  readonly userId: string | null;
  readonly orgId: string;
  /** Schema rights on the table: "Undo" and "Try again". */
  readonly canManage: boolean;
  readonly onRevert: (fieldId: string) => void;
  readonly onRetry: (fieldId: string) => void;
}

type TypeName = (type: string) => string;

function useActorName(orgId: string, actorId: string | null, userId: string | null) {
  const members = useQuery({
    ...orgMembersQuery(orgId),
    enabled: actorId !== null && actorId !== userId,
  });
  if (actorId === null || actorId === userId) return null;
  return (
    members.data?.items.find((member) => member.user.id === actorId)?.user.display_name ?? null
  );
}

function describe(
  t: TFunction<'grid'>,
  typeName: TypeName,
  field: FieldDto,
  from: string,
  to: string,
  linkChange: string | undefined,
  state: 'running' | 'succeeded' | 'failed',
): string {
  if (linkChange !== undefined) {
    return t(`conversion.link.${linkChange}.${state}`, { field: field.name });
  }
  return t(`conversion.${state}`, { field: field.name, from: typeName(from), to: typeName(to) });
}

function RunningBanner({
  field,
  entry,
  userId,
  orgId,
  typeName,
}: {
  field: FieldDto;
  entry: FieldConversionProgress | undefined;
  userId: string | null;
  orgId: string;
  typeName: TypeName;
}) {
  const { t } = useTranslation('grid');
  const queryClient = useQueryClient();
  const state = field.conversion;
  const jobId = entry?.jobId ?? state?.job_id ?? '';
  const actorId = entry?.actorId ?? null;
  const progress = entry?.status === 'running' ? entry.progress : 0;
  const actor = useActorName(orgId, actorId, userId);
  const eta = etaSeconds(entry);
  // Fallback when messages are missed: the job of the user who started it (GET /jobs/:id).
  const job = useQuery({
    ...jobQuery(jobId),
    enabled: jobId !== '' && (actorId === null || actorId === userId),
    refetchInterval: JOB_POLL_MS,
    retry: false,
  });
  const polled = job.data;
  useEffect(() => {
    if (polled === undefined || state === null || state === undefined) return;
    if (polled.status !== 'succeeded' && polled.status !== 'failed') {
      if (polled.progress > progress) {
        recordFieldConverting({
          type: 'field.converting',
          channel: `table:${field.table_id}`,
          field_id: field.id,
          job_id: state.job_id,
          status: 'running',
          progress: polled.progress,
          from_type: state.from_type,
          to_type: state.to_type,
          actor_id: actorId,
          ...(state.link_change === undefined ? {} : { link_change: state.link_change }),
        });
      }
      return;
    }
    recordFieldConverting({
      type: 'field.converting',
      channel: `table:${field.table_id}`,
      field_id: field.id,
      job_id: state.job_id,
      status: polled.status,
      progress: 1,
      from_type: state.from_type,
      to_type: state.to_type,
      actor_id: actorId,
      ...(state.link_change === undefined ? {} : { link_change: state.link_change }),
    });
    void queryClient.invalidateQueries({ queryKey: keys.table(field.table_id) });
    if (state.link_change !== undefined) {
      void invalidateLinkedFields(queryClient, field.table_id, field.id);
    }
  }, [polled, state, field, actorId, progress, queryClient]);

  const from = entry?.fromType ?? state?.from_type ?? field.type;
  const to = entry?.toType ?? state?.to_type ?? field.type;
  const linkChange = entry?.linkChange ?? state?.link_change;
  const percent = Math.round(progress * 100);
  const title = describe(t, typeName, field, from, to, linkChange, 'running');
  return (
    <div
      id={conversionBannerId(field.id)}
      tabIndex={-1}
      role="status"
      data-testid="conversion-banner"
      data-state="running"
      data-field={field.id}
      className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-accent-soft px-4 py-2 text-body outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <LoaderCircle
        aria-hidden="true"
        className="size-4 shrink-0 animate-spin text-accent motion-reduce:animate-none"
      />
      <span className="min-w-0">
        <strong className="font-semibold">{title}</strong>
        {actor === null ? null : (
          <span className="text-fg-muted"> {t('conversion.by', { name: actor })}</span>
        )}
      </span>
      <span
        role="progressbar"
        aria-label={t('conversion.progressLabel', { field: field.name })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="block h-1.5 w-40 overflow-hidden rounded-full bg-surface sm:w-52"
      >
        <span
          className="block h-full rounded-full bg-accent transition-[width] duration-300 motion-reduce:transition-none"
          style={{ width: `${String(Math.max(percent, 2))}%` }}
        />
      </span>
      <span className="text-fg-muted tabular-nums">{t('conversion.percent', { percent })}</span>
      {eta === null ? null : (
        <span className="text-fg-subtle">
          {eta < 90
            ? t('conversion.etaSeconds', { count: eta })
            : t('conversion.etaMinutes', { count: Math.round(eta / 60) })}
        </span>
      )}
      <span className="ml-auto text-label font-normal text-fg-muted max-md:hidden">
        {linkChange === undefined ? t('conversion.note') : t('conversion.noteLink')}
      </span>
    </div>
  );
}

function EndedBanner({
  field,
  entry,
  userId,
  canManage,
  typeName,
  onRevert,
  onRetry,
  onDismiss,
}: {
  field: FieldDto;
  entry: FieldConversionProgress;
  userId: string | null;
  canManage: boolean;
  typeName: TypeName;
  onRevert: (fieldId: string) => void;
  onRetry: (fieldId: string) => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation('grid');
  const format = useFormatters();
  const succeeded = entry.status === 'succeeded';
  const job = useQuery({
    ...jobQuery(entry.jobId),
    enabled: succeeded && entry.actorId !== null && entry.actorId === userId,
    retry: false,
    // The running banner polled the same job: its answer predates the counts.
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const result = job.data?.result ?? null;
  const count = (key: string) => {
    const value = result?.[key];
    return typeof value === 'number' ? value : null;
  };
  const affected = count('affected');
  const lost = count('lost') ?? 0;
  const revertible = revertibleConversion(field);
  const title = describe(
    t,
    typeName,
    field,
    entry.fromType,
    entry.toType,
    entry.linkChange,
    succeeded ? 'succeeded' : 'failed',
  );
  const close = (
    <Tooltip content={t('conversion.dismiss')}>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label={t('conversion.dismiss')}
        onClick={onDismiss}
      >
        <X aria-hidden="true" />
      </Button>
    </Tooltip>
  );
  if (!succeeded) {
    return (
      <div
        id={conversionBannerId(field.id)}
        tabIndex={-1}
        role="alert"
        data-testid="conversion-banner"
        data-state="failed"
        data-field={field.id}
        className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b border-danger/40 bg-danger/5 py-1.5 pr-3 pl-4 text-body outline-none"
      >
        <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-danger" />
        <span className="min-w-0">
          <strong className="font-semibold">{title}</strong>{' '}
          <span className="text-fg-muted">{t('conversion.failedBody')}</span>
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {canManage ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                dismissFieldConversion(field.id);
                onRetry(field.id);
              }}
            >
              <RefreshCw aria-hidden="true" />
              {t('conversion.retry')}
            </Button>
          ) : null}
          {close}
        </span>
      </div>
    );
  }
  const days = revertible === null ? 0 : daysLeft(revertible.revertible_until);
  return (
    <div
      id={conversionBannerId(field.id)}
      tabIndex={-1}
      role="status"
      data-testid="conversion-banner"
      data-state="succeeded"
      data-field={field.id}
      className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface py-1.5 pr-3 pl-4 text-body outline-none"
    >
      <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-accent" />
      <span className="min-w-0">
        <strong className="font-semibold">{title}</strong>
        {affected === null || entry.linkChange !== undefined ? null : (
          <span className="text-fg-muted">
            {' '}
            {lost > 0
              ? t('conversion.counts', {
                  converted: format.number(affected - lost),
                  lost: format.number(lost),
                  count: lost,
                })
              : t('conversion.countsNoLoss', {
                  converted: format.number(affected),
                  count: affected,
                })}
          </span>
        )}
      </span>
      {revertible === null ? null : (
        <span className="text-fg-subtle">
          {t('conversion.revertibleUntil', { date: format.dateTime(revertible.revertible_until) })}
        </span>
      )}
      <span className="ml-auto flex items-center gap-1.5">
        {canManage && revertible !== null ? (
          <Button
            variant="secondary"
            size="sm"
            data-testid="conversion-undo"
            onClick={() => {
              onRevert(field.id);
            }}
          >
            <Undo2 aria-hidden="true" />
            {t('conversion.undo', { count: days })}
          </Button>
        ) : null}
        {close}
      </span>
    </div>
  );
}

/**
 * The "done" state of a conversion this tab did not see end (a reload),
 * from the field list, while it can still be undone; `undefined` otherwise.
 */
function doneEntryOf(field: FieldDto): FieldConversionProgress | undefined {
  const conversion = revertibleConversion(field);
  if (conversion === null) return undefined;
  return {
    fieldId: field.id,
    jobId: conversion.job_id,
    status: 'succeeded',
    progress: 1,
    fromType: conversion.from_type,
    toType: conversion.to_type,
    actorId: null,
    linkChange: conversion.link_change,
    endedAt: null,
    dismissed: false,
    seenAt: 0,
    seenProgress: 1,
    updatedAt: 0,
  };
}

/**
 * Banners of the field type conversions of the table (T414, BACKLOG S4
 * design decision #8; boards "Đổi kiểu, đang chạy nền" and "Đổi kiểu, xong
 * và hoàn tác"), under the toolbar, for everyone who has the table open:
 * the field, the change and who made it, the progress (`field.converting`);
 * then the result with "Undo (N days left)" (schema managers) or, when it
 * failed, "Try again". The field list says what runs (it may have started
 * before this page opened) and — T421b — what can still be undone: after a
 * reload the done banner comes back for schema managers until closed (per
 * user, this device) or the undo expires.
 */
export function ConversionBanners({
  fields,
  userId,
  orgId,
  canManage,
  onRevert,
  onRetry,
}: ConversionBannersProps) {
  const { t } = useTranslation('grid');
  const entries = useFieldConversionProgress();
  // Closed "done" banners (T421b), per user on this device: field id → job id.
  const [closed, setClosed] = useState<ReadonlyMap<string, string>>(() => new Map());
  const typeName: TypeName = (type) => t(`types.${type}`, { defaultValue: type });
  const dismissedJob = (fieldId: string): string | null =>
    closed.get(fieldId) ??
    (userId === null ? null : readPreference(conversionDismissedPreferenceKey(userId, fieldId)));
  const dismiss = (fieldId: string, jobId: string) => {
    dismissFieldConversion(fieldId);
    setClosed((current) => new Map(current).set(fieldId, jobId));
    if (userId !== null) {
      writePreference(conversionDismissedPreferenceKey(userId, fieldId), jobId);
    }
  };
  const banners = fields.flatMap((field) => {
    const entry = entries.get(field.id);
    if (isFieldConverting(field)) {
      const running =
        entry !== undefined && entry.jobId === field.conversion?.job_id ? entry : undefined;
      return [
        <RunningBanner
          key={field.id}
          field={field}
          entry={running}
          userId={userId}
          orgId={orgId}
          typeName={typeName}
        />,
      ];
    }
    // Heard by this tab, or — after a reload — a conversion that can still be undone
    // (the field list), for those who may undo it (T421b).
    const ended =
      entry !== undefined && entry.status !== 'running'
        ? entry
        : canManage
          ? doneEntryOf(field)
          : undefined;
    if (ended === undefined || ended.dismissed || dismissedJob(field.id) === ended.jobId) {
      return [];
    }
    return [
      <EndedBanner
        key={field.id}
        field={field}
        entry={ended}
        userId={userId}
        canManage={canManage}
        typeName={typeName}
        onRevert={onRevert}
        onRetry={onRetry}
        onDismiss={() => {
          dismiss(field.id, ended.jobId);
        }}
      />,
    ];
  });
  if (banners.length === 0) return null;
  return <div className="flex flex-col">{banners}</div>;
}
