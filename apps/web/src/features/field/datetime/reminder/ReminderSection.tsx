import { MAX_DATE_REMINDER_USER_IDS, type FieldDto } from '@cellhive/contracts';
import { Alert, Checkbox, cn, FormField, Input, Select } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { AlarmClock } from 'lucide-react';
import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useFormatters } from '../../../../lib/i18n/format';
import { fieldsQuery, orgMembersQuery, orgQuery } from '../../../../lib/query/queries';
import {
  DEFAULT_DUE_TIME_OF_DAY,
  exampleValueOf,
  maxAmountOf,
  recipientFieldsOf,
  reminderDueAt,
  reminderTimingText,
  REMINDER_DIRECTIONS,
  REMINDER_UNITS,
  TIME_OF_DAY_STEPS,
  type ReminderDirection,
  type ReminderUnit,
} from '../../../../lib/schema/date-reminder';
import { useIssueText } from '../../components/shared';

import { REMINDER_PATH, reminderOptionOf, type ReminderDraft } from './draft';
import { RecipientMembers } from './RecipientMembers';

import type { DraftIssue } from '../../draft';

export interface ReminderSectionProps {
  readonly value: ReminderDraft;
  readonly onChange: (value: ReminderDraft) => void;
  readonly tableId: string;
  readonly orgId: string | undefined;
  /** The field's display format has no time. */
  readonly dateOnly: boolean;
  /** `options.timezone` of the field (absent: the organization's applies). */
  readonly fieldTimeZone: string | undefined;
  /** Issues under `options.reminder` to show: the form's (after a save) and the server's. */
  readonly issues: readonly DraftIssue[];
  /** The user may change the table's schema; others only read what the reminder does. */
  readonly canManage: boolean;
  /** Fixed "now" of the dialog (the preview's example value). */
  readonly now: Date;
}

/** Codes the section explains itself (`field:reminder.errors.*`); others use the shared texts. */
const OWN_CODES = new Set([
  'REMINDER_AMOUNT',
  'REMINDER_FIELD_REQUIRED',
  'REMINDER_USERS_REQUIRED',
  'REMINDER_USERS_TOO_MANY',
  'UNKNOWN_FIELD',
  'INVALID_FIELD_TYPE',
  'USER_NOT_FOUND',
]);

const RADIO_LABEL = 'flex min-h-6 items-center gap-2 text-body text-fg max-lg:min-h-control';

/**
 * "Reminder" of the `datetime` field dialog (T554, CONTRACTS §2 / §22.6,
 * board "S5b · Date reminder" — built from FRONTEND §9.3 tokens and the
 * dialog's existing controls): on/off (a checkbox: saved with the dialog);
 * when (on time / N minutes·hours·days before or after; date-only fields:
 * a time of day 00:00–23:30 every 30 minutes in the field's zone, said
 * explicitly); to whom (the people of a `user`/`created_by` field of the
 * table, or up to 50 members); an example of the next reminder moment;
 * what recipients must be able to read. `422` details under
 * `options.reminder.*` are shown at their control. People without schema
 * rights get a read-only summary (the dialog is normally not theirs).
 */
export function ReminderSection({
  value,
  onChange,
  tableId,
  orgId,
  dateOnly,
  fieldTimeZone,
  issues,
  canManage,
  now,
}: ReminderSectionProps) {
  const { t, i18n } = useTranslation('field');
  const { t: tg } = useTranslation('grid');
  const issueText = useIssueText();
  const format = useFormatters();
  const id = useId();
  const fields = useQuery(fieldsQuery(tableId));
  const org = useQuery({ ...orgQuery(orgId ?? ''), enabled: orgId !== undefined });
  const members = useQuery({
    ...orgMembersQuery(orgId ?? ''),
    enabled: orgId !== undefined && value.enabled,
  });

  const allFields: readonly FieldDto[] = fields.data?.items ?? [];
  const candidates = recipientFieldsOf(allFields);
  const chosen = allFields.find((field) => field.id === value.userFieldId);
  const recipientState =
    value.recipients !== 'field_user' || value.userFieldId === '' || fields.data === undefined
      ? 'ok'
      : chosen === undefined
        ? 'missing'
        : candidates.includes(chosen)
          ? 'ok'
          : 'wrong_type';
  const orgZone = org.data?.settings.timezone;
  // Date-only values are read in the field's zone, else the organization's (ADR-21).
  const zone = fieldTimeZone ?? orgZone ?? format.timeZone;

  const set = (patch: Partial<ReminderDraft>) => {
    onChange({ ...value, ...patch });
  };

  const textOf = (issue: DraftIssue | undefined): string | undefined => {
    if (issue === undefined) return undefined;
    const code = issue.detail.code;
    if (!OWN_CODES.has(code)) return issueText(issue);
    if (code === 'USER_NOT_FOUND') {
      const index = Number(issue.path.split('.').pop());
      const userId = value.userIds[index];
      const name =
        members.data?.items.find((member) => member.user.id === userId)?.user.display_name ??
        t('field:reminder.unknownMember');
      return t('field:reminder.errors.USER_NOT_FOUND', { name });
    }
    return t(`field:reminder.errors.${code}`, issue.detail.params ?? {});
  };
  const at = (path: string) => issues.find((issue) => issue.path === `${REMINDER_PATH}.${path}`);
  const amountIssue = at('offset_minutes');
  const timeIssue = at('time_of_day');
  const fieldIssue = at('user_field_id');
  const usersIssue = at('user_ids');
  const memberIssues = issues.filter((issue) =>
    issue.path.startsWith(`${REMINDER_PATH}.user_ids.`),
  );
  // Issues a control shows; the rest (or those of the recipient kind not chosen) go below.
  const fieldShown =
    value.recipients === 'field_user' && (candidates.length > 0 || recipientState !== 'ok');
  const known = new Set(
    [
      amountIssue,
      timeIssue,
      ...(fieldShown ? [fieldIssue] : []),
      ...(value.recipients === 'users' ? [usersIssue, ...memberIssues] : []),
    ].filter((issue) => issue !== undefined),
  );
  const otherIssues = issues.filter((issue) => !known.has(issue));

  // The next reminder for an example value (a week from now), as the server computes it.
  const preview = useMemo(() => {
    const option = reminderOptionOf(value, dateOnly);
    if (option === null || !Number.isInteger(option['offset_minutes'])) return null;
    const valueZone = dateOnly ? zone : (fieldTimeZone ?? format.timeZone);
    const example = exampleValueOf(now, dateOnly, valueZone);
    const due = reminderDueAt({
      dateOnly,
      value: example,
      offsetMinutes: option['offset_minutes'] as number,
      timeOfDay: dateOnly ? value.timeOfDay : null,
      timeZone: zone,
    });
    if (due === null) return null;
    const dateTime = (timeZone: string) =>
      new Intl.DateTimeFormat(i18n.language, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone,
      });
    const exampleText = dateOnly
      ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeZone: 'UTC' }).format(
          new Date(`${example}T12:00:00Z`),
        )
      : dateTime(valueZone).format(new Date(example));
    return {
      example: exampleText,
      due: dateTime(valueZone).format(due),
      zone: valueZone,
      local:
        valueZone === format.timeZone
          ? null
          : { time: dateTime(format.timeZone).format(due), zone: format.timeZone },
    };
  }, [value, dateOnly, zone, fieldTimeZone, format.timeZone, now, i18n.language]);

  const heading = (
    <div className="flex items-center gap-2">
      <AlarmClock aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
      <h3 id={`${id}-title`} className="text-label text-fg">
        {t('field:reminder.title')}
      </h3>
    </div>
  );

  if (!canManage) {
    const option = reminderOptionOf(value, dateOnly);
    return (
      <section
        aria-labelledby={`${id}-title`}
        className="flex flex-col gap-2 border-t border-line pt-4"
        data-testid="reminder-section"
      >
        {heading}
        <p className="text-body text-fg">
          {option === null
            ? t('field:reminder.off')
            : reminderTimingText(
                tg,
                {
                  offset_minutes: option['offset_minutes'] as number,
                  time_of_day: value.timeOfDay,
                },
                dateOnly,
              )}
        </p>
        <p className="text-label font-normal text-fg-muted">{t('field:reminder.readOnly')}</p>
      </section>
    );
  }

  const amountMax = maxAmountOf(value.unit);
  const timeOptions =
    value.timeOfDay !== null && !TIME_OF_DAY_STEPS.includes(value.timeOfDay)
      ? [...TIME_OF_DAY_STEPS, value.timeOfDay].sort()
      : TIME_OF_DAY_STEPS;

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex min-w-0 flex-col gap-4 border-t border-line pt-4"
      data-testid="reminder-section"
    >
      {heading}
      <Checkbox
        label={t('field:reminder.enable')}
        hint={t('field:reminder.enableHint')}
        checked={value.enabled}
        data-testid="reminder-enabled"
        onChange={(event) => {
          if (!event.target.checked) {
            set({ enabled: false });
            return;
          }
          // The first person field of the table, when there is one and none is chosen yet.
          const first = candidates[0];
          set({
            enabled: true,
            ...(value.userFieldId === '' && value.userIds.length === 0
              ? first === undefined
                ? { recipients: 'users' as const }
                : { recipients: 'field_user' as const, userFieldId: first.id }
              : {}),
          });
        }}
      />
      {value.enabled ? (
        <div className="flex min-w-0 flex-col gap-4 sm:pl-6">
          <fieldset className="flex min-w-0 flex-col gap-3">
            <legend className="mb-1 text-label text-fg">{t('field:reminder.when')}</legend>
            <div
              className={cn(
                'grid min-w-0 gap-2',
                value.direction === 'at'
                  ? 'grid-cols-1'
                  : 'grid-cols-[minmax(0,1fr)_5rem_minmax(0,1fr)]',
              )}
            >
              <Select
                aria-label={t('field:reminder.direction')}
                value={value.direction}
                data-testid="reminder-direction"
                onChange={(event) => {
                  set({ direction: event.target.value as ReminderDirection });
                }}
              >
                {REMINDER_DIRECTIONS.map((direction) => (
                  <option key={direction} value={direction}>
                    {t(
                      direction === 'at' && dateOnly
                        ? 'field:reminder.directions.onDay'
                        : `field:reminder.directions.${direction}`,
                    )}
                  </option>
                ))}
              </Select>
              {value.direction === 'at' ? null : (
                <>
                  <Input
                    aria-label={t('field:reminder.amount')}
                    inputMode="numeric"
                    autoComplete="off"
                    value={value.amount}
                    aria-invalid={amountIssue !== undefined}
                    aria-describedby={amountIssue === undefined ? undefined : `${id}-amount`}
                    data-testid="reminder-amount"
                    onChange={(event) => {
                      set({ amount: event.target.value });
                    }}
                  />
                  <Select
                    aria-label={t('field:reminder.unit')}
                    value={value.unit}
                    data-testid="reminder-unit"
                    onChange={(event) => {
                      set({ unit: event.target.value as ReminderUnit });
                    }}
                  >
                    {REMINDER_UNITS.map((unit) => (
                      <option key={unit} value={unit}>
                        {t(`field:reminder.units.${unit}`)}
                      </option>
                    ))}
                  </Select>
                </>
              )}
            </div>
            {amountIssue === undefined ? (
              value.direction === 'at' ? null : (
                <p className="text-label font-normal text-fg-muted">
                  {value.unit === 'days'
                    ? t('field:reminder.amountHintDays')
                    : t('field:reminder.amountHint', { max: amountMax })}
                </p>
              )
            ) : (
              <p id={`${id}-amount`} className="text-label font-normal text-danger">
                {textOf(amountIssue)}
              </p>
            )}
            {dateOnly ? (
              <FormField
                label={t('field:reminder.timeOfDay')}
                hint={t(
                  fieldTimeZone === undefined
                    ? 'field:reminder.zoneOrg'
                    : 'field:reminder.zoneField',
                  { zone },
                )}
                error={textOf(timeIssue)}
              >
                {(control) => (
                  <Select
                    {...control}
                    value={value.timeOfDay ?? DEFAULT_DUE_TIME_OF_DAY}
                    data-testid="reminder-time"
                    onChange={(event) => {
                      set({ timeOfDay: event.target.value });
                    }}
                  >
                    {timeOptions.map((time) => (
                      <option key={time} value={time}>
                        {time}
                      </option>
                    ))}
                  </Select>
                )}
              </FormField>
            ) : (
              <>
                <p className="text-label font-normal text-fg-muted">
                  {t('field:reminder.withTime')}
                </p>
                {timeIssue === undefined ? null : (
                  <p className="text-label font-normal text-danger">{textOf(timeIssue)}</p>
                )}
              </>
            )}
          </fieldset>

          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="mb-1 text-label text-fg">{t('field:reminder.recipients')}</legend>
            <label className={RADIO_LABEL}>
              <input
                type="radio"
                name={`${id}-recipients`}
                className="size-4"
                checked={value.recipients === 'field_user'}
                data-testid="reminder-recipients-field"
                onChange={() => {
                  set({
                    recipients: 'field_user',
                    userFieldId:
                      value.userFieldId === '' ? (candidates[0]?.id ?? '') : value.userFieldId,
                  });
                }}
              />
              {t('field:reminder.recipientsField')}
            </label>
            {value.recipients === 'field_user' ? (
              <div className="flex min-w-0 flex-col gap-2 pl-6">
                {recipientState === 'ok' ? null : (
                  <Alert variant="danger" role="status" data-testid="reminder-recipient-broken">
                    <p>
                      {recipientState === 'missing'
                        ? t('field:reminder.broken.missing')
                        : t('field:reminder.broken.wrongType', { field: chosen?.name ?? '' })}
                    </p>
                  </Alert>
                )}
                {candidates.length === 0 && recipientState === 'ok' ? (
                  <p className="text-label font-normal text-fg-muted">
                    {t('field:reminder.noUserFields')}
                  </p>
                ) : (
                  <FormField label={t('field:reminder.userField')} error={textOf(fieldIssue)}>
                    {(control) => (
                      <Select
                        {...control}
                        value={value.userFieldId}
                        data-testid="reminder-user-field"
                        onChange={(event) => {
                          set({ userFieldId: event.target.value });
                        }}
                      >
                        {value.userFieldId === '' ? (
                          <option value="">{t('field:reminder.chooseField')}</option>
                        ) : null}
                        {recipientState === 'ok' ? null : (
                          <option value={value.userFieldId}>
                            {recipientState === 'missing'
                              ? t('field:reminder.deletedField')
                              : (chosen?.name ?? '')}
                          </option>
                        )}
                        {candidates.map((field) => (
                          <option key={field.id} value={field.id}>
                            {field.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  </FormField>
                )}
              </div>
            ) : null}
            <label className={RADIO_LABEL}>
              <input
                type="radio"
                name={`${id}-recipients`}
                className="size-4"
                checked={value.recipients === 'users'}
                data-testid="reminder-recipients-users"
                onChange={() => {
                  set({ recipients: 'users' });
                }}
              />
              {t('field:reminder.recipientsUsers', { max: MAX_DATE_REMINDER_USER_IDS })}
            </label>
            {value.recipients === 'users' ? (
              <div className="min-w-0 pl-6">
                <RecipientMembers
                  userIds={value.userIds}
                  members={members.data?.items ?? []}
                  loading={members.isPending && orgId !== undefined}
                  listIssue={textOf(usersIssue)}
                  memberIssues={memberIssues.map((issue) => ({
                    path: issue.path,
                    text: textOf(issue) ?? '',
                  }))}
                  onChange={(userIds) => {
                    set({ userIds });
                  }}
                />
              </div>
            ) : null}
          </fieldset>

          {preview === null ? null : (
            <div
              className="flex flex-col gap-1 rounded-md bg-surface-sunken px-3 py-2"
              data-testid="reminder-preview"
            >
              <p className="text-label text-fg">{t('field:reminder.preview.title')}</p>
              <p className="text-body text-fg">
                {t('field:reminder.preview.text', {
                  value: preview.example,
                  due: preview.due,
                  zone: preview.zone,
                })}
              </p>
              {preview.local === null ? null : (
                <p className="text-label font-normal text-fg-muted">
                  {t('field:reminder.preview.local', preview.local)}
                </p>
              )}
            </div>
          )}
          {otherIssues.map((issue) => (
            <p key={issue.path} role="alert" className="text-label font-normal text-danger">
              {textOf(issue)}
            </p>
          ))}
          <p className="text-label font-normal text-fg-muted" data-testid="reminder-note">
            {t('field:reminder.note')}
          </p>
        </div>
      ) : null}
    </section>
  );
}
