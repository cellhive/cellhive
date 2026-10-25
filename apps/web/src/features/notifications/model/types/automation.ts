import { int, NO_EXTRAS, str, type ItemContext, type ItemView } from './shared';

import type { NotificationDto } from '@cellhive/contracts';

/** The automation's name when the item is about it and the viewer sees it (CONTRACTS §22.3). */
function automationName(item: NotificationDto): string | null {
  return item.entity.type === 'automation' ? item.entity.title : null;
}

/** `automation.message` (T515): the title and body rendered for this recipient (ADR-32 §1). */
export function describeAutomationMessage(item: NotificationDto, ctx: ItemContext): ItemView {
  const body = str(item, 'body');
  return {
    kind: 'message',
    title: str(item, 'title') ?? ctx.t('item.message'),
    body: body === null || body === '' ? null : body,
    ...NO_EXTRAS,
  };
}

/** `automation.disabled` (ADR-25/26): name when seen, and why. */
export function describeAutomationDisabled(item: NotificationDto, ctx: ItemContext): ItemView {
  const name = automationName(item);
  const reason = str(item, 'reason');
  return {
    kind: 'disabled',
    title: name === null ? ctx.t('item.disabledUnnamed') : ctx.t('item.disabled', { name }),
    body:
      reason === 'circuit_breaker' || reason === 'run_as_lost_access'
        ? ctx.t(`item.disabledReason.${reason}`)
        : null,
    ...NO_EXTRAS,
  };
}

/**
 * `automation.batch_overflow` (ADR-26): the run limit and, since T542 (QA
 * S5 L6), how many records of the batch got no run (`skipped`, computed
 * when read; `null` when the viewer no longer sees the automation).
 */
export function describeBatchOverflow(item: NotificationDto, ctx: ItemContext): ItemView {
  const name = automationName(item);
  const limit = int(item, 'limit');
  const skipped = int(item, 'skipped');
  const limitText = limit === null ? null : ctx.format.number(limit);
  let body: string | null = null;
  if (skipped !== null && limitText !== null) {
    body = ctx.t('item.overflowSkipped', {
      count: skipped,
      formatted: ctx.format.number(skipped),
      limit: limitText,
    });
  } else if (limitText !== null) {
    body = ctx.t('item.overflowBody', { limit: limitText });
  }
  return {
    kind: 'overflow',
    title: name === null ? ctx.t('item.overflowUnnamed') : ctx.t('item.overflow', { name }),
    body,
    ...NO_EXTRAS,
  };
}
