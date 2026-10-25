import {
  DEFAULT_AUTOMATION_MAX_DEPTH,
  MAX_AUTOMATION_MAX_DEPTH,
  type Id,
} from '@cellhive/contracts';

import type { JsonValue } from '../../db/schema.js';
import type { Causation } from '../../events/event.js';

/**
 * `settings.automation_max_depth` of an organization (SPEC §11.6): the
 * stored value when it is an integer in 1…5, else the default 3.
 */
export function automationMaxDepthOf(settings: JsonValue): number {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    return DEFAULT_AUTOMATION_MAX_DEPTH;
  }
  const value = settings.automation_max_depth;
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_AUTOMATION_MAX_DEPTH
    ? value
    : DEFAULT_AUTOMATION_MAX_DEPTH;
}

/** Why the loop guard stops an automation, or `null` when it may run. */
export type LoopGuardVerdict = 'max_depth' | 'already_in_chain' | null;

/**
 * Loop guard (SPEC §11.6): no run when the event is `maxDepth` or more
 * automation steps away from a person's change, or when the automation
 * already took part in the chain (it never triggers itself again).
 */
export function loopGuard(
  causation: Causation,
  automationId: Id<'aut'>,
  maxDepth: number,
): LoopGuardVerdict {
  if (causation.depth >= maxDepth) return 'max_depth';
  if (causation.automation_chain.includes(automationId)) return 'already_in_chain';
  return null;
}
