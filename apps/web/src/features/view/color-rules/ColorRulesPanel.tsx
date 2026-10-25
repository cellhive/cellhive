import {
  COLOR_RULE_COLORS,
  MAX_COLOR_RULES,
  type ColorRuleColor,
  type ColorRuleTarget,
  type FieldDto,
} from '@cellhive/contracts';
import { Alert, Button, cn, Select, Switch, Tooltip } from '@cellhive/ui';
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { stableQueryHash } from '../../../lib/query/keys';
import { countConditions } from '../../../lib/views/query';
import { filterableFields } from '../toolbar/filter-model';
import { FilterBuilder } from '../toolbar/FilterBuilder';

import {
  buildRules,
  canAddRule,
  editorRulesOf,
  mergeEditorRules,
  moveRule,
  newRule,
  type EditorRule,
  type RuleCheck,
} from './rules-model';

import type { ViewColorRule } from '../../../lib/views/config';
import type { ViewToolbarProps } from '../../../lib/views/toolbar';

/** Rules sent are compared by content: the panel's own save does not rebuild the trees. */
function rulesHash(rules: readonly ViewColorRule[] | undefined): string {
  return stableQueryHash(
    (rules ?? []).map((rule) => ({
      id: rule.id,
      enabled: rule.enabled,
      filter: rule.filter ?? null,
      color: rule.color,
      target: rule.target,
      field_id: rule.field_id,
    })),
  );
}

/** {@link rulesHash} without the filters (which the server answers in its own form). */
function shapeHash(rules: readonly ViewColorRule[] | undefined): string {
  return rulesHash((rules ?? []).map((rule) => ({ ...rule, filter: null })));
}

/** A palette color as a swatch: the rule background with its mark. */
export function Swatch({ color, className }: { color: ColorRuleColor; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-5 shrink-0 rounded-sm border-l-[3px]', className)}
      style={{
        backgroundColor: `var(--rule-${color}-bg)`,
        borderLeftColor: `var(--rule-${color}-mark)`,
      }}
    />
  );
}

function ColorPicker({
  value,
  label,
  onChange,
}: {
  value: ColorRuleColor;
  label: string;
  onChange: (color: ColorRuleColor) => void;
}) {
  const { t } = useTranslation('toolbar');
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const select = (index: number) => {
    const color = COLOR_RULE_COLORS[(index + COLOR_RULE_COLORS.length) % COLOR_RULE_COLORS.length];
    if (color === undefined) return;
    onChange(color);
    refs.current[COLOR_RULE_COLORS.indexOf(color)]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap items-center gap-1">
      {COLOR_RULE_COLORS.map((color, index) => (
        <Tooltip key={color} content={t(`colorRules.colors.${color}`)}>
          <button
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={value === color}
            aria-label={t(`colorRules.colors.${color}`)}
            tabIndex={value === color ? 0 : -1}
            data-color={color}
            className={cn(
              // 32 px, 44 px on touch screens (T322a).
              'inline-flex size-8 items-center justify-center rounded-md border border-transparent max-md:size-11',
              value === color && 'border-line-strong ring-2 ring-accent',
            )}
            onClick={() => {
              onChange(color);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                event.preventDefault();
                select(index + 1);
              } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                event.preventDefault();
                select(index - 1);
              }
            }}
          >
            <Swatch color={color} />
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

interface RuleCardProps {
  readonly rule: EditorRule;
  readonly index: number;
  readonly count: number;
  readonly check: RuleCheck | undefined;
  readonly fields: readonly FieldDto[];
  readonly filterable: readonly FieldDto[];
  readonly orgId: string;
  readonly onChange: (rule: EditorRule) => void;
  readonly onMove: (to: number) => void;
  readonly onRemove: () => void;
}

const NO_ISSUES: ReadonlyMap<string, readonly string[]> = new Map();
const NO_INCOMPLETE: ReadonlySet<string> = new Set();

function RuleCard({
  rule,
  index,
  count,
  check,
  fields,
  filterable,
  orgId,
  onChange,
  onMove,
  onRemove,
}: RuleCardProps) {
  const { t } = useTranslation('toolbar');
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id: rule.id,
  });
  const position = index + 1;
  const name = t('colorRules.rule', { position });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'flex flex-col gap-2 rounded-md border border-line bg-surface p-2',
        isDragging && 'relative z-10 shadow-popover',
        !rule.enabled && 'opacity-80',
      )}
      aria-label={name}
      data-testid="color-rule"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Tooltip content={t('colorRules.drag')} side="left">
          <span
            {...listeners}
            aria-hidden="true"
            className="inline-flex size-8 shrink-0 cursor-grab items-center justify-center text-fg-muted"
          >
            <GripVertical aria-hidden="true" className="size-4" />
          </span>
        </Tooltip>
        <Swatch color={rule.color} />
        <span className="text-label font-medium">{name}</span>
        {rule.broken ? (
          <span
            className="inline-flex items-center gap-1 rounded-sm bg-surface-sunken px-1.5 text-label text-danger"
            data-testid="color-rule-broken"
          >
            <TriangleAlert aria-hidden="true" className="size-3.5" />
            {t('colorRules.broken')}
          </span>
        ) : null}
        <label className="ml-auto inline-flex items-center gap-2 text-label">
          <Switch
            checked={rule.enabled}
            onChange={(event) => {
              onChange({ ...rule, enabled: event.currentTarget.checked });
            }}
            aria-label={t('colorRules.enabled', { position })}
          />
          <span aria-hidden="true">{t('colorRules.enabledShort')}</span>
        </label>
        <Tooltip content={t('colorRules.moveUp', { position })}>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('colorRules.moveUp', { position })}
            disabled={index === 0}
            onClick={() => {
              onMove(index - 1);
            }}
          >
            <ArrowUp aria-hidden="true" />
          </Button>
        </Tooltip>
        <Tooltip content={t('colorRules.moveDown', { position })}>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('colorRules.moveDown', { position })}
            disabled={index === count - 1}
            onClick={() => {
              onMove(index + 1);
            }}
          >
            <ArrowDown aria-hidden="true" />
          </Button>
        </Tooltip>
        <Tooltip content={t('colorRules.remove', { position })}>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('colorRules.remove', { position })}
            onClick={onRemove}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </Tooltip>
      </div>
      <ColorPicker
        value={rule.color}
        label={t('colorRules.color', { position })}
        onChange={(color) => {
          onChange({ ...rule, color });
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select
          className="w-44"
          aria-label={t('colorRules.target', { position })}
          value={rule.target}
          onChange={(event) => {
            const target: ColorRuleTarget = event.currentTarget.value === 'cell' ? 'cell' : 'row';
            onChange({ ...rule, target });
          }}
        >
          <option value="row">{t('colorRules.targetRow')}</option>
          <option value="cell">{t('colorRules.targetCell')}</option>
        </Select>
        {rule.target === 'cell' ? (
          <Select
            className="w-52"
            aria-label={t('colorRules.cellField', { position })}
            aria-invalid={check?.missingField === true || undefined}
            value={rule.fieldId ?? ''}
            onChange={(event) => {
              const value = event.currentTarget.value;
              onChange({ ...rule, fieldId: value === '' ? null : value });
            }}
          >
            <option value="">{t('colorRules.chooseField')}</option>
            {fields.map((field) => (
              <option key={field.id} value={field.id}>
                {field.name}
              </option>
            ))}
          </Select>
        ) : null}
      </div>
      {check?.missingField === true ? (
        <p className="text-label text-danger">{t('colorRules.fieldRequired')}</p>
      ) : null}
      <FilterBuilder
        root={rule.root}
        onChange={(root) => {
          onChange({ ...rule, root, edited: true });
        }}
        fields={filterable}
        issues={check?.filter?.issues ?? NO_ISSUES}
        incomplete={check?.filter?.incomplete ?? NO_INCOMPLETE}
        orgId={orgId}
        rootLabel={t('colorRules.when')}
        emptyText={t('colorRules.noCondition')}
        compact
      />
    </li>
  );
}

/** A rule as someone who may not save the view sees it. */
function ReadOnlyRule({
  rule,
  index,
  fields,
}: {
  rule: ViewColorRule;
  index: number;
  fields: readonly FieldDto[];
}) {
  const { t } = useTranslation('toolbar');
  const field = fields.find((candidate) => candidate.id === rule.field_id);
  const conditions = countConditions(rule.filter);
  return (
    <li className="flex flex-wrap items-center gap-2 py-1" data-testid="color-rule">
      <Swatch color={rule.color} />
      <span className="text-label font-medium">
        {t('colorRules.rule', { position: index + 1 })}
      </span>
      <span className="text-label text-fg-muted">
        {rule.target === 'row'
          ? t('colorRules.targetRow')
          : t('colorRules.cellOf', { field: field?.name ?? t('filter.unknownField') })}
        {' · '}
        {conditions === 0
          ? t('colorRules.noConditionShort')
          : t('colorRules.conditions', { count: conditions })}
        {rule.enabled ? '' : ` · ${t('colorRules.off')}`}
      </span>
      {rule.broken === true ? (
        <span className="text-label text-danger">{t('colorRules.broken')}</span>
      ) : null}
    </li>
  );
}

/**
 * The color rules of a grid view (T816): a list in priority order — drag
 * or move up/down — each with an on/off switch, a palette color, the row or
 * one cell, and conditions with the view filter builder. Every valid change
 * is saved with the view (debounced); a rule with an issue or a condition
 * still waiting for a value holds the save back. Who may not save the view
 * sees the rules, read-only.
 */
export default function ColorRulesPanel({ view, fields, orgId, state }: ViewToolbarProps) {
  const { t } = useTranslation('toolbar');
  const filterable = useMemo(() => filterableFields(fields), [fields]);
  const applied = state.config.color_rules;
  const appliedHash = rulesHash(applied);
  const [rules, setRules] = useState<EditorRule[]>(() => editorRulesOf(applied));
  // The rules this panel last sent (or was built from): another value (another tab, a
  // refused save) rebuilds the list. The answer to a save brings the filters in the
  // server's form: the same rules otherwise, it is taken as is (the builders stay).
  const [ownHash, setOwnHash] = useState(appliedHash);
  const [ownShape, setOwnShape] = useState(() => shapeHash(applied));
  // The saved rules when this panel's save started: the session ends the save a render
  // before the view's cache shows its answer, so they come back for a moment.
  const [beforeSave, setBeforeSave] = useState<string | null>(null);
  const [seenHash, setSeenHash] = useState(appliedHash);
  if (seenHash !== appliedHash) {
    setSeenHash(appliedHash);
    const shape = shapeHash(applied);
    if (appliedHash !== ownHash && shape !== beforeSave) {
      if (shape !== ownShape) {
        setRules((current) => mergeEditorRules(current, applied, filterable));
        setOwnShape(shape);
      }
      setOwnHash(appliedHash);
      setBeforeSave(null);
    }
  }
  const built = useMemo(() => buildRules(rules, filterable), [rules, filterable]);
  const { change } = state;
  // Every edit goes through here: a valid list not sent yet is saved with the view.
  const update = (next: EditorRule[]) => {
    setRules(next);
    const sendable = buildRules(next, filterable).rules;
    if (sendable === null) return;
    const hash = rulesHash(sendable);
    if (hash === ownHash) return;
    setOwnHash(hash);
    setOwnShape(shapeHash(sendable));
    if (hash === appliedHash) return;
    setBeforeSave((current) => current ?? shapeHash(state.saved.color_rules));
    change({ color_rules: sendable });
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const edit = (index: number, rule: EditorRule) => {
    update(rules.map((item, at) => (at === index ? rule : item)));
  };
  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over === null || active.id === over.id) return;
    const from = rules.findIndex((rule) => rule.id === active.id);
    const to = rules.findIndex((rule) => rule.id === over.id);
    if (from >= 0 && to >= 0) update(moveRule(rules, from, to));
  };

  if (!state.canSave) {
    return (
      <>
        <h2 className="text-heading">{t('colorRules.title')}</h2>
        <p className="text-body text-fg-muted">
          {view.locked ? t('colorRules.locked') : t('colorRules.readOnly')}
        </p>
        {(applied ?? []).length === 0 ? (
          <p className="text-body text-fg-muted">{t('colorRules.none')}</p>
        ) : (
          <ol aria-label={t('colorRules.title')} className="flex flex-col">
            {(applied ?? []).map((rule, index) => (
              <ReadOnlyRule key={rule.id} rule={rule} index={index} fields={fields} />
            ))}
          </ol>
        )}
      </>
    );
  }

  return (
    <>
      <h2 className="text-heading">{t('colorRules.title')}</h2>
      <p className="text-label text-fg-muted">{t('colorRules.hint')}</p>
      {rules.length === 0 ? (
        <p className="text-body text-fg-muted">{t('colorRules.none')}</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext
            items={rules.map((rule) => rule.id)}
            strategy={verticalListSortingStrategy}
          >
            <ol aria-label={t('colorRules.title')} className="flex flex-col gap-2">
              {rules.map((rule, index) => (
                <RuleCard
                  key={rule.id}
                  rule={rule}
                  index={index}
                  count={rules.length}
                  check={built.checks.get(rule.id)}
                  fields={fields}
                  filterable={filterable}
                  orgId={orgId}
                  onChange={(next) => {
                    edit(index, next);
                  }}
                  onMove={(to) => {
                    update(moveRule(rules, index, to));
                  }}
                  onRemove={() => {
                    update(rules.filter((item) => item.id !== rule.id));
                  }}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}
      {built.rules === null ? (
        <Alert variant="info" role="status">
          {t('colorRules.notSaved')}
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={!canAddRule(rules)}
          onClick={() => {
            update([...rules, newRule(rules)]);
          }}
          data-testid="color-rule-add"
        >
          <Plus aria-hidden="true" />
          {t('colorRules.add')}
        </Button>
        {canAddRule(rules) ? null : (
          <span className="text-label text-fg-muted">
            {t('colorRules.max', { max: MAX_COLOR_RULES })}
          </span>
        )}
      </div>
    </>
  );
}
