import { Checkbox } from '@cellhive/ui';
import { useTranslation } from 'react-i18next';

import type { UserDraft } from '../../draft';

export interface UserOptionsFormProps {
  readonly value: UserDraft;
  readonly onChange: (value: UserDraft) => void;
}

/** `user` options: one or several people, notification, default assignee. */
export function UserOptionsForm({ value, onChange }: UserOptionsFormProps) {
  const { t } = useTranslation('field');
  return (
    <>
      <Checkbox
        label={t('user.multiple')}
        checked={value.multiple}
        onChange={(event) => {
          onChange({ ...value, multiple: event.target.checked });
        }}
      />
      <Checkbox
        label={t('user.notify')}
        hint={t('user.notifyHint')}
        checked={value.notifyOnAssign}
        onChange={(event) => {
          onChange({ ...value, notifyOnAssign: event.target.checked });
        }}
      />
      <Checkbox
        label={t('user.defaultCurrentUser')}
        checked={value.defaultCurrentUser}
        onChange={(event) => {
          onChange({ ...value, defaultCurrentUser: event.target.checked });
        }}
      />
    </>
  );
}
