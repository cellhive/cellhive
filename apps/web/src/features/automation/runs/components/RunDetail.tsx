import { Button, cn, Dialog, Skeleton } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { CircleAlert, History, Info, RotateCcw, Square } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { isApiError } from '../../../../lib/api/client';
import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../../lib/i18n/format';
import { keys } from '../../../../lib/query/keys';
import { automationRunsApi } from '../api';
import { recipientFailureOf } from '../model/rejections';
import {
  canCancel,
  canRerun,
  elapsedMs,
  hasActiveRerun,
  isActiveRun,
  pollIntervalOf,
  timelineOf,
  type TimelineItem,
} from '../model/runs';
import { StepDetail } from '../steps/registry';
import { useRecordTitles, type RecordTitle } from '../use-record-titles';

import {
  formatDuration,
  retryAtOf,
  runErrorText,
  runLabelText,
  StatusBadge,
  StepIcon,
} from './RunBits';
import { RejectedRecipients } from './StepOutput';

import type { RunAction } from './RunActions';
import type { AutomationRunDetailDto, TableDto } from '@cellhive/contracts';

export interface RunDetailProps {
  readonly runId: string;
  readonly baseId: string;
  /** Tables of the base (primary fields of trigger records). */
  readonly tables: readonly Pick<TableDto, 'id' | 'primary_field_id'>[] | undefined;
  readonly userName: (userId: string) => string | null;
  /** Id of the run with a re-run/cancel in flight. */
  readonly pendingId: string | null;
  readonly onAsk: (action: RunAction) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onClose: () => void;
}

function Meta({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

/** One line of the timeline: number, action, status, duration, error, output. */
function StepLine({
  item,
  last,
  baseId,
  userName,
}: {
  readonly item: TimelineItem;
  readonly last: boolean;
  readonly baseId: string;
  readonly userName: (userId: string) => string | null;
}) {
  const { t } = useTranslation(['automationRuns', 'automationBuilder']);
  const format = useFormatters();
  const step = item.step;
  const type = item.type ?? step?.action_type ?? null;
  const name =
    type === null
      ? item.actionId
      : t(`automationBuilder:actionType.${type}`, { defaultValue: type });
  const title = item.number === null ? name : t('detail.stepTitle', { number: item.number, name });
  const ms = step === null ? null : elapsedMs(step.started_at, step.finished_at);
  const retryAt = step === null ? null : retryAtOf(step.error);
  // T556 (QA S5 L1): who refused a failed email, masked, with the server's codes.
  const recipients =
    type === 'send_email' && step?.error != null ? recipientFailureOf(step.error.params) : null;
  const waitingUntil =
    step?.status === 'waiting' && type === 'delay'
      ? (step.output as { until?: unknown } | null)?.until
      : undefined;
  return (
    <li
      className="relative flex gap-3 pb-4"
      data-testid={`run-step-${item.actionId}`}
      data-step-status={step?.status ?? 'not_run'}
    >
      {last ? null : (
        <span aria-hidden="true" className="absolute top-6 -bottom-1 left-[9px] w-px bg-line" />
      )}
      <span className="relative flex bg-surface">
        <StepIcon status={step?.status ?? null} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className={cn('font-medium', step === null ? 'text-fg-muted' : 'text-fg')}>
            {title}
          </span>
          <span className="sr-only">
            {step === null ? t('detail.notRun') : t(`status.${step.status}`)}
          </span>
          <span className="ml-auto text-label font-normal text-fg-muted tabular-nums">
            {step === null
              ? t('detail.notRun')
              : step.status === 'running'
                ? t('status.running')
                : step.status === 'waiting'
                  ? t('status.waiting')
                  : ms === null
                    ? null
                    : formatDuration(ms, format, t)}
          </span>
        </div>
        {step === null ? null : (
          <>
            {step.reused ? (
              <p className="text-label font-normal text-fg-muted">{t('detail.reused')}</p>
            ) : null}
            {step.attempt > 1 ? (
              <p className="text-label font-normal text-fg-muted">
                {t('detail.attempt', { count: step.attempt })}
              </p>
            ) : null}
            {typeof waitingUntil === 'string' && !Number.isNaN(Date.parse(waitingUntil)) ? (
              <p className="text-label font-normal">
                {t('detail.waitingUntil', { time: format.dateTime(waitingUntil) })}
              </p>
            ) : null}
            {step.error === null ? null : (
              <div
                className={cn(
                  'rounded-md border px-3 py-2 text-label font-normal',
                  step.status === 'failed' && retryAt === null
                    ? 'border-danger/40 bg-danger/5'
                    : 'border-line bg-surface-sunken',
                )}
                data-testid={`step-error-${item.actionId}`}
              >
                <p className="font-medium text-fg">
                  {runErrorText(step.error, { t, format, userName })}
                </p>
                {retryAt === null ? null : (
                  <p className="text-fg-muted">
                    {t('detail.retryAt', { time: format.dateTime(retryAt) })}
                  </p>
                )}
                {recipients === null ? null : (
                  <div className="mt-1.5 flex flex-col gap-1" data-testid="step-rejected">
                    <p className="text-fg-muted">
                      {t('detail.rejectedTitle', {
                        count: recipients.rejectedCount,
                      })}
                    </p>
                    <RejectedRecipients
                      items={recipients.rejected}
                      total={recipients.rejectedCount}
                    />
                    {recipients.acceptedCount === 0 ? null : (
                      <p className="text-fg-muted">
                        {t('detail.acceptedBefore', {
                          count: recipients.acceptedCount,
                        })}
                      </p>
                    )}
                  </div>
                )}
                <p className="mt-0.5 font-mono text-[12px] text-fg-muted">{step.error.code}</p>
              </div>
            )}
            <StepDetail
              type={type}
              step={step}
              action={item.action}
              baseId={baseId}
              userName={userName}
            />
          </>
        )}
      </div>
    </li>
  );
}

function Body({
  run,
  baseId,
  userName,
  pendingId,
  onAsk,
  onOpenRun,
  title,
}: Omit<RunDetailProps, 'runId' | 'tables' | 'onClose'> & {
  readonly run: AutomationRunDetailDto;
  readonly title: RecordTitle | null;
}) {
  const { t } = useTranslation('automationRuns');
  const format = useFormatters();
  const timeline = timelineOf(run.definition, run.steps);
  const rerunActive = hasActiveRerun(run.reruns);
  const blockedId = useId();
  const pending = pendingId === run.id;
  const ms = run.active_ms > 0 ? run.active_ms : elapsedMs(run.started_at, run.finished_at);
  const retryAt = run.status === 'queued' ? retryAtOf(run.error) : null;
  const versionChanged = run.automation.version !== run.automation_version;
  const trigger = run.trigger;

  return (
    <div className="flex flex-col gap-4" data-testid="run-detail" data-run-status={run.status}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-label font-normal text-fg-muted">
        <StatusBadge status={run.status} />
        <time dateTime={run.created_at}>{format.dateTime(run.created_at)}</time>
        {ms === null || ms === 0 ? null : <span>{formatDuration(ms, format, t)}</span>}
        <span className="font-mono text-[12px]">{run.id}</span>
      </div>

      {canRerun(run) || canCancel(run) ? (
        <div className="flex flex-wrap gap-2">
          {canRerun(run) ? (
            <Button
              disabled={pending || rerunActive}
              aria-describedby={rerunActive ? blockedId : undefined}
              data-testid="run-rerun"
              className="max-sm:h-11 max-sm:flex-1"
              onClick={() => {
                onAsk({ kind: 'rerun', run, currentVersion: run.automation.version });
              }}
            >
              <RotateCcw aria-hidden="true" />
              {t('detail.rerun')}
            </Button>
          ) : null}
          {canCancel(run) ? (
            <Button
              variant="secondary"
              disabled={pending}
              data-testid="run-cancel"
              className="max-sm:h-11 max-sm:flex-1"
              onClick={() => {
                onAsk({ kind: 'cancel', run });
              }}
            >
              <Square aria-hidden="true" />
              {t('detail.cancel')}
            </Button>
          ) : null}
          {rerunActive ? (
            <p id={blockedId} className="w-full text-label font-normal text-fg-muted">
              {t('detail.rerunBlocked')}
            </p>
          ) : null}
        </div>
      ) : null}

      {run.error === null || run.status === 'succeeded' ? null : (
        <div
          className={cn(
            'flex gap-2.5 rounded-lg border px-3 py-2.5 text-label font-normal',
            run.status === 'failed'
              ? 'border-danger/40 bg-danger/5'
              : 'border-line bg-surface-sunken',
          )}
          data-testid="run-error"
        >
          <CircleAlert
            aria-hidden="true"
            className={cn(
              'mt-0.5 size-4 shrink-0',
              run.status === 'failed' ? 'text-danger' : 'text-fg-muted',
            )}
          />
          <div className="flex min-w-0 flex-col gap-0.5">
            <strong className="font-semibold">
              {runErrorText(run.error, { t, format, userName })}
            </strong>
            {retryAt === null ? null : (
              <span>{t('detail.retryAt', { time: format.dateTime(retryAt) })}</span>
            )}
            <span className="font-mono text-[12px] text-fg-muted">{run.error.code}</span>
          </div>
        </div>
      )}

      <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-label font-normal sm:grid-cols-[minmax(7rem,9rem)_1fr]">
        <Meta label={t('detail.automation')}>
          <Link
            to={`/b/${baseId}/automations/${run.automation.id}`}
            className="text-accent underline-offset-2 hover:underline"
          >
            {run.automation.name}
          </Link>
        </Meta>
        <Meta label={t('detail.trigger')}>
          {t(`trigger.${trigger.event_type ?? 'none'}`, {
            defaultValue: trigger.event_type ?? t('trigger.none'),
          })}
          {trigger.record_id === null || trigger.table_id === null ? null : (
            <>
              {' · '}
              {title?.state === 'readable' ? (
                <Link
                  to={`/b/${baseId}/t/${trigger.table_id}?record=${encodeURIComponent(trigger.record_id)}`}
                  // Inline with text: underlined, not told apart by color alone (axe, dark theme).
                  className="text-accent underline underline-offset-2"
                  data-testid="run-record-link"
                >
                  {title.title === '' ? t('list.untitled') : title.title}
                </Link>
              ) : title?.state === 'hidden' ? (
                <span className="text-fg-muted">{t('list.recordHidden')}</span>
              ) : null}
            </>
          )}
          {trigger.bulk && trigger.batch !== null ? (
            <span className="block text-fg-muted">
              {t('list.batch', { count: trigger.batch.size })}
            </span>
          ) : null}
        </Meta>
        <Meta label={t('detail.version')}>
          <span data-testid="run-version">
            {versionChanged
              ? t('detail.versionChanged', {
                  version: run.automation_version,
                  current: run.automation.version,
                })
              : t('detail.versionSame', { version: run.automation_version })}
          </span>
          {versionChanged && canRerun(run) ? (
            <span className="flex items-start gap-1.5 text-fg-muted">
              <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              {t('detail.versionRerunNote')}
            </span>
          ) : null}
        </Meta>
        {run.rerun_of === null ? null : (
          <Meta label={t('detail.rerunOf')}>
            <button
              type="button"
              className="text-accent underline-offset-2 hover:underline"
              onClick={() => {
                onOpenRun(run.rerun_of ?? '');
              }}
            >
              <span className="font-mono text-[12px]">{run.rerun_of}</span>
            </button>
            {run.rerun_by === null ? null : (
              <span className="text-fg-muted">
                {' '}
                · {t('detail.rerunBy', { name: run.rerun_by.name })}
              </span>
            )}
          </Meta>
        )}
        {run.reruns.length === 0 ? null : (
          <Meta label={t('detail.reruns')}>
            <ul className="flex flex-col gap-1" data-testid="run-reruns">
              {run.reruns.map((rerun) => (
                <li key={rerun.id} className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={rerun.status} />
                  <button
                    type="button"
                    className="text-accent underline-offset-2 hover:underline"
                    onClick={() => {
                      onOpenRun(rerun.id);
                    }}
                  >
                    {format.dateTime(rerun.created_at)}
                  </button>
                </li>
              ))}
            </ul>
          </Meta>
        )}
      </dl>

      <section aria-label={t('detail.steps')} className="flex flex-col gap-2">
        <h3 className="text-label font-medium text-fg-muted">{t('detail.steps')}</h3>
        {run.definition === null ? (
          <p className="text-label font-normal text-fg-muted">{t('detail.noDefinition')}</p>
        ) : null}
        {timeline.length === 0 ? (
          <p className="text-label font-normal text-fg-muted">{t('detail.noSteps')}</p>
        ) : (
          <ol className="m-0 list-none p-0">
            {timeline.map((item, index) => (
              <StepLine
                key={item.actionId}
                item={item}
                last={index === timeline.length - 1}
                baseId={baseId}
                userName={userName}
              />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

/**
 * The run drawer (BACKLOG T523; board "S5 · Run history" right pane, "…
 * - 375 px"): status, times, re-run / cancel, the error as a sentence, the
 * trigger, the definition version at run time against the current one
 * (Quyết định S5 thiết kế #4), re-runs, and each step of the definition —
 * status, attempt, duration, error, output with hidden values. Polls while
 * the run (or a re-run of it) has not ended — no realtime for runs (C§21);
 * a status change is announced politely.
 */
export function RunDetail(props: RunDetailProps) {
  const { runId, onClose } = props;
  const { t } = useTranslation('automationRuns');
  const detail = useQuery({
    queryKey: keys.automationRun(runId),
    queryFn: ({ signal }) => automationRunsApi.get(runId, signal),
    retry: (count, error) => !(isApiError(error) && error.status === 404) && count < 2,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data === undefined) return false;
      return pollIntervalOf([data.status, ...data.reruns.map((rerun) => rerun.status)]);
    },
  });

  // Announce status changes of the open run (polite, one region).
  const [announcement, setAnnouncement] = useState('');
  const previous = useRef<string | null>(null);
  const status = detail.data?.status ?? null;
  useEffect(() => {
    if (status === null) return;
    if (previous.current !== null && previous.current !== status) {
      setAnnouncement(t('detail.statusChanged', { status: t(`status.${status}`) }));
    }
    previous.current = status;
  }, [status, t]);

  const run = detail.data;
  const recordId = run?.trigger.record_id ?? null;
  const tableId = run?.trigger.table_id ?? null;
  const refs = useMemo(
    () => (recordId === null || tableId === null ? [] : [{ tableId, recordId }]),
    [recordId, tableId],
  );
  const titleOf = useRecordTitles(refs, props.tables);
  const title = refs[0] === undefined ? null : titleOf(refs[0]);
  const format = useFormatters();
  let body: ReactNode;
  if (isApiError(detail.error) && detail.error.status === 404) {
    body = (
      <p className="flex items-center gap-2 text-body text-fg-muted" data-testid="run-gone">
        <History aria-hidden="true" className="size-4" />
        {t('detail.gone')}
      </p>
    );
  } else if (detail.isError) {
    body = <ErrorAlert error={detail.error} />;
  } else if (run === undefined) {
    body = (
      <div
        role="status"
        aria-busy="true"
        aria-label={t('detail.loading')}
        className="flex flex-col gap-3"
      >
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  } else {
    body = <Body {...props} run={run} title={title} />;
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('detail.title')}
      closeLabel={t('detail.close')}
      layout="drawer"
      className="max-md:h-[calc(100dvh-2rem)]"
    >
      {run === undefined ? null : (
        <p className="-mt-3 min-w-0 truncate text-body font-medium" data-testid="run-detail-label">
          {runLabelText(run, title, t, format)}
        </p>
      )}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {body}
      {run !== undefined && isActiveRun(run.status) ? (
        <p className="text-label font-normal text-fg-muted">{t('detail.polling')}</p>
      ) : null}
    </Dialog>
  );
}
