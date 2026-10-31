import { parseCronItems } from 'graphile-worker';
import { describe, expect, it } from 'vitest';

import { AI_CRON_ITEMS, CRON_ITEMS, splitAiTasks } from '../../src/job-runner.js';

import type { TaskList } from 'graphile-worker';

/**
 * BACKLOG T910 (ADR-39 §7): `ai.*` tasks run on a runner of their own
 * (`AI_CONCURRENCY`), so slow provider calls never hold the slots of
 * `events.dispatch` or `automation.run`; the main runner never sees them.
 */
describe('AI runner (T910)', () => {
  const task = () => Promise.resolve();

  it('splits ai.* tasks from the others', () => {
    const list: TaskList = {
      'ai.generate': task,
      'ai.generation_rescue': task,
      'events.dispatch': task,
      'automation.run': task,
    };
    const { main, ai } = splitAiTasks(list);
    expect(Object.keys(main).sort()).toEqual(['automation.run', 'events.dispatch']);
    expect(Object.keys(ai).sort()).toEqual(['ai.generate', 'ai.generation_rescue']);
  });

  it('schedules the rescue every minute on the AI runner only', () => {
    expect(parseCronItems([...AI_CRON_ITEMS]).map((item) => item.task)).toEqual([
      'ai.generation_rescue',
    ]);
    expect(CRON_ITEMS.some((item) => item.task.startsWith('ai.'))).toBe(false);
  });
});
