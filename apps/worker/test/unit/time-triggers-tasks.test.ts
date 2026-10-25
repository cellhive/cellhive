import { Writable } from 'node:stream';

import { parseCronItems, type JobHelpers } from 'graphile-worker';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import {
  AUTOMATION_DATE_SCAN_CRON,
  AUTOMATION_SCHEDULE_TICK_CRON,
  CRON_ITEMS,
} from '../../src/job-runner.js';
import { createAutomationDateScanTask } from '../../src/tasks/automation-date-scan.js';
import { createAutomationScheduleTickTask } from '../../src/tasks/automation-schedule-tick.js';

import type { AutomationTimeTriggers, TimeTriggerTick } from '@cellhive/server-core';

const ORG = 'org_UnitOrg000000001';
const AUT = 'aut_UnitAutomation01';

function capture() {
  const chunks: string[] = [];
  const logger = pino(
    { level: 'debug', messageKey: 'msg' },
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString('utf8'));
        callback();
      },
    }),
  );
  const lines = () =>
    chunks
      .join('')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines };
}

const tick: TimeTriggerTick = {
  automations: 2,
  runs: 1,
  results: [
    { organizationId: ORG, automationId: AUT, outcome: 'fired', runs: 1, missed: 2 },
    { organizationId: ORG, automationId: 'aut_UnitAutomation02', outcome: 'idle', runs: 0 },
  ],
};

describe('time trigger crons (T508)', () => {
  it('ticks every minute', () => {
    expect(AUTOMATION_SCHEDULE_TICK_CRON).toBe('* * * * *');
    expect(AUTOMATION_DATE_SCAN_CRON).toBe('* * * * *');
    const items = parseCronItems([...CRON_ITEMS]);
    for (const identifier of ['automation.schedule_tick', 'automation.date_scan']) {
      const item = items.find((cron) => cron.identifier === identifier);
      expect(item).toMatchObject({ task: identifier });
      expect(item?.match({ min: 7, hour: 3, date: 1, month: 1, dow: 1 })).toBe(true);
    }
  });

  it('passes the injected clock and logs ids, codes and counts only', async () => {
    const { logger, lines } = capture();
    const now = new Date('2026-10-06T01:00:00Z');
    const calls: { kind: string; at: Date }[] = [];
    const triggers = {
      tickSchedules: (at: Date) => {
        calls.push({ kind: 'schedule', at });
        return Promise.resolve(tick);
      },
      scanDates: (at: Date) => {
        calls.push({ kind: 'date', at });
        return Promise.resolve(tick);
      },
    } satisfies Pick<AutomationTimeTriggers, 'tickSchedules' | 'scanDates'>;
    const helpers = {} as JobHelpers;
    await createAutomationScheduleTickTask({ triggers, logger, now: () => now })({}, helpers);
    await createAutomationDateScanTask({ triggers, logger, now: () => now })({}, helpers);
    expect(calls).toEqual([
      { kind: 'schedule', at: now },
      { kind: 'date', at: now },
    ]);
    const info = lines().filter((line) => line['level'] === 30);
    expect(info).toHaveLength(2);
    expect(info[0]).toMatchObject({
      msg: 'automation schedule',
      org_id: ORG,
      automation_id: AUT,
      outcome: 'fired',
      runs: 1,
      missed: 2,
    });
    expect(Object.keys(info[1] ?? {}).sort()).toEqual(
      [
        'automation_id',
        'hostname',
        'level',
        'msg',
        'org_id',
        'outcome',
        'pid',
        'runs',
        'time',
        'missed',
      ].sort(),
    );
  });
});
