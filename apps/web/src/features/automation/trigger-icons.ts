import {
  CalendarClock,
  CirclePlus,
  Clock,
  FileInput,
  Filter,
  MousePointerClick,
  Pencil,
  Trash2,
  Webhook,
  type LucideIcon,
} from 'lucide-react';

import type { AutomationTriggerType } from '@cellhive/contracts';

/**
 * Icon of each trigger type (list rows, the create dialog, the builder). A
 * module of its own so the builder does not load the create dialog for it.
 */
export const TRIGGER_ICONS: Record<AutomationTriggerType, LucideIcon> = {
  'record.created': CirclePlus,
  'record.updated': Pencil,
  'record.deleted': Trash2,
  'record.matches': Filter,
  'form.submitted': FileInput,
  schedule: Clock,
  'record.date_reached': CalendarClock,
  'button.clicked': MousePointerClick,
  'webhook.received': Webhook,
};
