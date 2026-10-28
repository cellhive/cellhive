import { Button, cn, Select, Tooltip } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { CircleAlert, FolderPlus, Plus, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';

import { fieldsQuery } from '../../../lib/query/queries';
import { isFieldConverting } from '../../../lib/schema/conversion';

import {
  appendTo,
  checkFilter,
  filterableFields,
  fromFilter,
  focusAfterRemoval,
  canAddCondition,
  canNestGroup,
  newCondition,
  newItemId,
  operatorsFor,
  updateItem,
  valueShapeOf,
  withOperator,
  type BuilderItem,
  type ConditionItem,
  type FilterModelOptions,
  type GroupItem,
} from './filter-model';
import { ValueEditor } from './ValueEditor';

import type { ConditionValueSourceProps } from '../../../lib/automation/condition-editor';
import type { RuleFilterEditorProps } from '../../../lib/permissions/rule-filter-editor';
import type { FieldDto } from '@cellhive/contracts';

export interface FilterBuilderProps {
  readonly root: GroupItem;
  readonly onChange: (root: GroupItem) => void;
  /** Fields the user reads that can be filtered on. */
  readonly fields: readonly FieldDto[];
  /** Issue codes by item id (client validation or `422 INVALID_FILTER`). */
  readonly issues: ReadonlyMap<string, readonly string[]>;
  /** Conditions not applied yet (a value is missing). */
  readonly incomplete: ReadonlySet<string>;
  readonly orgId: string;
  /** Text when there is no condition (default: the view's, "every record of the view shows"). */
  readonly emptyText?: string | undefined;
  /** (T521) Automation conditions: `changed*` operators (see `FilterModelOptions`). */
  readonly modelOptions?: FilterModelOptions | undefined;
  /** (T521) Deepest group level offered (default: the DSL's 5); 1 = no nested group. */
  readonly maxDepth?: number | undefined;
  /** (T521) Name of the root group (default: the view's "Records where"). */
  readonly rootLabel?: string | undefined;
  /** (T521b) Values from the automation in conditions (`update_records`). */
  readonly ValueSource?: ComponentType<ConditionValueSourceProps> | undefined;
  /**
   * (T527) A narrow column (the 440 px panel of the automation builder):
   * field and operator share the first line, the value gets the second one,
   * whatever the screen width — the wide grid needs ~560 px.
   */
  readonly compact?: boolean | undefined;
}

const AND: GroupItem['op'] = 'and';
const OR: GroupItem['op'] = 'or';

interface Context extends FilterBuilderProps {
  readonly byId: ReadonlyMap<string, FieldDto>;
  readonly change: (id: string, next: (item: BuilderItem) => BuilderItem | null) => void;
  /** Removes an item; the focus goes to its neighbour (or the group's "Add condition"). */
  readonly remove: (id: string) => void;
}

function IssueText({ id, codes }: { id: string; codes: readonly string[] }) {
  const { t } = useTranslation(['toolbar', 'errors']);
  return (
    <p id={id} className="flex items-center gap-1 text-label text-danger">
      <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
      {[...new Set(codes)]
        .map((code) => t([`toolbar:filter.issues.${code}`, `errors:detail.${code}`]))
        .join(' ')}
    </p>
  );
}

function ConditionRow({ item, context }: { item: ConditionItem; context: Context }) {
  const { t } = useTranslation('toolbar');
  const issueId = useId();
  const field = context.byId.get(item.field);
  const codes = context.issues.get(item.id) ?? [];
  const invalid = codes.length > 0;
  const name = field?.name ?? t('filter.unknownField');
  const compact = context.compact === true;
  return (
    <li
      className={cn(
        // A new condition drops in (motion pass).
        'flex animate-reveal flex-col gap-1 rounded-md px-1 py-1',
        invalid && 'bg-danger/5 ring-1 ring-danger',
      )}
      data-testid="filter-condition"
      data-filter-item={item.id}
      aria-invalid={invalid || undefined}
    >
      {/* Field, operator, value (wrapping inside its column), and × always ending the row. */}
      <div
        className={
          compact
            ? 'grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem] items-start gap-1'
            : 'flex flex-wrap items-start gap-1 sm:grid sm:grid-cols-[10rem_10rem_minmax(12rem,1fr)_2rem]'
        }
      >
        <Select
          className={compact ? 'w-full' : 'w-44 sm:w-full'}
          aria-label={t('filter.field')}
          aria-describedby={invalid ? issueId : undefined}
          aria-invalid={invalid || undefined}
          value={field === undefined ? '' : field.id}
          onChange={(event) => {
            const next = context.byId.get(event.currentTarget.value);
            if (next === undefined) return;
            context.change(item.id, () => ({ ...newCondition(next), id: item.id }));
          }}
        >
          {field === undefined ? <option value="">{name}</option> : null}
          {context.fields.map((candidate) => {
            // A field being converted (T414, decision #8): no new condition on it meanwhile.
            const locked = isFieldConverting(candidate) && candidate.id !== field?.id;
            return (
              <option key={candidate.id} value={candidate.id} disabled={locked}>
                {locked ? t('converting', { name: candidate.name }) : candidate.name}
              </option>
            );
          })}
        </Select>
        {field === undefined ? null : (
          <Select
            className={compact ? 'w-full' : 'w-44 sm:w-full'}
            aria-label={t('filter.operator', { field: name })}
            value={item.operator}
            onChange={(event) => {
              const operator = event.currentTarget.value as ConditionItem['operator'];
              context.change(item.id, (current) =>
                current.kind === 'condition' ? withOperator(current, field, operator) : current,
              );
            }}
          >
            {operatorsFor(field, context.modelOptions).map((operator) => (
              <option key={operator} value={operator}>
                {t(`filter.operators.${operator}`)}
              </option>
            ))}
          </Select>
        )}
        {field === undefined ? null : (
          <div
            className={cn(
              'flex min-w-0 flex-wrap items-center gap-1',
              compact && 'col-span-2 row-start-2 [&_input]:max-w-full [&_select]:max-w-full',
            )}
          >
            {context.modelOptions?.isSourceValue?.(item.value) === true ? null : (
              <ValueEditor
                key={item.operator}
                field={field}
                operator={item.operator}
                value={item.value}
                orgId={context.orgId}
                label={t('filter.value', { field: name })}
                invalid={invalid}
                onChange={(value) => {
                  context.change(item.id, (current) =>
                    current.kind === 'condition'
                      ? {
                          kind: 'condition',
                          id: current.id,
                          field: current.field,
                          operator: current.operator,
                          ...(value === undefined ? {} : { value }),
                        }
                      : current,
                  );
                }}
              />
            )}
            {/* (T521b) A value from the automation (update_records). */}
            {context.ValueSource === undefined ||
            valueShapeOf(field, item.operator).shape === 'none' ? null : (
              <context.ValueSource
                field={field}
                value={item.value}
                label={t('filter.value', { field: name })}
                onChange={(value) => {
                  context.change(item.id, (current) =>
                    current.kind === 'condition'
                      ? {
                          kind: 'condition',
                          id: current.id,
                          field: current.field,
                          operator: current.operator,
                          ...(value === undefined ? {} : { value }),
                        }
                      : current,
                  );
                }}
              />
            )}
          </div>
        )}
        <Tooltip content={t('filter.removeCondition', { field: name })}>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'size-8 shrink-0',
              compact ? 'col-start-3 row-start-1' : 'sm:col-start-4 sm:row-start-1',
            )}
            aria-label={t('filter.removeCondition', { field: name })}
            onClick={() => {
              context.remove(item.id);
            }}
          >
            <X aria-hidden="true" />
          </Button>
        </Tooltip>
      </div>
      {invalid ? <IssueText id={issueId} codes={codes} /> : null}
      {!invalid && context.incomplete.has(item.id) ? (
        <p className="text-label text-fg-muted">{t('filter.incomplete')}</p>
      ) : null}
    </li>
  );
}

function RawRow({ id, context }: { id: string; context: Context }) {
  const { t } = useTranslation('toolbar');
  const codes = context.issues.get(id) ?? [];
  const issueId = useId();
  return (
    <li className="flex flex-col gap-1 px-1 py-1" data-filter-item={id}>
      <div className="flex items-center gap-2">
        <span
          className="text-body text-fg-muted"
          aria-describedby={codes.length > 0 ? issueId : undefined}
        >
          {t('filter.advanced')}
        </span>
        <Tooltip content={t('filter.removeAdvanced')}>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={t('filter.removeAdvanced')}
            onClick={() => {
              context.remove(id);
            }}
          >
            <X aria-hidden="true" />
          </Button>
        </Tooltip>
      </div>
      {codes.length > 0 ? <IssueText id={issueId} codes={codes} /> : null}
    </li>
  );
}

function GroupBox({
  group,
  depth,
  context,
}: {
  group: GroupItem;
  depth: number;
  context: Context;
}) {
  const { t } = useTranslation('toolbar');
  const labelId = useId();
  const root = depth === 1;
  const first = context.fields[0];
  const canAdd = canAddCondition(context.root) && first !== undefined;
  const codes = context.issues.get(group.id) ?? [];
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className={cn('flex flex-col gap-1', !root && 'rounded-md border border-line p-2')}
      data-testid={root ? 'filter-root' : 'filter-group'}
      data-filter-item={group.id}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span id={labelId} className="text-label text-fg-muted">
          {root ? (context.rootLabel ?? t('filter.rootLabel')) : t('filter.groupLabel')}
        </span>
        <Select
          className="w-56"
          aria-label={root ? t('filter.rootMatch') : t('filter.groupMatch')}
          value={group.op}
          onChange={(event) => {
            const op: GroupItem['op'] = event.currentTarget.value === 'or' ? OR : AND;
            context.change(group.id, (item) => (item.kind === 'group' ? { ...item, op } : item));
          }}
        >
          <option value="and">{t('filter.matchAll')}</option>
          <option value="or">{t('filter.matchAny')}</option>
        </Select>
        {root ? null : (
          <Tooltip content={t('filter.removeGroup')}>
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto size-8"
              aria-label={t('filter.removeGroup')}
              onClick={() => {
                context.remove(group.id);
              }}
            >
              <X aria-hidden="true" />
            </Button>
          </Tooltip>
        )}
      </div>
      {root && group.items.length === 0 ? (
        <p className="text-body text-fg-muted">{context.emptyText ?? t('filter.empty')}</p>
      ) : null}
      {group.items.length === 0 ? null : (
        <ul className="flex flex-col gap-1">
          {group.items.map((item) => {
            if (item.kind === 'condition') {
              return <ConditionRow key={item.id} item={item} context={context} />;
            }
            if (item.kind === 'raw') return <RawRow key={item.id} id={item.id} context={context} />;
            return (
              <li key={item.id}>
                <GroupBox group={item} depth={depth + 1} context={context} />
              </li>
            );
          })}
        </ul>
      )}
      {codes.length > 0 ? <IssueText id={`${labelId}-issues`} codes={codes} /> : null}
      <div className="flex flex-wrap gap-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={!canAdd}
          data-filter-add={group.id}
          onClick={() => {
            if (first === undefined) return;
            context.onChange(appendTo(context.root, group.id, newCondition(first)));
          }}
        >
          <Plus aria-hidden="true" />
          {t('filter.addCondition')}
        </Button>
        {canNestGroup(depth) && depth < (context.maxDepth ?? Number.POSITIVE_INFINITY) ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={!canAdd}
            onClick={() => {
              if (first === undefined) return;
              const nested: GroupItem = {
                kind: 'group',
                id: newItemId(),
                op: 'and',
                items: [newCondition(first)],
              };
              context.onChange(appendTo(context.root, group.id, nested));
            }}
          >
            <FolderPlus aria-hidden="true" />
            {t('filter.addGroup')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The filter builder (T311, SPEC §6): nested `and`/`or` groups within the
 * limits of `@cellhive/filter-dsl` (5 levels, 50 conditions), operators by
 * field type, value editors by type. Only fields the user reads are listed.
 * Every control is native, so it is used entirely with the keyboard.
 */
export function FilterBuilder(props: FilterBuilderProps) {
  const byId = new Map(props.fields.map((field) => [field.id as string, field]));
  const container = useRef<HTMLDivElement>(null);
  // Where the focus goes once a removed item has left the DOM (FRONTEND §9.2): kept
  // inside the popover, so that Escape still closes it.
  const pendingFocus = useRef<ReturnType<typeof focusAfterRemoval>>(null);
  useEffect(() => {
    const target = pendingFocus.current;
    const scope = container.current;
    if (target === null || scope === null) return;
    pendingFocus.current = null;
    const element =
      target.kind === 'item'
        ? scope.querySelector<HTMLElement>(
            `[data-filter-item="${CSS.escape(target.id)}"] :is(select, input, button):not(:disabled)`,
          )
        : scope.querySelector<HTMLElement>(`[data-filter-add="${CSS.escape(target.id)}"]`);
    (element ?? scope.querySelector<HTMLElement>('select, button:not(:disabled)'))?.focus();
  }, [props.root]);
  const context: Context = {
    ...props,
    byId,
    change: (id, next) => {
      if (id !== props.root.id) {
        props.onChange(updateItem(props.root, id, next));
        return;
      }
      const root = next(props.root);
      if (root?.kind === 'group') props.onChange(root);
    },
    remove: (id) => {
      pendingFocus.current = focusAfterRemoval(props.root, id);
      props.onChange(updateItem(props.root, id, () => null));
    },
  };
  return (
    <div ref={container} className="contents">
      <GroupBox group={props.root} depth={1} context={context} />
    </div>
  );
}

/**
 * (T713) Conditions of a role's record rule (`edit_filter` / `read_filter`,
 * SPEC §14.1, CONTRACTS §14): this builder over every field of the table
 * (the base admin editing the role reads them all). User fields offer the
 * "current user" / "current user's groups" variables (`$var`, evaluated for
 * the member the role applies to); link fields pick linked records by id
 * (T710 — no variable, no title operator). Every change reaches the role
 * editor with whether it is complete and valid; the server checks again.
 * Given to the role editor by its route (FRONTEND §1.2).
 */
export function RuleFilterEditor({
  tableId,
  orgId,
  value,
  onChange,
  label,
  emptyText,
}: RuleFilterEditorProps) {
  const { t } = useTranslation('toolbar');
  const fields = useQuery(fieldsQuery(tableId));
  const filterable = useMemo(() => filterableFields(fields.data?.items ?? []), [fields.data]);
  const [root, setRoot] = useState(() => fromFilter(value));
  const checked = useMemo(() => checkFilter(root, filterable), [root, filterable]);
  if (fields.isPending) return null;
  if (filterable.length === 0) {
    return <p className="text-body text-fg-muted">{t('filter.noFields')}</p>;
  }
  return (
    <div
      className="flex min-w-0 flex-col gap-2 overflow-x-auto rounded-md border border-line p-3"
      data-testid="rule-filter"
      onKeyDown={(event) => {
        // Enter in a value box must not submit anything around it.
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
          event.preventDefault();
        }
      }}
    >
      <FilterBuilder
        root={root}
        fields={filterable}
        issues={checked.issues}
        incomplete={checked.incomplete}
        orgId={orgId}
        emptyText={emptyText}
        rootLabel={label}
        onChange={(next) => {
          setRoot(next);
          const result = checkFilter(next, filterable);
          onChange({
            filter: result.filter as Readonly<Record<string, unknown>> | null,
            valid: result.issues.size === 0,
            incomplete: result.incomplete.size,
          });
        }}
      />
    </div>
  );
}
