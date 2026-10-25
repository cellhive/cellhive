import { describe, expect, it } from 'vitest';

import {
  DATE_REMINDER_MAX_PER_SCAN,
  DATE_REMINDER_RECIPIENTS,
  DATE_REMINDER_USER_FIELD_TYPES,
  dateReminderOptionSchema,
  MAX_DATE_REMINDER_USER_IDS,
} from '../src/index.js';
import { generateOpenApiDocument } from '../src/openapi/index.js';

const FLD = 'fld_ContractRemind01';
const U1 = 'usr_ContractRemind01';

describe('datetime options.reminder (CONTRACTS §22.6, T547)', () => {
  it('keeps the limits of CONTRACTS §22.6', () => {
    expect(MAX_DATE_REMINDER_USER_IDS).toBe(50);
    expect(DATE_REMINDER_MAX_PER_SCAN).toBe(1000);
    expect(DATE_REMINDER_RECIPIENTS).toEqual(['field_user', 'users']);
    expect(DATE_REMINDER_USER_FIELD_TYPES).toEqual(['user', 'created_by']);
  });

  it.each([
    [{ recipients: 'field_user', user_field_id: FLD }, true],
    [{ recipients: 'users', user_ids: [U1], offset_minutes: -43_200, time_of_day: '00:00' }, true],
    [{ recipients: 'users', user_ids: [U1], offset_minutes: 43_200, time_of_day: '23:59' }, true],
    [{ recipients: 'users', user_ids: [] }, false],
    [{ recipients: 'users', user_ids: [U1, U1] }, false],
    [{ recipients: 'field_user' }, false],
    [{ recipients: 'field_user', user_field_id: U1 }, false],
    [{ recipients: 'users', user_ids: [U1], offset_minutes: 43_201 }, false],
    [{ recipients: 'users', user_ids: [U1], time_of_day: '12:60' }, false],
    [{ recipients: 'users', user_ids: [U1], extra: true }, false],
    [{ user_ids: [U1] }, false],
  ] as const)('%j → %s', (input, ok) => {
    expect(dateReminderOptionSchema.safeParse(input).success).toBe(ok);
  });

  it('is published as the DateReminderOption component', () => {
    const document = generateOpenApiDocument();
    const component = document.components?.schemas?.['DateReminderOption'];
    expect(component).toBeDefined();
    expect(JSON.stringify(component)).toContain('field_user');
    expect(JSON.stringify(document.components?.schemas?.['FieldOptions'])).toContain(
      'DateReminderOption',
    );
  });
});
