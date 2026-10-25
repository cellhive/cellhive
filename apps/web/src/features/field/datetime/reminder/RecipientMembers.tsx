import { MAX_DATE_REMINDER_USER_IDS, type OrgMemberDto } from '@cellhive/contracts';
import { Button, cn, Select, Spinner } from '@cellhive/ui';
import { Plus, X } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { userIndexOf } from './draft';

export interface RecipientMembersProps {
  readonly userIds: readonly string[];
  readonly members: readonly OrgMemberDto[];
  readonly loading: boolean;
  /** Error of the whole list (none chosen, too many). */
  readonly listIssue: string | undefined;
  /** Errors of single members (`options.reminder.user_ids.<i>`, e.g. not a member). */
  readonly memberIssues: readonly { readonly path: string; readonly text: string }[];
  readonly onChange: (userIds: readonly string[]) => void;
}

/**
 * The fixed members a reminder goes to (`recipients: users`, 1–50): chips
 * with a remove button each, and a member select + "Add" (a native select
 * with its own button, so that arrow keys never add someone by mistake).
 * A member the server refused is marked on its chip and named below.
 */
export function RecipientMembers({
  userIds,
  members,
  loading,
  listIssue,
  memberIssues,
  onChange,
}: RecipientMembersProps) {
  const { t } = useTranslation('field');
  const id = useId();
  const [picked, setPicked] = useState('');
  const chosen = new Set(userIds);
  const available = members.filter((member) => !chosen.has(member.user.id));
  const full = userIds.length >= MAX_DATE_REMINDER_USER_IDS;
  const refused = new Set(
    memberIssues.map((issue) => userIndexOf(issue.path)).filter((index) => index !== null),
  );
  const nameOf = (userId: string) =>
    members.find((member) => member.user.id === userId)?.user.display_name ??
    t('reminder.unknownMember');
  const pick = picked !== '' && !chosen.has(picked) ? picked : '';
  const errorIds = [
    listIssue === undefined ? null : `${id}-list-error`,
    memberIssues.length === 0 ? null : `${id}-member-errors`,
  ]
    .filter((value) => value !== null)
    .join(' ');

  const add = () => {
    if (pick === '' || full) return;
    onChange([...userIds, pick]);
    setPicked('');
  };

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="reminder-members">
      {userIds.length === 0 ? null : (
        <ul
          className="flex min-w-0 flex-wrap gap-1"
          aria-label={t('reminder.membersChosen', {
            count: userIds.length,
            max: MAX_DATE_REMINDER_USER_IDS,
          })}
        >
          {userIds.map((userId, index) => {
            const name = nameOf(userId);
            const invalid = refused.has(index);
            return (
              <li
                key={userId}
                className={cn(
                  'flex min-w-0 max-w-full items-center gap-1 rounded-sm border py-0.5 pr-0.5 pl-2 text-label font-normal',
                  invalid
                    ? 'border-danger bg-surface text-danger'
                    : 'border-line bg-surface-sunken text-fg',
                )}
                data-testid="reminder-member"
                data-invalid={invalid ? 'true' : undefined}
              >
                <span className="truncate">{name}</span>
                {invalid ? <span className="sr-only">{t('reminder.memberRefused')}</span> : null}
                <button
                  type="button"
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-fg-muted hover:bg-surface hover:text-fg max-lg:size-control"
                  aria-label={t('reminder.removeMember', { name })}
                  onClick={() => {
                    onChange(userIds.filter((other) => other !== userId));
                  }}
                >
                  <X aria-hidden="true" className="size-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex min-w-0 items-start gap-2">
        <Select
          aria-label={t('reminder.chooseMember')}
          value={pick}
          disabled={full || loading}
          aria-invalid={listIssue !== undefined}
          aria-describedby={errorIds === '' ? undefined : errorIds}
          data-testid="reminder-member-select"
          onChange={(event) => {
            setPicked(event.target.value);
          }}
          onKeyDown={(event) => {
            // Enter adds the picked member instead of submitting the dialog.
            if (event.key === 'Enter' && pick !== '') {
              event.preventDefault();
              add();
            }
          }}
        >
          <option value="">{t(full ? 'reminder.membersFull' : 'reminder.chooseMember')}</option>
          {available.map((member) => (
            <option key={member.user.id} value={member.user.id}>
              {t('reminder.memberOption', {
                name: member.user.display_name,
                email: member.user.email,
              })}
            </option>
          ))}
        </Select>
        <Button
          variant="secondary"
          className="shrink-0"
          disabled={pick === '' || full}
          data-testid="reminder-member-add"
          onClick={add}
        >
          {loading ? <Spinner /> : <Plus aria-hidden="true" />}
          {t('reminder.addMember')}
        </Button>
      </div>
      <p className="text-label font-normal text-fg-muted">
        {t('reminder.membersHint', { count: userIds.length, max: MAX_DATE_REMINDER_USER_IDS })}
      </p>
      {listIssue === undefined ? null : (
        <p id={`${id}-list-error`} className="text-label font-normal text-danger">
          {listIssue}
        </p>
      )}
      {memberIssues.length === 0 ? null : (
        <ul id={`${id}-member-errors`} className="flex flex-col gap-0.5">
          {memberIssues.map((issue) => (
            <li key={issue.path} className="text-label font-normal text-danger">
              {issue.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
