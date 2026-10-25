import {
  describeAutomationDisabled,
  describeAutomationMessage,
  describeBatchOverflow,
} from './automation';
import { describeDateReminder } from './date-reminder';
import { describeImportFinished } from './import-finished';
import { describeRecordAssigned } from './record-assigned';
import { describeRecordFollowedChanged } from './record-followed-changed';
import { NO_EXTRAS, type ItemContext, type ItemView } from './shared';

import type { NotificationDto } from '@cellhive/contracts';

export type { ItemContext, ItemPill, ItemView, Translate } from './shared';
export { reminderStatus } from './date-reminder';

/**
 * Renderers per notification type (T552, FRONTEND §14.1): one file each,
 * pure (title, body, status chip, extras). A type without a renderer yet
 * (S10/S11 types) reads "New notification".
 */
export function describeNotification(item: NotificationDto, ctx: ItemContext): ItemView {
  switch (item.type) {
    case 'automation.message':
      return describeAutomationMessage(item, ctx);
    case 'automation.disabled':
      return describeAutomationDisabled(item, ctx);
    case 'automation.batch_overflow':
      return describeBatchOverflow(item, ctx);
    case 'record.assigned':
      return describeRecordAssigned(item, ctx);
    case 'record.followed_changed':
      return describeRecordFollowedChanged(item, ctx);
    case 'date.reminder':
      return describeDateReminder(item, ctx);
    case 'import.finished':
      return describeImportFinished(item, ctx);
    default:
      return { kind: 'other', title: ctx.t('item.other'), body: null, ...NO_EXTRAS };
  }
}

/**
 * Field ids whose names the renderer of `item` shows (the panel resolves
 * them with the table's fields as the viewer sees them), `[]` for none.
 */
export function fieldIdsOf(item: NotificationDto): string[] {
  const list = (key: string): string[] => {
    const value = item.data[key];
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : [];
  };
  switch (item.type) {
    case 'record.assigned':
    case 'record.followed_changed':
      return list('field_ids');
    case 'date.reminder': {
      const fieldId = item.data['field_id'];
      return typeof fieldId === 'string' ? [fieldId] : [];
    }
    default:
      return [];
  }
}

/** The renderer names the item's table (only `import.finished`: jobs have no title). */
export function needsTableName(item: NotificationDto): boolean {
  return item.type === 'import.finished' && item.table_id !== null && item.base !== null;
}
