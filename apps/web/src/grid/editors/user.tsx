import { useQuery } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { orgMembersQuery } from '../../lib/query/queries';
import { Avatar } from '../display/Avatar';
import { initialsOf } from '../display/text';

import { matchesSearch, selectedUsers, userDraft } from './parse';
import { Picker, type PickerItem } from './picker';
import { useIssueMessage } from './shell';
import {
  MOVE_DOWN,
  type CellEditorProps,
  type EditorIssue,
  type EditorMove,
  type MemberOption,
} from './types';

function MemberChip({ member, fallback }: { member: MemberOption; fallback: string }) {
  const name = member.name || member.email;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Avatar colorKey={member.id}>{name === '' ? '?' : initialsOf(name)}</Avatar>
      <span className="truncate">{name === '' ? fallback : name}</span>
    </span>
  );
}

/** A member in the list: avatar, name, and the email below it in small type. */
function MemberRow({ member, fallback }: { member: MemberOption; fallback: string }) {
  const name = member.name || member.email;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar colorKey={member.id} size="md">
        {name === '' ? '?' : initialsOf(name)}
      </Avatar>
      <span className="flex min-w-0 flex-col">
        <span className="truncate" title={name === '' ? fallback : name}>
          {name === '' ? fallback : name}
        </span>
        {member.name !== '' && member.email !== '' ? (
          <span className="truncate text-label font-normal text-fg-muted" title={member.email}>
            {member.email}
          </span>
        ) : null}
      </span>
    </span>
  );
}

/**
 * `user` editor: organization members with search by name or email (one
 * user or several, per `options.multiple`). Writes `[{ id }]`; the cell
 * shows name and email at once.
 */
export function UserEditor({
  field,
  config,
  value,
  initialInput,
  cellHeight,
  cellWidth,
  context,
  onDraft,
  onCommit,
  onCancel,
}: CellEditorProps<'user'>) {
  const { t } = useTranslation('grid');
  const members = useQuery(orgMembersQuery(context.orgId));
  const { multiple } = config.options;
  const [selected, setSelected] = useState<MemberOption[]>(() => selectedUsers(value));
  const [search, setSearch] = useState(initialInput ?? '');
  const [active, setActive] = useState(initialInput === undefined ? -1 : 0);
  const [issue, setIssue] = useState<EditorIssue | null>(null);
  const error = useIssueMessage(issue);
  const errorId = useId();
  const formerMember = t('formerMember');

  const all = useMemo<MemberOption[]>(
    () =>
      (members.data?.items ?? []).map((member) => ({
        id: member.user.id,
        name: member.user.display_name,
        email: member.user.email,
      })),
    [members.data],
  );

  const items: PickerItem[] = useMemo(
    () =>
      all
        .filter(
          (member) => matchesSearch(member.name, search) || matchesSearch(member.email, search),
        )
        .map((member) => ({
          key: member.id,
          label: member.name || member.email,
          kind: 'choice',
          selected: selected.some((user) => user.id === member.id),
          // The name first (whole when it fits), the email under it, cut first.
          content: <MemberRow member={member} fallback={formerMember} />,
        })),
    [all, search, selected, formerMember],
  );

  const write = (users: readonly MemberOption[], move: EditorMove) => {
    const draft = userDraft(users, config.options);
    if (!draft.ok) {
      setIssue(draft.issue);
      return;
    }
    onCommit(draft.commit, move);
  };

  const update = (users: MemberOption[]) => {
    setSelected(users);
    setIssue(null);
    onDraft(userDraft(users, config.options));
  };

  const choose = (item: PickerItem) => {
    const member = all.find((candidate) => candidate.id === item.key);
    if (member === undefined) return;
    if (!multiple) {
      write([member], MOVE_DOWN);
      return;
    }
    update(
      selected.some((user) => user.id === member.id)
        ? selected.filter((user) => user.id !== member.id)
        : [...selected, member],
    );
    setSearch('');
    setActive(-1);
  };

  let status: string | null = null;
  if (members.isPending) status = t('edit.loadingMembers');
  else if (members.isError) status = t('edit.membersFailed');
  else if (items.length === 0) status = t('edit.noMatch');

  return (
    <Picker
      label={field.name}
      search={search}
      onSearch={(next) => {
        setSearch(next);
        setActive(next.trim() === '' ? -1 : 0);
      }}
      items={items}
      active={active}
      onActive={setActive}
      onChoose={choose}
      chips={selected.map((user) => ({
        key: user.id,
        label: user.name || user.email || formerMember,
        content: <MemberChip member={user} fallback={formerMember} />,
      }))}
      onRemoveChip={(id) => {
        update(selected.filter((user) => user.id !== id));
      }}
      multiple={multiple}
      cellHeight={cellHeight}
      cellWidth={cellWidth}
      error={error}
      errorId={errorId}
      status={status}
      onCommit={(move) => {
        write(selected, move);
      }}
      onCancel={onCancel}
      onBackspace={() => {
        if (selected.length > 0) update(selected.slice(0, -1));
      }}
    />
  );
}
