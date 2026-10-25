import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { matchesSearch, selectDraft, selectedNames } from './parse';
import { OptionChip, Picker, type PickerItem } from './picker';
import { useIssueMessage } from './shell';
import { MOVE_DOWN, type CellEditorProps, type EditorIssue, type EditorMove } from './types';

/**
 * `select` editor (single and multiple): a searchable list of the options
 * in their colors. A name that is not an option yet can be added when the
 * role may edit the field's options (`option_edit_fields`); the write then
 * goes with `typecast=true` and the server creates the option (CONTRACTS §2).
 */
export function SelectEditor({
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
}: CellEditorProps<'select'>) {
  const { t } = useTranslation('grid');
  const { multiple, options } = config.options;
  const canCreate = context.canCreateOption(field.id);
  const [selected, setSelected] = useState<string[]>(() => selectedNames(value));
  const [search, setSearch] = useState(initialInput ?? '');
  const [active, setActive] = useState(initialInput === undefined ? -1 : 0);
  const [issue, setIssue] = useState<EditorIssue | null>(null);
  const error = useIssueMessage(issue);
  const errorId = useId();

  const colorOf = useMemo(() => {
    const colors = new Map(options.map((option, index) => [option.name, option.color ?? index]));
    return (name: string) => colors.get(name) ?? 0;
  }, [options]);

  const typed = search.trim();
  const items: PickerItem[] = useMemo(() => {
    const matching: PickerItem[] = options
      .filter((option) => matchesSearch(option.name, typed))
      .map((option) => ({
        key: option.id,
        label: option.name,
        kind: 'choice',
        selected: selected.includes(option.name),
        content: <OptionChip name={option.name} color={colorOf(option.name)} />,
      }));
    const exists = options.some((option) => option.name === typed) || selected.includes(typed);
    if (canCreate && typed !== '' && !exists) {
      matching.push({ key: `create:${typed}`, label: typed, kind: 'create', selected: false });
    }
    return matching;
  }, [options, typed, selected, canCreate, colorOf]);

  const draftOf = (names: readonly string[]) => selectDraft(names, config.options, canCreate);

  const write = (names: readonly string[], move: EditorMove) => {
    const draft = draftOf(names);
    if (!draft.ok) {
      setIssue(draft.issue);
      return;
    }
    onCommit(draft.commit, move);
  };

  const update = (names: string[]) => {
    setSelected(names);
    setIssue(null);
    onDraft(draftOf(names));
  };

  const choose = (item: PickerItem) => {
    if (!multiple) {
      write([item.label], MOVE_DOWN);
      return;
    }
    update(
      selected.includes(item.label)
        ? selected.filter((name) => name !== item.label)
        : [...selected, item.label],
    );
    setSearch('');
    setActive(-1);
  };

  const commit = (move: EditorMove) => {
    // Single select: a typed name without a pick is what the user means.
    if (!multiple && typed !== '') write([typed], move);
    else write(selected, move);
  };

  const status =
    items.length === 0 ? (typed === '' ? t('edit.noOptions') : t('edit.noMatch')) : null;

  return (
    <Picker
      label={field.name}
      search={search}
      onSearch={(next) => {
        setSearch(next);
        setIssue(null);
        setActive(next.trim() === '' ? -1 : 0);
      }}
      items={items}
      active={active}
      onActive={setActive}
      onChoose={choose}
      chips={selected.map((name) => ({
        key: name,
        label: name,
        content: <OptionChip name={name} color={colorOf(name)} />,
      }))}
      onRemoveChip={(name) => {
        update(selected.filter((item) => item !== name));
      }}
      multiple={multiple}
      cellHeight={cellHeight}
      cellWidth={cellWidth}
      error={error}
      errorId={errorId}
      status={status}
      onCommit={commit}
      onCancel={onCancel}
      onBackspace={() => {
        if (selected.length > 0) update(selected.slice(0, -1));
      }}
    />
  );
}
