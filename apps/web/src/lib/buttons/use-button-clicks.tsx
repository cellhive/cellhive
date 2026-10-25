import { userChannel, type RecordDto } from '@cellhive/contracts';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { api } from '../api';
import { buttonsApi } from '../api/buttons';
import { isApiError } from '../api/client';
import { useRealtimeChannel } from '../realtime/channels';
import { forgetCachedRecord, updateCachedRecord } from '../records/record-sync';
import { meQuery } from '../session/session';
import { dismissToast, showErrorToast, showToast, updateToast } from '../toast/toast';

import { ButtonConfirmDialog } from './ButtonConfirmDialog';
import { clickFailureOf, finishedVariant, type FinishedStatus } from './clicks';
import { buttonKey, buttonViewOf, type ButtonColumn } from './model';
import {
  attachRun,
  beginClick,
  endClick,
  runningClicks,
  takeRun,
  useRunningClicks,
  type RunningClick,
} from './runs';

/**
 * Clicking button fields (T525, CONTRACTS §21 "Button", boards "S5 ·
 * Button field"): confirmation when the field asks for it, `POST …/click`
 * with an `Idempotency-Key`, a spinner on the cell until
 * `automation.run.finished` of that run arrives on `user:<me>`, then a toast
 * (with "View run" for people who manage automations) and the record's
 * button cells read again — the server never pushes them (CONTRACTS §2).
 * `429` says when to try again, counting down.
 */

/** No message after this long (lost connection): the spinner stops, the cells are read again. */
export const CLICK_TIMEOUT_MS = 120_000;

export interface ButtonPress {
  readonly field: { readonly id: string; readonly name: string };
  readonly column: ButtonColumn;
  readonly record: RecordDto;
  /** The record's title for the toast. */
  readonly recordTitle: string;
}

export interface UseButtonClicksOptions {
  readonly tableId: string;
  readonly baseId: string;
  /** Ids of the table's button fields: read again after a run. */
  readonly buttonFieldIds: readonly string[];
  /** The user manages automations of this table: the finished toast links to the run. */
  readonly canSeeRuns: boolean;
}

export interface ButtonClicks {
  /** A click on a ready button (Enter/Space, pointer). Ignored while that cell runs. */
  readonly press: (press: ButtonPress) => void;
  /** Cells (`buttonKey`) whose click of this tab is running. */
  readonly running: ReadonlyMap<string, RunningClick>;
  /** The confirmation dialog, when one is open: render it. */
  readonly dialog: ReactNode;
}

/**
 * Reads the record's button cells again (they are computed per reader and
 * never pushed) and puts them wherever the record is cached; a record gone
 * for the user leaves the grid.
 */
export async function refreshButtonCells(
  queryClient: QueryClient,
  tableId: string,
  recordId: string,
  fieldIds: readonly string[],
): Promise<void> {
  if (fieldIds.length === 0) return;
  try {
    const fresh = await api.records.get(tableId, recordId, { fields: fieldIds });
    updateCachedRecord(queryClient, tableId, recordId, (record) => ({
      ...record,
      fields: {
        ...record.fields,
        ...Object.fromEntries(
          fieldIds.filter((id) => id in fresh.fields).map((id) => [id, fresh.fields[id]]),
        ),
      },
    }));
  } catch (error) {
    if (isApiError(error) && error.status === 404)
      forgetCachedRecord(queryClient, tableId, recordId);
  }
}

function newKey(): string {
  return `web-${crypto.randomUUID()}`;
}

export function useButtonClicks({
  tableId,
  baseId,
  buttonFieldIds,
  canSeeRuns,
}: UseButtonClicksOptions): ButtonClicks {
  const { t } = useTranslation('grid');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const me = useQuery(meQuery());
  const running = useRunningClicks();
  const [asking, setAsking] = useState<ButtonPress | null>(null);
  const latest = useRef({ tableId, baseId, buttonFieldIds, canSeeRuns });
  useEffect(() => {
    latest.current = { tableId, baseId, buttonFieldIds, canSeeRuns };
  });
  const timers = useRef(new Map<string, number>());
  useEffect(() => {
    const own = timers.current;
    return () => {
      for (const timer of own.values()) window.clearTimeout(timer);
      own.clear();
    };
  }, []);

  const refresh = useCallback(
    (click: Pick<RunningClick, 'tableId' | 'recordId'>) => {
      const { buttonFieldIds: ids } = latest.current;
      void refreshButtonCells(queryClient, click.tableId, click.recordId, ids);
    },
    [queryClient],
  );

  const finished = useCallback(
    (click: RunningClick, runId: string, status: FinishedStatus, automationId?: string) => {
      const timer = timers.current.get(click.key);
      if (timer !== undefined) window.clearTimeout(timer);
      timers.current.delete(click.key);
      refresh(click);
      const { baseId: base, canSeeRuns: manager } = latest.current;
      const values = { label: click.label, record: click.recordTitle };
      showToast({
        variant: finishedVariant(status),
        message: t(`button.finished.${status}`, values),
        ...(manager && automationId !== undefined
          ? {
              actions: [
                {
                  label: t('button.viewRun'),
                  onClick: () => {
                    void navigate(`/b/${base}/automations/${automationId}/runs?run=${runId}`);
                  },
                },
              ],
            }
          : {}),
      });
    },
    [navigate, refresh, t],
  );

  /** Runs that end before the `202` is read know no automation id: kept here meanwhile. */
  const earlyAutomation = useRef(new Map<string, string>());

  const meId = me.data?.user.id;
  useRealtimeChannel(meId === undefined ? null : userChannel(meId), {
    onMessage: (message) => {
      if (message.type !== 'automation.run.finished') return;
      const click = takeRun(message.run_id, message.status);
      if (click === undefined) {
        // A run of another tab is none of this one's business; one of a click in flight may be.
        const inFlight = [...runningClicks().values()].some((item) => item.runId === null);
        if (inFlight) earlyAutomation.current.set(message.run_id, message.automation_id);
        return;
      }
      finished(click, message.run_id, message.status, message.automation_id);
    },
    onReconnect: () => {
      // Messages missed meanwhile are lost: stop the spinners, read the cells again.
      for (const click of runningClicks().values()) {
        if (click.tableId !== latest.current.tableId || click.runId === null) continue;
        endClick(click.key);
        refresh(click);
      }
    },
  });

  const rateLimited = useCallback(
    (seconds: number) => {
      let left = seconds;
      const text = () => t('button.rateLimited', { count: left });
      const id = showToast({ variant: 'warning', message: text(), durationMs: null });
      const tick = window.setInterval(() => {
        left -= 1;
        if (
          left <= 0 ||
          !updateToast(id, { variant: 'warning', message: text(), durationMs: null })
        ) {
          window.clearInterval(tick);
          dismissToast(id);
        }
      }, 1000);
    },
    [t],
  );

  const send = useCallback(
    (press: ButtonPress) => {
      const { tableId: table } = latest.current;
      const key = buttonKey(press.record.id, press.field.id);
      const started = beginClick({
        key,
        tableId: table,
        recordId: press.record.id,
        fieldId: press.field.id,
        label: press.column.label,
        recordTitle: press.recordTitle,
      });
      if (!started) return;
      buttonsApi.click(table, press.record.id, press.field.id, newKey()).then(
        ({ run_id }) => {
          const click = runningClicks().get(key);
          const status = attachRun(key, run_id);
          if (status !== undefined && click !== undefined) {
            endClick(key);
            const automationId = earlyAutomation.current.get(run_id);
            earlyAutomation.current.delete(run_id);
            finished(click, run_id, status, automationId);
            return;
          }
          timers.current.set(
            key,
            window.setTimeout(() => {
              timers.current.delete(key);
              const current = runningClicks().get(key);
              if (current?.runId !== run_id) return;
              endClick(key);
              refresh(current);
            }, CLICK_TIMEOUT_MS),
          );
        },
        (error: unknown) => {
          endClick(key);
          const failure = clickFailureOf(error);
          switch (failure.kind) {
            case 'rate_limited':
              rateLimited(failure.seconds);
              return;
            case 'disabled':
              showToast({
                variant: 'info',
                message: t(`button.reason.${failure.reason}`, { label: press.column.label }),
              });
              break;
            case 'permission':
              showToast({ variant: 'info', message: t('button.reason.permission') });
              break;
            case 'gone':
              showToast({ variant: 'info', message: t('button.gone') });
              break;
            case 'error':
              showErrorToast(error);
              return;
          }
          refresh({ tableId: table, recordId: press.record.id });
        },
      );
    },
    [finished, rateLimited, refresh, t],
  );

  const press = useCallback(
    (next: ButtonPress) => {
      const key = buttonKey(next.record.id, next.field.id);
      if (runningClicks().has(key)) return;
      if (buttonViewOf(next.record.fields[next.field.id]).state !== 'ready') return;
      if (next.column.confirm !== null) {
        setAsking(next);
        return;
      }
      send(next);
    },
    [send],
  );

  const dialog =
    asking === null || asking.column.confirm === null ? null : (
      <ButtonConfirmDialog
        confirm={asking.column.confirm}
        onCancel={() => {
          setAsking(null);
        }}
        onConfirm={() => {
          const confirmed = asking;
          setAsking(null);
          send(confirmed);
        }}
      />
    );

  return { press, running, dialog };
}
