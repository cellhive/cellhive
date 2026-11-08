/*! Lucian UX/UI Prompt #132 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#132 */
import '../../../../../styles/lucian.css';
import './ConditionBranchBuilder.css';

import { Button, Select, Tooltip } from '@cellhive/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CircleAlert, FolderPlus, Plus, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../../../lib/api';
import { isAutomationValue } from '../../../../../lib/automation/condition-editor';
import { fieldsQuery } from '../../../../../lib/query/queries';
import { isFieldConverting } from '../../../../../lib/schema/conversion';
import { countableFilter } from '../../model/match-count';

import type {
  AutomationConditionEditorProps,
  ConditionEditorState,
  ConditionValueSourceProps,
} from '../../../../../lib/automation/condition-editor';
import type {
  ConditionKit,
  ConditionModel,
  KitCondition,
  KitGroup,
  KitItem,
  KitModelOptions,
  KitValueEditorProps,
} from '../../../../../lib/automation/condition-kit';
import type { FieldDto } from '@cellhive/contracts';
import type { FilterNode } from '@cellhive/filter-dsl';

/**
 * Lucian UX/UI #132 "Condition branch builder" (element c010ef189c, catalog
 * 34c4b3e61d) for the conditions of an automation (FRONTEND §13.2, §9.3
 * "Lucian UX/UI"; BACKLOG S9 decision #8): every condition editor of the
 * builder — "Run only if", `record.matches`, the button's condition, `if`,
 * `find_records`, `update_records`, the `delay` recheck. A bar with its
 * accent on the left holds the rules (field, operator, value), the "All" /
 * "Any" pill sits between the first two, nested groups are bars inside the
 * bar, and under it "N records match now" — the records the person editing
 * reads that match the condition apart from its `changed*` part — slides
 * 5 px when it changes. The pattern's script (toggle the mode, recount,
 * nudge the number) runs here as React state and one effect.
 *
 * Built on the view filter builder's model (`filter-model.ts`, its value
 * editors), handed over by the route (`ConditionKit`, FRONTEND §1.2); the
 * view's own filter builder is not changed.
 */

/** "N records match now" waits this long after the last change (the pattern recounts at once). */
export const COUNT_DEBOUNCE_MS = 400;
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

export interface ConditionBranchBuilderProps extends AutomationConditionEditorProps {
  readonly kit: ConditionKit;
}

interface Context {
  readonly model: ConditionModel;
  readonly ValueEditor: ComponentType<KitValueEditorProps>;
  readonly ValueSource: ComponentType<ConditionValueSourceProps> | undefined;
  readonly root: KitGroup;
  readonly fields: readonly FieldDto[];
  readonly byId: ReadonlyMap<string, FieldDto>;
  readonly issues: ReadonlyMap<string, readonly string[]>;
  readonly incomplete: ReadonlySet<string>;
  readonly options: KitModelOptions;
  readonly orgId: string;
  readonly rootLabel: string;
  readonly emptyText: string;
  readonly maxDepth: number;
  readonly onChange: (root: KitGroup) => void;
  readonly change: (id: string, next: (item: KitItem) => KitItem | null) => void;
  readonly remove: (id: string) => void;
}

function stateOf(
  model: ConditionModel,
  root: KitGroup,
  fields: readonly FieldDto[],
  options: KitModelOptions,
): ConditionEditorState {
  const checked = model.checkFilter(root, fields, options);
  return {
    filter: checked.filter as ConditionEditorState['filter'],
    valid: checked.issues.size === 0,
    incomplete: checked.incomplete.size,
  };
}

function matches(query: string): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

/**
 * The pattern's `motion()`: the number comes down 5 px and settles in
 * 220 ms (its own values; the curve is `--ux-ease`, Cellhive's ease-out).
 * Not with reduced motion. `element.animate` is allowed by the CSP.
 */
export function slideCount(node: HTMLElement | null): void {
  if (node === null || typeof node.animate !== 'function' || matches(REDUCED_MOTION)) return;
  const easing =
    window.getComputedStyle(node).getPropertyValue('--ux-ease').trim() ||
    'cubic-bezier(.2,.8,.2,1)';
  node.animate([{ transform: 'translateY(5px)' }, { transform: 'none' }], {
    duration: 220,
    easing,
  });
}

function IssueText({ id, codes }: { id: string; codes: readonly string[] }) {
  const { t } = useTranslation(['toolbar', 'errors']);
  return (
    <p id={id} className="issue">
      <CircleAlert aria-hidden="true" />
      {[...new Set(codes)]
        .map((code) => t([`toolbar:filter.issues.${code}`, `errors:detail.${code}`]))
        .join(' ')}
    </p>
  );
}

function withValue(current: KitItem, value: unknown): KitItem {
  return current.kind === 'condition'
    ? {
        kind: 'condition',
        id: current.id,
        field: current.field,
        operator: current.operator,
        ...(value === undefined ? {} : { value }),
      }
    : current;
}

/** A rule: field, operator, ×, then the value (the pattern's `.rule`). */
function Rule({ item, context }: { item: KitCondition; context: Context }) {
  const { t } = useTranslation('toolbar');
  const issueId = useId();
  const { model, ValueEditor, ValueSource } = context;
  const field = context.byId.get(item.field);
  const codes = context.issues.get(item.id) ?? [];
  const invalid = codes.length > 0;
  const name = field?.name ?? t('filter.unknownField');
  return (
    <div
      className="rule animate-reveal"
      data-testid="filter-condition"
      data-filter-item={item.id}
      aria-invalid={invalid || undefined}
    >
      <div className="rule-line">
        <Select
          className="w-full"
          aria-label={t('filter.field')}
          aria-describedby={invalid ? issueId : undefined}
          aria-invalid={invalid || undefined}
          value={field === undefined ? '' : field.id}
          onChange={(event) => {
            const next = context.byId.get(event.currentTarget.value);
            if (next === undefined) return;
            context.change(item.id, () => ({ ...model.newCondition(next), id: item.id }));
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
        {field === undefined ? (
          <span />
        ) : (
          <Select
            className="w-full"
            aria-label={t('filter.operator', { field: name })}
            value={item.operator}
            onChange={(event) => {
              const operator = event.currentTarget.value as KitCondition['operator'];
              context.change(item.id, (current) =>
                current.kind === 'condition'
                  ? model.withOperator(current, field, operator)
                  : current,
              );
            }}
          >
            {model.operatorsFor(field, context.options).map((operator) => (
              <option key={operator} value={operator}>
                {t(`filter.operators.${operator}`)}
              </option>
            ))}
          </Select>
        )}
        {field === undefined ? null : (
          <div className="rule-value">
            {context.options.isSourceValue?.(item.value) === true ? null : (
              <ValueEditor
                key={item.operator}
                field={field}
                operator={item.operator}
                value={item.value}
                orgId={context.orgId}
                label={t('filter.value', { field: name })}
                invalid={invalid}
                onChange={(value) => {
                  context.change(item.id, (current) => withValue(current, value));
                }}
              />
            )}
            {/* (T521b) A value from the automation (update_records). */}
            {ValueSource === undefined ||
            model.valueShapeOf(field, item.operator).shape === 'none' ? null : (
              <ValueSource
                field={field}
                value={item.value}
                label={t('filter.value', { field: name })}
                onChange={(value) => {
                  context.change(item.id, (current) => withValue(current, value));
                }}
              />
            )}
          </div>
        )}
        <Tooltip content={t('filter.removeCondition', { field: name })}>
          <Button
            variant="ghost"
            size="icon"
            className="remove size-8 shrink-0"
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
        <p className="pending">{t('filter.incomplete')}</p>
      ) : null}
    </div>
  );
}

function RawRule({ id, context }: { id: string; context: Context }) {
  const { t } = useTranslation('toolbar');
  const codes = context.issues.get(id) ?? [];
  const issueId = useId();
  return (
    <div className="rule" data-filter-item={id} aria-invalid={codes.length > 0 || undefined}>
      <div className="raw">
        <span aria-describedby={codes.length > 0 ? issueId : undefined}>
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
    </div>
  );
}

/**
 * The pill between the first two rules (`[data-mode]`): "All" / "Any" of the
 * group, each half `aria-pressed`. The accent thumb slides to the half on.
 */
function ModePill({ group, context }: { group: KitGroup; context: Context }) {
  const { t } = useTranslation('automationBuilder');
  const set = (op: KitGroup['op']) => {
    if (op === group.op) return;
    context.change(group.id, (item) => (item.kind === 'group' ? { ...item, op } : item));
  };
  return (
    <div role="group" aria-label={t('conditions.match')} data-mode={group.op}>
      <button
        type="button"
        aria-pressed={group.op === 'and'}
        onClick={() => {
          set('and');
        }}
      >
        {t('conditions.all')}
      </button>
      <button
        type="button"
        aria-pressed={group.op === 'or'}
        onClick={() => {
          set('or');
        }}
      >
        {t('conditions.any')}
      </button>
    </div>
  );
}

/** A group: its bar (`.logic`), the rules with the pill and the joints, then "Add". */
function Branch({ group, depth, context }: { group: KitGroup; depth: number; context: Context }) {
  const { t } = useTranslation(['automationBuilder', 'toolbar']);
  const labelId = useId();
  const root = depth === 1;
  const { model } = context;
  const first = context.fields[0];
  const canAdd = model.canAddCondition(context.root) && first !== undefined;
  const codes = context.issues.get(group.id) ?? [];
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className="branch"
      data-depth={root ? 'root' : 'nested'}
      data-testid={root ? 'filter-root' : 'filter-group'}
      data-filter-item={group.id}
    >
      <div className="branch-head">
        <span id={labelId} className="branch-label">
          {root ? context.rootLabel : t('conditions.group')}
        </span>
        {root ? null : (
          <Tooltip content={t('toolbar:filter.removeGroup')}>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={t('toolbar:filter.removeGroup')}
              onClick={() => {
                context.remove(group.id);
              }}
            >
              <X aria-hidden="true" />
            </Button>
          </Tooltip>
        )}
      </div>
      <div className="logic">
        {root && group.items.length === 0 ? <p className="empty">{context.emptyText}</p> : null}
        {group.items.length === 0 ? null : (
          <ul className="rules">
            {group.items.map((item, index) => (
              <li key={item.id}>
                {index === 1 ? <ModePill group={group} context={context} /> : null}
                {index > 1 ? (
                  // What the pill chose, again before each later rule (drops in when it changes).
                  <span key={group.op} className="joint animate-reveal" aria-hidden="true">
                    {t(group.op === 'or' ? 'conditions.or' : 'conditions.and')}
                  </span>
                ) : null}
                {item.kind === 'condition' ? <Rule item={item} context={context} /> : null}
                {item.kind === 'raw' ? <RawRule id={item.id} context={context} /> : null}
                {item.kind === 'group' ? (
                  <Branch group={item} depth={depth + 1} context={context} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {codes.length > 0 ? <IssueText id={`${labelId}-issues`} codes={codes} /> : null}
        <div className="adds">
          <Button
            variant="ghost"
            size="sm"
            disabled={!canAdd}
            data-filter-add={group.id}
            onClick={() => {
              if (first === undefined) return;
              context.onChange(model.appendTo(context.root, group.id, model.newCondition(first)));
            }}
          >
            <Plus aria-hidden="true" />
            {t('toolbar:filter.addCondition')}
          </Button>
          {model.canNestGroup(depth) && depth < context.maxDepth ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={!canAdd}
              onClick={() => {
                if (first === undefined) return;
                const nested: KitGroup = {
                  kind: 'group',
                  id: model.newItemId(),
                  op: 'and',
                  items: [model.newCondition(first)],
                };
                context.onChange(model.appendTo(context.root, group.id, nested));
              }}
            >
              <FolderPlus aria-hidden="true" />
              {t('toolbar:filter.addGroup')}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** `value`, once it has stopped changing for `delay` ms. */
function useSettled<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSettled(value);
    }, delay);
    return () => {
      window.clearTimeout(timer);
    };
  }, [value, delay]);
  return settled;
}

interface Count {
  readonly count: number;
  readonly estimated: boolean;
}

/**
 * "N records match now" (the pattern's `.out`): one `records/query` of one
 * row with its count, as the person editing (their read rule and fields),
 * 400 ms after the last change; hidden when the count fails.
 */
function MatchCount({ tableId, filter }: { tableId: string; filter: FilterNode }) {
  const { t, i18n } = useTranslation('automationBuilder');
  const key = JSON.stringify(filter);
  const settled = useSettled(key, COUNT_DEBOUNCE_MS);
  const query = useQuery({
    queryKey: ['automation-builder', 'condition-count', tableId, settled],
    queryFn: async ({ signal }): Promise<Count> => {
      const page = await api.records.query(
        tableId,
        { filter: JSON.parse(settled) as Record<string, unknown>, limit: 1, fields: [] },
        { signal },
      );
      if ('total' in page) return { count: page.total, estimated: false };
      if ('total_estimate' in page) return { count: page.total_estimate, estimated: true };
      return { count: page.records.length, estimated: true };
    },
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  });
  const number = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(null);
  const count = query.data?.count;
  useEffect(() => {
    if (count === undefined) return;
    if (shown.current !== null && shown.current !== count) slideCount(number.current);
    shown.current = count;
  }, [count]);

  if (query.isError) return null;
  const busy = settled !== key || query.isFetching;
  const data = query.data;
  return (
    <div
      className="out"
      data-testid="condition-match-count"
      data-count={data?.count}
      aria-busy={busy}
    >
      <output>
        {data === undefined ? (
          <>
            <span className="num animate-shimmer" data-loading="" ref={number} />
            <span>{t('conditions.counting')}</span>
          </>
        ) : (
          <>
            {data.estimated ? <span>{t('conditions.about')}</span> : null}
            <span className="num" ref={number}>
              {new Intl.NumberFormat(i18n.language).format(data.count)}
            </span>
            <span>{t('conditions.matchNow', { count: data.count })}</span>
          </>
        )}
      </output>
      <p className="note">{t('conditions.countNote')}</p>
    </div>
  );
}

/**
 * The conditions of an automation step or trigger (props of
 * `AutomationConditionEditorProps`, `lib/automation/condition-editor.ts`).
 * Every change reaches the builder with whether it is complete and valid;
 * issues of the last save (`422 AUTOMATION_INVALID`) mark their rule.
 */
export function ConditionBranchBuilder({
  tableId,
  orgId,
  value,
  onChange,
  changeOperators = false,
  excludeFields,
  issues: serverIssues = [],
  label,
  emptyText,
  nested = false,
  ValueSource,
  kit,
}: ConditionBranchBuilderProps) {
  const { t } = useTranslation('toolbar');
  const { model, ValueEditor } = kit;
  const fields = useQuery(fieldsQuery(tableId));
  const options = useMemo<KitModelOptions>(() => {
    const virtual = new Set(
      (fields.data?.items ?? [])
        .filter((field) => field.compute_mode === 'virtual')
        .map((field) => field.id),
    );
    const sources = ValueSource === undefined ? {} : { isSourceValue: isAutomationValue };
    return changeOperators ? { mode: 'automation', noChangeFields: virtual, ...sources } : sources;
  }, [changeOperators, fields.data, ValueSource]);
  const filterable = useMemo(
    () =>
      model.filterableFields(
        (fields.data?.items ?? []).filter((field) => excludeFields?.has(field.id) !== true),
        options,
      ),
    [model, fields.data, excludeFields, options],
  );
  const [root, setRoot] = useState<KitGroup>(() => model.fromFilter(value));
  const local = useMemo(
    () => model.checkFilter(root, filterable, options),
    [model, root, filterable, options],
  );
  // Issues of the server, by the item at their path (the tree sent was this one).
  const merged = useMemo(() => {
    const result = new Map<string, string[]>(local.issues);
    if (serverIssues.length === 0) return result;
    const { paths } = model.toFilter(root, filterable, options);
    for (const [id, codes] of model.issuesByItem(serverIssues, paths)) {
      result.set(id, [...(result.get(id) ?? []), ...codes]);
    }
    return result;
  }, [model, local.issues, serverIssues, root, filterable, options]);
  // `update_records` (values from the automation) counts in its own panel; a
  // condition the check refuses is not sent.
  const counted = useMemo(
    () =>
      ValueSource !== undefined || local.issues.size > 0 ? null : countableFilter(local.filter),
    [ValueSource, local],
  );

  const container = useRef<HTMLDivElement>(null);
  // Where the focus goes once a removed item has left the DOM (FRONTEND §9.2).
  const pendingFocus = useRef<ReturnType<ConditionModel['focusAfterRemoval']>>(null);
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
  }, [root]);

  if (fields.isPending) return null;
  if (filterable.length === 0 && model.conditionCount(root) === 0) {
    return <p className="text-body text-fg-muted">{t('filter.noFields')}</p>;
  }
  const update = (next: KitGroup) => {
    setRoot(next);
    onChange(stateOf(model, next, filterable, options));
  };
  const context: Context = {
    model,
    ValueEditor,
    ValueSource,
    root,
    fields: filterable,
    byId: new Map(filterable.map((field) => [field.id as string, field])),
    issues: merged,
    incomplete: local.incomplete,
    options,
    orgId,
    rootLabel: label,
    emptyText,
    maxDepth: nested ? Number.POSITIVE_INFINITY : 1,
    onChange: update,
    change: (id, next) => {
      if (id !== root.id) {
        update(model.updateItem(root, id, next));
        return;
      }
      const changed = next(root);
      if (changed?.kind === 'group') update(changed);
    },
    remove: (id) => {
      pendingFocus.current = model.focusAfterRemoval(root, id);
      update(model.updateItem(root, id, () => null));
    },
  };
  return (
    <div
      ref={container}
      className="ux u132"
      data-testid="automation-conditions"
      onKeyDown={(event) => {
        // Enter in a value box must not submit anything around it.
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
          event.preventDefault();
        }
      }}
    >
      <Branch group={root} depth={1} context={context} />
      {counted === null ? null : <MatchCount tableId={tableId} filter={counted} />}
    </div>
  );
}

export default ConditionBranchBuilder;
