import { linkCellLimit } from '@cellhive/field-types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { translateError } from '../../lib/errors/translate';
import { forgetLinkRecents, readLinkRecents, rememberLinkRecents } from '../../lib/links/recent';
import { canAddRecord, canEditField } from '../../lib/permissions/access';
import { keys } from '../../lib/query/keys';
import { tablesQuery } from '../../lib/query/queries';

import { createFormFields, createLinkedRecord, needsForm } from './components/CreateRecordForm';
import * as model from './model/selection';
import {
  displayValues,
  SEARCH_DEBOUNCE_MS,
  useDebounced,
  useLinkCandidates,
  useLinkedFields,
  type Candidate,
  type DisplayValue,
} from './use-candidates';

import type { LinkPickerProps } from '../../lib/links/picker';
import type { LinkRef } from '../../lib/links/values';

/** A group of the list: "Recent", or the results (all, search, selected only). */
export interface PickerSection {
  readonly key: 'recent' | 'main';
  readonly heading: string | null;
  readonly items: readonly Candidate[];
}

/** One option of the list, flattened across sections for the keyboard. */
export interface PickerOption {
  /** DOM id (`aria-activedescendant`). */
  readonly id: string;
  readonly section: PickerSection['key'];
  readonly candidate: Candidate;
  readonly values: readonly DisplayValue[];
  readonly disabledReason: string | undefined;
}

export type PickerScope = 'all' | 'selected';

/** A candidate as a linked record. */
export function refOf(candidate: Candidate): LinkRef {
  return { id: candidate.id, title: candidate.title };
}

/**
 * State of the link picker (T413) shared by its three forms — the
 * single-link popover, the multi-link dialog and the phone sheet: the
 * selection (saved once), the debounced search, "selected only", "Recent",
 * the options for the keyboard, creating a record, the announcements.
 */
export function usePicker(props: LinkPickerProps, options: { withRecent: boolean }) {
  const { t, i18n } = useTranslation('link');
  const queryClient = useQueryClient();
  const listId = useId();
  const multiple = props.options.allow_multiple;
  const limit = linkCellLimit(props.options);
  const linkTable = props.options.link_table;
  const fieldId = props.field.id;

  const [selection, setSelection] = useState(() => model.selectionOf(props.value, limit));
  const [search, setSearch] = useState(props.initialSearch ?? '');
  // More characters typed on the cell while the picker was on its way: they go on in the search.
  const [typed, setTyped] = useState(props.initialSearch ?? '');
  if ((props.initialSearch ?? '') !== typed) {
    const next = props.initialSearch ?? '';
    setTyped(next);
    if (next.startsWith(typed)) setSearch((current) => current + next.slice(typed.length));
  }
  const debounced = useDebounced(search, SEARCH_DEBOUNCE_MS);
  const [scope, setScopeState] = useState<PickerScope>('all');
  // "Selected only" lists the records chosen when it was opened: unchecking one keeps its row.
  const [scopeIds, setScopeIds] = useState<readonly string[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const [blocked, setBlocked] = useState(false);
  const [creating, setCreating] = useState<{ readonly name: string } | null>(null);

  const recentScope = useMemo(
    () => (props.userId === null ? null : { userId: props.userId, orgId: props.orgId, fieldId }),
    [props.userId, props.orgId, fieldId],
  );
  const [recentIds] = useState<readonly string[]>(() =>
    recentScope === null ? [] : readLinkRecents(recentScope),
  );

  const tables = useQuery(tablesQuery(props.baseId));
  const tableName =
    tables.data?.items.find((table) => table.id === linkTable)?.name ?? props.field.name;
  const fields = useLinkedFields(linkTable);
  const fieldList = fields.data?.items;
  const primary = fieldList?.find((field) => field.is_primary);

  const main = useLinkCandidates({
    fieldId,
    linkTable,
    recordId: props.recordId,
    search: debounced,
    ids: scope === 'selected' ? scopeIds : null,
    enabled: scope === 'all' || scopeIds.length > 0,
  });
  const showRecent =
    options.withRecent && scope === 'all' && debounced.trim() === '' && recentIds.length > 0;
  const recent = useLinkCandidates({
    fieldId,
    linkTable,
    recordId: props.recordId,
    search: '',
    ids: recentIds,
    enabled: showRecent,
  });
  // Recent records gone (deleted, no longer readable) are forgotten.
  const recentItems = recent.items;
  const recentLoaded = recent.status === 'success';
  useEffect(() => {
    if (!recentLoaded || recentScope === null) return;
    const found = new Set<string>(recentItems.map((item) => item.id));
    forgetLinkRecents(
      recentScope,
      recentIds.filter((id) => !found.has(id)),
    );
  }, [recentLoaded, recentItems, recentIds, recentScope]);

  const trimmed = debounced.trim();
  const sections = useMemo<PickerSection[]>(() => {
    if (showRecent && recentItems.length > 0) {
      return [
        { key: 'recent', heading: t('picker.recent'), items: recentItems },
        {
          key: 'main',
          heading: t('picker.everything', { table: tableName }),
          items: main.items,
        },
      ];
    }
    let heading: string | null = null;
    if (scope === 'selected') heading = t('picker.selectedOnly');
    else if (trimmed !== '' && main.status === 'success') {
      heading = main.hasMore
        ? t('picker.resultsMore', { search: trimmed })
        : t('picker.results', { count: main.items.length, search: trimmed });
    }
    return [{ key: 'main', heading, items: main.items }];
  }, [
    showRecent,
    recentItems,
    main.items,
    main.status,
    main.hasMore,
    scope,
    trimmed,
    t,
    tableName,
  ]);

  const reasonOf = useCallback(
    (candidate: Candidate): string | undefined => {
      if (model.isSelected(selection, candidate.id)) return undefined;
      if (!candidate.selectable) return t('picker.notSelectable');
      if (candidate.full) return t('picker.full');
      return undefined;
    },
    [selection, t],
  );
  const displayFields = main.displayFields.length > 0 ? main.displayFields : recent.displayFields;
  const optionList = useMemo<PickerOption[]>(
    () =>
      sections.flatMap((section) =>
        section.items.map((candidate) => ({
          id: `${listId}-${section.key}-${candidate.id}`,
          section: section.key,
          candidate,
          values: displayValues(candidate, displayFields, fieldList, props.locale),
          disabledReason: reasonOf(candidate),
        })),
      ),
    [sections, listId, displayFields, fieldList, props.locale, reasonOf],
  );

  // No record is active until the user asks for one (T421a: Enter never
  // writes a record nobody chose): ↑/↓ or the pointer make one active, and a
  // search makes its first result active (typing it is the choice).
  const [active, setActive] = useState(() => (trimmed === '' ? -1 : 0));
  const listKey = `${scope}|${trimmed}`;
  const previousKey = useRef(listKey);
  useEffect(() => {
    if (previousKey.current === listKey) return;
    previousKey.current = listKey;
    setActive(trimmed === '' ? -1 : 0);
  }, [listKey, trimmed]);
  // While the search is still debouncing, the list shown is the previous one: nothing to choose.
  const settled = search.trim() === trimmed;
  const activeOption =
    active < 0 || !settled ? undefined : optionList[Math.min(active, optionList.length - 1)];

  // The pending announcement does not outlive the picker (no state update after unmount).
  const announceTimer = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      window.clearTimeout(announceTimer.current);
    },
    [],
  );
  const announce = (text: string) => {
    // A changed text is read again even when it repeats (the region is emptied first).
    setAnnouncement('');
    window.clearTimeout(announceTimer.current);
    announceTimer.current = window.setTimeout(() => {
      setAnnouncement(text);
    }, 30);
  };

  const finish = (refs: readonly LinkRef[]) => {
    if (recentScope !== null) {
      rememberLinkRecents(recentScope, model.added({ refs, limit }, props.value));
    }
    if (model.changed({ refs, limit }, props.value)) props.onCommit(refs);
    props.onClose();
  };

  /** Clicking or pressing Enter/Space on a record. */
  const choose = (option: PickerOption) => {
    const ref = refOf(option.candidate);
    const selected = model.isSelected(selection, ref.id);
    if (option.disabledReason !== undefined && !selected) return;
    if (!multiple) {
      finish([ref]);
      return;
    }
    const change = model.toggle(selection, ref);
    if (change.blocked) {
      setBlocked(true);
      announce(t('picker.limitBlocked', { limit }));
      return;
    }
    setBlocked(false);
    setSelection(change.selection);
    const title = ref.title ?? t('picker.noAccess');
    announce(t(selected ? 'picker.announceRemoved' : 'picker.announceAdded', { title }));
  };

  // "Select all" only for a complete result of the current search (decision #1).
  const main0 = sections.find((section) => section.key === 'main');
  const selectable = (main0?.items ?? []).filter((item) => item.selectable && !item.full);
  const canSelectAll =
    multiple && scope === 'all' && trimmed !== '' && !main.hasMore && selectable.length > 1;
  const allChosen = model.allSelected(selection, selectable.map(refOf));
  const toggleAll = () => {
    const refs = selectable.map(refOf);
    if (allChosen) {
      setSelection(model.removeAll(selection, refs));
      setBlocked(false);
      return;
    }
    const change = model.selectAll(selection, refs);
    if (change.blocked) {
      setBlocked(true);
      announce(t('picker.limitBlocked', { limit }));
      return;
    }
    setBlocked(false);
    setSelection(change.selection);
  };

  const setScope = (next: PickerScope) => {
    if (next === 'selected') setScopeIds(selection.refs.map((ref) => ref.id).slice(0, 500));
    setScopeState(next);
  };

  // Creating a record of the linked table (needs `add` there, T413).
  const canCreate = canAddRecord(props.access, linkTable);
  const form = useMemo(
    () =>
      createFormFields(fieldList ?? [], (id) =>
        canEditField(props.access, linkTable, id, 'create'),
      ),
    [fieldList, props.access, linkTable],
  );
  const [createError, setCreateError] = useState<string | null>(null);
  const created = (ref: LinkRef) => {
    setCreating(null);
    setCreateError(null);
    void queryClient.invalidateQueries({ queryKey: keys.linkCandidates(linkTable, fieldId) });
    if (!multiple) {
      finish([ref]);
      return;
    }
    const change = model.toggle(selection, ref);
    if (change.blocked) {
      setBlocked(true);
      announce(t('picker.limitBlocked', { limit }));
      return;
    }
    setSelection(change.selection);
    announce(t('create.created', { title: ref.title ?? '' }));
  };
  const create = () => {
    const name = search.trim();
    if (fieldList === undefined) return;
    if (
      form.unsupported.length > 0 ||
      needsForm(form.inputs) ||
      name === '' ||
      primary === undefined
    ) {
      setCreating({ name });
      return;
    }
    setCreateError(null);
    createLinkedRecord(linkTable, { [primary.id]: name }, primary, props.locale).then(
      created,
      (error: unknown) => {
        const translated = translateError(error, i18n);
        setCreateError(
          [translated.message, ...translated.details.map((detail) => detail.message)].join(' '),
        );
      },
    );
  };

  const errorText = main.error === null ? '' : translateError(main.error, i18n).message;

  return {
    t,
    listId,
    multiple,
    limit,
    linkTable,
    tableName,
    primary,
    hasFilter: props.options.record_filter !== null,
    selection,
    setSelection,
    search,
    setSearch,
    searching: trimmed,
    scope,
    setScope,
    main,
    recent,
    sections,
    options: optionList,
    active: activeOption === undefined ? -1 : optionList.indexOf(activeOption),
    setActive,
    activeOption,
    choose,
    blocked,
    canSelectAll,
    allChosen,
    selectableCount: selectable.length,
    toggleAll,
    announcement,
    finish,
    canCreate: canCreate && fieldList !== undefined,
    creating,
    setCreating,
    create,
    created,
    createError,
    form,
    errorText,
    fieldsLoaded: fieldList !== undefined,
  };
}

export type PickerState = ReturnType<typeof usePicker>;
