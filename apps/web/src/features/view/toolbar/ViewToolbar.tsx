import { MAX_RECORD_GROUP_LEVELS, MAX_RECORD_SORT_KEYS } from '@cellhive/contracts';
import { Button, cn, Tooltip } from '@cellhive/ui';
import {
  ArrowUpDown,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleAlert,
  ListFilter,
  Rows3,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../lib/api/client';
import { stableQueryHash } from '../../../lib/query/keys';
import { countConditions } from '../../../lib/views/query';
import { TOOLBAR_LABEL } from '../../../lib/views/toolbar';
import { ToolbarPopover } from '../../../lib/views/ToolbarPopover';
import { ColorRulesButton } from '../color-rules/ColorRulesButton';

import { AskAiButton } from './AskAiButton';
import {
  checkFilter,
  filterableFields,
  fromFilter,
  issuesByItem,
  toFilter,
  type GroupItem,
} from './filter-model';
import { FilterBuilder } from './FilterBuilder';
import { SortPanel, sortableFields, type OrderKind, type SortKey } from './SortPanel';
import { TreeButton, TreeGroupNotice, isTreeShown } from './TreeButton';
import { ViewSearch } from './ViewSearch';

import type { ViewToolbarProps } from '../../../lib/views/toolbar';

/** A filter being edited is applied this long after the last change (typing a value). */
export const FILTER_APPLY_DELAY_MS = 400;

/** `422 INVALID_FILTER` of the record query: its detail items (paths under `filter`). */
function filterErrorsOf(error: unknown): { path: string; code: string }[] {
  if (!isApiError(error) || error.code !== 'INVALID_FILTER') return [];
  return error.errors.map((item) => ({ path: item.path, code: item.code }));
}

function FilterButton({ fields, state, orgId, queryError }: ViewToolbarProps) {
  const { t } = useTranslation('toolbar');
  const [open, setOpen] = useState(false);
  const filterable = useMemo(() => filterableFields(fields), [fields]);
  const applied = state.config.filter;
  const appliedHash = stableQueryHash(applied);

  // The tree edited here stands for `treeHash`: the filter it last applied
  // (or was built from). A new effective filter that is not ours (discard,
  // save, another tab, undo of a draft) rebuilds it.
  const [root, setRoot] = useState<GroupItem>(() => fromFilter(applied));
  const [treeHash, setTreeHash] = useState(appliedHash);
  const [seenHash, setSeenHash] = useState(appliedHash);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  if (seenHash !== appliedHash) {
    setSeenHash(appliedHash);
    if (appliedHash !== treeHash) {
      setRoot(fromFilter(applied));
      setTreeHash(appliedHash);
    }
  }
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const checked = useMemo(() => checkFilter(root, filterable), [root, filterable]);
  const serverErrors = filterErrorsOf(queryError);
  // Server paths name the filter that was sent: the one this tree applied.
  const serverIssues = useMemo(
    () =>
      serverErrors.length === 0 || treeHash !== appliedHash
        ? new Map<string, string[]>()
        : issuesByItem(serverErrors, toFilter(root, filterable).paths),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryError, treeHash, appliedHash, root, filterable],
  );
  const issues = useMemo(() => {
    const merged = new Map<string, string[]>(checked.issues);
    for (const [id, codes] of serverIssues) merged.set(id, [...(merged.get(id) ?? []), ...codes]);
    return merged;
  }, [checked.issues, serverIssues]);

  const { change } = state;
  const edit = (next: GroupItem) => {
    setRoot(next);
    const result = checkFilter(next, filterable);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    // Invalid trees are shown with their issues, never sent.
    if (result.issues.size > 0) return;
    const hash = stableQueryHash(result.filter);
    setTreeHash(hash);
    if (hash === appliedHash) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      // Temporary until "Save" (Lark-style, T311), also for those who may save the view.
      change({ filter: result.filter as Record<string, unknown> | null }, { temporary: true });
    }, FILTER_APPLY_DELAY_MS);
  };

  const count = countConditions(applied);
  const failing = serverErrors.length > 0;
  // "Filter: 2 conditions" (design): the button says what applies, its name too.
  const label = failing
    ? t('filter.buttonInvalid', { count })
    : count > 0
      ? t('filter.buttonCount', { count })
      : t('filter.button');
  return (
    <ToolbarPopover
      open={open}
      onOpenChange={setOpen}
      label={t('filter.title')}
      trigger={(props) => (
        // The label is hidden below 1280 px: then the tooltip says it.
        <Tooltip content={label} className="xl:hidden">
          <Button
            {...props}
            variant="ghost"
            size="toolbar"
            aria-label={label}
            className={cn(
              'shrink-0',
              (count > 0 || failing) && 'bg-accent-soft text-accent hover:bg-accent-soft',
              failing && 'text-danger',
            )}
            data-testid="filter-button"
          >
            {failing ? <CircleAlert aria-hidden="true" /> : <ListFilter aria-hidden="true" />}
            <span aria-hidden="true" className={TOOLBAR_LABEL}>
              {label}
            </span>
          </Button>
        </Tooltip>
      )}
    >
      <h2 className="text-heading">{t('filter.title')}</h2>
      {filterable.length === 0 ? (
        <p className="text-body text-fg-muted">{t('filter.noFields')}</p>
      ) : (
        <FilterBuilder
          root={root}
          onChange={edit}
          fields={filterable}
          issues={issues}
          incomplete={checked.incomplete}
          orgId={orgId}
        />
      )}
      <p className="text-label text-fg-muted">{t('filter.temporaryHint')}</p>
    </ToolbarPopover>
  );
}

/**
 * Sort keys (T311) or group levels (T312) of the view: the same ordered
 * list of fields and directions, temporary until saved. Group: at most 3
 * levels, fields the user reads.
 */
function OrderButton({
  fields,
  state,
  kind,
  groupActions,
}: ViewToolbarProps & { kind: OrderKind }) {
  const { t } = useTranslation('toolbar');
  const [open, setOpen] = useState(false);
  const sortable = useMemo(() => sortableFields(fields), [fields]);
  const known = useMemo(() => new Set(sortable.map((field) => field.id as string)), [sortable]);
  const sort = state.config[kind].filter((item) => known.has(item.field));
  const count = sort.length;
  const { change } = state;
  const Icon = kind === 'sort' ? ArrowUpDown : Rows3;
  // A tree is never grouped (T417): the group panel says so instead.
  const treeShown = kind === 'group' && isTreeShown(state.config, fields);
  // "Sort: Due date" (design): the first field, "+N" for the others.
  const first = sort[0];
  const firstName =
    first === undefined ? '' : (sortable.find((field) => field.id === first.field)?.name ?? '');
  const label =
    count === 0
      ? t(`${kind}.button`)
      : count === 1
        ? t(`${kind}.summary`, { name: firstName })
        : t(`${kind}.summaryMore`, { name: firstName, more: count - 1 });
  return (
    <ToolbarPopover
      open={open}
      onOpenChange={setOpen}
      label={t(`${kind}.title`)}
      trigger={(props) => (
        // The label is hidden below 1280 px: then the tooltip says it.
        <Tooltip content={label} className="xl:hidden">
          <Button
            {...props}
            variant="ghost"
            size="toolbar"
            aria-label={label}
            className={cn(
              'shrink-0',
              count > 0 && 'bg-accent-soft text-accent hover:bg-accent-soft',
              treeShown && 'text-fg-subtle',
            )}
            data-testid={`${kind}-button`}
          >
            <Icon aria-hidden="true" />
            <span aria-hidden="true" className={TOOLBAR_LABEL}>
              {label}
            </span>
          </Button>
        </Tooltip>
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-heading">{t(`${kind}.title`)}</h2>
        {kind === 'group' && groupActions !== undefined && count > 0 ? (
          <div role="group" aria-label={t('group.groupsLabel')} className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={groupActions.collapseAll}>
              <ChevronsDownUp aria-hidden="true" />
              {t('group.collapseAll')}
            </Button>
            <Button variant="ghost" size="sm" onClick={groupActions.expandAll}>
              <ChevronsUpDown aria-hidden="true" />
              {t('group.expandAll')}
            </Button>
          </div>
        ) : null}
      </div>
      {treeShown ? (
        <TreeGroupNotice state={state} />
      ) : (
        <SortPanel
          kind={kind}
          max={kind === 'sort' ? MAX_RECORD_SORT_KEYS : MAX_RECORD_GROUP_LEVELS}
          sort={sort}
          fields={sortable}
          onChange={(next: SortKey[]) => {
            change({ [kind]: next }, { temporary: true });
          }}
        />
      )}
      <p className="text-label text-fg-muted">{t('filter.temporaryHint')}</p>
    </ToolbarPopover>
  );
}

/**
 * Filter, group (T312) and sort of a view (T311): changes are temporary —
 * seen only by this user until saved (the view bar's "Unsaved changes",
 * Ctrl/⌘+S) — like in Lark, also for those who may save the view.
 */
export function ViewToolbar(props: ViewToolbarProps) {
  return (
    <>
      <FilterButton {...props} />
      <OrderButton {...props} kind="sort" />
      <OrderButton {...props} kind="group" />
      {props.treeActions === undefined ? null : <TreeButton {...props} />}
      {/* (T816) Color rules of a grid view (member app only). */}
      {props.colorRules === true && props.view.type === 'grid' ? (
        <ColorRulesButton {...props} />
      ) : null}
    </>
  );
}

export { AskAiButton, ViewSearch };
export default ViewToolbar;
