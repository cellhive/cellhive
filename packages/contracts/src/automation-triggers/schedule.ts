import { z } from 'zod';

import { canonicalTimeZone } from '../time-zones.js';

/** The `schedule` trigger fires at most every 5 minutes (SPEC §11.2, BACKLOG T508). */
export const SCHEDULE_MIN_INTERVAL_MINUTES = 5;

/** Detail code (`AUTOMATION_INVALID`): the cron expression does not parse (`params.field`). */
export const INVALID_CRON = 'INVALID_CRON';
/** Detail code (`AUTOMATION_INVALID`): fires more often than every 5 minutes (`params.min_interval_minutes`). */
export const CRON_TOO_FREQUENT = 'CRON_TOO_FREQUENT';
/** Detail code (`AUTOMATION_INVALID`): `timezone` is not an IANA zone the server knows. */
export const INVALID_TIME_ZONE = 'INVALID_TIME_ZONE';

/**
 * `schedule` (SPEC §11.2, BACKLOG T508): a five-field cron
 * (`minute hour day-of-month month day-of-week`; `*`, numbers, `a-b`,
 * `*\/n`, `a-b/n`, lists, `JAN`…/`SUN`… names; day-of-month and
 * day-of-week both restricted → either matches) in an IANA time zone (`null`
 * = the organization's, read when it fires), at most every 5 minutes. Saved
 * definitions are checked by the server (`INVALID_CRON`,
 * `CRON_TOO_FREQUENT`, `INVALID_TIME_ZONE` under `422 AUTOMATION_INVALID`).
 * A tick every minute fires the latest due time once (`fired_at`); after a
 * downtime the missed times are not fired again (CONTRACTS §21 "Trigger thời
 * gian").
 */
export const scheduleTriggerSchema = z
  .strictObject({
    type: z.literal('schedule'),
    cron: z
      .string()
      .trim()
      .min(9)
      .max(100)
      .meta({ description: 'Five-field cron expression', example: '0 8 * * *' }),
    timezone: z
      .string()
      .min(1)
      .max(64)
      // Stored as the IANA primary name PostgreSQL knows (`Asia/Saigon` → `Asia/Ho_Chi_Minh`, T901).
      .overwrite((zone) => canonicalTimeZone(zone) ?? zone)
      .nullable()
      .default(null)
      .meta({
        description:
          'IANA time zone, an alias replaced by its IANA primary name; `null` = the organization’s',
        example: 'Asia/Ho_Chi_Minh',
      }),
  })
  .meta({
    id: 'ScheduleTrigger',
    description:
      'Fires at the cron times in `timezone` (IANA; `null` = the organization’s), at most ' +
      'every 5 minutes (`CRON_TOO_FREQUENT`; bad cron `INVALID_CRON`, unknown zone ' +
      '`INVALID_TIME_ZONE`). One run per fire time (`fired_at`); after a downtime only the ' +
      'latest missed time fires. Base admins only',
  });
