import {
  MAX_AUTOMATION_ACTIONS,
  type AutomationAction,
  type AutomationDefinition,
} from '@cellhive/contracts';
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
} from '@cellhive/ui';
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import {
  Clock,
  Filter,
  GitBranch,
  Globe,
  Mail,
  MessageSquare,
  PencilLine,
  Plus,
  Search,
  Send,
  SquarePlus,
  Trash2,
  Bell,
  Rows3,
  Settings,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { createContext, Fragment, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { TRIGGER_ICONS } from '../../../trigger-icons';
import {
  ACTION_MENU,
  canAddAction,
  COMING_SOON,
  hasTriggerRecord,
  isAddable,
  placedActions,
  ROOT,
  type AddableActionType,
  type ListRef,
} from '../../model/draft';
import { issuesOf, type StepKey } from '../../model/issues';
import { type ValueScope } from '../../model/scope';
import { useBuilderEnv } from '../env';
import { FilterSummary, useActionSummary, useTriggerSummary } from '../summaries';

import { StepCard } from './StepCard';

const TRIGGER_STEP = 'trigger';
const CONDITION_STEP = 'condition';

/** Icon of each action type (board "S5 · Automation builder"). */
export const ACTION_ICONS: Record<string, LucideIcon> = {
  create_record: SquarePlus,
  update_record: PencilLine,
  update_records: Rows3,
  find_records: Search,
  delete_record: Trash2,
  delay: Clock,
  if: GitBranch,
  send_email: Mail,
  send_notification: Bell,
  send_telegram: Send,
  http_request: Globe,
  run_n8n_workflow: Workflow,
};

export interface FlowCanvasProps {
  readonly definition: AutomationDefinition;
  readonly selected: StepKey | null;
  readonly onSelect: (step: StepKey) => void;
  readonly onAdd: (type: AddableActionType, list: ListRef, index: number) => void;
  readonly onMove: (id: string, delta: number) => void;
  readonly onMoveTo: (id: string, overId: string) => void;
  readonly onDelete: (action: AutomationAction) => void;
  readonly scopeOf: (actionId: string | null) => ValueScope;
  readonly triggerTableId: string | null;
}

function Line({ height = 'h-2' }: { readonly height?: string }) {
  return <div aria-hidden="true" className={cn('w-px shrink-0 bg-line-strong', height)} />;
}

/** The "add a step" menu: what can be added now, then what comes later (disabled, "coming soon"). */
function AddStepMenu({
  list,
  index,
  variant,
  label,
}: {
  readonly list: ListRef;
  readonly index: number;
  readonly variant: 'dot' | 'button' | 'branch';
  readonly label?: string;
}) {
  const { t } = useTranslation('automationBuilder');
  const context = useCanvas();
  const env = useBuilderEnv();
  const full = !canAddAction(context.definition);
  const count = placedActions(context.definition).length;
  const trigger =
    variant === 'dot' ? (
      <Button
        variant="secondary"
        size="icon"
        className="size-6 rounded-full max-lg:size-control"
        aria-label={t('flow.addHere')}
        disabled={full}
        data-testid="add-step-here"
      >
        <Plus aria-hidden="true" className="!size-3" />
      </Button>
    ) : (
      <Button
        variant="secondary"
        size="sm"
        className={cn('border-dashed max-lg:h-control', variant === 'button' && 'h-control')}
        disabled={full}
        data-testid={variant === 'button' ? 'add-step' : 'add-branch-step'}
      >
        <Plus aria-hidden="true" />
        {label ?? t('flow.add')}
        {variant === 'button' ? (
          <span className="font-normal text-fg-muted">
            {t('flow.count', { count, max: MAX_AUTOMATION_ACTIONS })}
          </span>
        ) : null}
      </Button>
    );
  return (
    <DropdownMenu modal={false}>
      {variant === 'dot' ? (
        <Tooltip content={t('flow.addHere')}>
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        </Tooltip>
      ) : (
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      )}
      <DropdownMenuContent align="center" className="w-64" data-testid="add-step-menu">
        <DropdownMenuLabel>{t('flow.addTitle')}</DropdownMenuLabel>
        {ACTION_MENU.map((type, position) => {
          const Icon = ACTION_ICONS[type] ?? Plus;
          const soon = COMING_SOON[type] !== undefined;
          // (T522) No SMTP and no sender identity: nothing could be sent.
          const noEmail = type === 'send_email' && env.emailUnavailable;
          const blocked =
            noEmail ||
            (type === 'if' && list.kind === 'branch') ||
            (type === 'delete_record' && !hasTriggerRecord(context.definition.trigger));
          return (
            <Fragment key={type}>
              {position === 5 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem
                disabled={soon || blocked}
                data-testid={`add-${type}`}
                onSelect={() => {
                  if (isAddable(type)) context.onAdd(type, list, index);
                }}
              >
                <Icon aria-hidden="true" />
                <span className="min-w-0 flex-1">{t(`actionType.${type}`)}</span>
                {soon ? (
                  <span className="text-label font-normal text-fg-muted">{t('flow.soon')}</span>
                ) : null}
                {noEmail ? (
                  <span className="text-label font-normal text-fg-muted">{t('flow.noEmail')}</span>
                ) : null}
              </DropdownMenuItem>
              {noEmail && env.emailSettingsPath !== null ? (
                <DropdownMenuItem asChild>
                  <Link to={env.emailSettingsPath} data-testid="add-email-settings">
                    <Settings aria-hidden="true" />
                    {t('flow.openEmailSettings')}
                  </Link>
                </DropdownMenuItem>
              ) : null}
            </Fragment>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const CanvasContext = createContext<FlowCanvasProps | null>(null);
function useCanvas(): FlowCanvasProps {
  const value = useContext(CanvasContext);
  if (value === null) throw new Error('outside the flow canvas');
  return value;
}

function ActionCard({
  action,
  number,
  index,
  length,
}: {
  readonly action: AutomationAction;
  readonly number: string;
  readonly index: number;
  readonly length: number;
}) {
  const { t } = useTranslation('automationBuilder');
  const context = useCanvas();
  const env = useBuilderEnv();
  const scope = context.scopeOf(action.id);
  const summary = useActionSummary(action, scope);
  return (
    <StepCard
      stepKey={action.id}
      eyebrow={t('flow.step', { number })}
      title={summary.title}
      body={summary.body}
      icon={ACTION_ICONS[action.type] ?? Plus}
      selected={context.selected === action.id}
      issueCount={issuesOf(env.issues, action.id as StepKey).length}
      readOnly={env.readOnly}
      narrow={env.readOnly}
      muted={COMING_SOON[action.type] !== undefined}
      onSelect={() => {
        context.onSelect(action.id as StepKey);
      }}
      actions={{
        sortableId: action.id,
        canUp: index > 0,
        canDown: index < length - 1,
        onMove: (delta) => {
          context.onMove(action.id, delta);
        },
        onDelete: () => {
          context.onDelete(action);
        },
      }}
    />
  );
}

/** The actions of one list (top level or a branch), with "+" between them. */
function ActionList({
  actions,
  list,
  numbers,
  width,
}: {
  readonly actions: readonly AutomationAction[];
  readonly list: ListRef;
  readonly numbers: ReadonlyMap<string, string>;
  readonly width: 'full' | 'branch';
}) {
  const { t } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  return (
    <SortableContext
      items={actions.map((action) => action.id)}
      strategy={verticalListSortingStrategy}
    >
      {actions.map((action, index) => (
        <div key={action.id} className="flex w-full flex-col items-center">
          {width === 'full' && !env.readOnly && index > 0 ? (
            <>
              <Line />
              <AddStepMenu list={list} index={index} variant="dot" />
            </>
          ) : null}
          {index > 0 || width === 'full' ? <Line /> : null}
          <ActionCard
            action={action}
            number={numbers.get(action.id) ?? '?'}
            index={index}
            length={actions.length}
          />
          {action.type === 'if' ? <Branches action={action} numbers={numbers} /> : null}
        </div>
      ))}
      {actions.length === 0 && width === 'branch' ? (
        <p className="text-label font-normal text-fg-muted">{t('flow.emptyBranch')}</p>
      ) : null}
    </SortableContext>
  );
}

function Branches({
  action,
  numbers,
}: {
  readonly action: Extract<AutomationAction, { type: 'if' }>;
  readonly numbers: ReadonlyMap<string, string>;
}) {
  const { t } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  const branches = [
    { key: 'then' as const, label: t('flow.true'), tone: 'bg-success/10 text-success' },
    { key: 'else' as const, label: t('flow.false'), tone: 'bg-surface-sunken text-fg' },
  ];
  return (
    <div
      className="relative grid w-full grid-cols-1 gap-5 pt-2 sm:grid-cols-2"
      data-testid={`branches-${action.id}`}
    >
      {branches.map((branch) => {
        const stopped = branch.key === 'else' && action.config.on_false === 'stop';
        return (
          <section
            key={branch.key}
            aria-label={t('flow.branch', {
              label: branch.label,
              number: numbers.get(action.id) ?? '',
            })}
            className="flex min-w-0 flex-col items-center gap-0"
            data-testid={`branch-${action.id}-${branch.key}`}
          >
            <Line height="h-2.5" />
            <span
              className={cn(
                'inline-flex h-[22px] items-center rounded-full px-2 text-label font-medium',
                branch.tone,
              )}
            >
              {branch.label}
            </span>
            <Line height="h-2.5" />
            {stopped ? (
              <p className="rounded-md border border-dashed border-line-strong px-3 py-2 text-label font-normal text-fg-muted">
                {t('flow.stops')}
              </p>
            ) : (
              <>
                <ActionList
                  actions={action.config[branch.key]}
                  list={{ kind: 'branch', ifId: action.id, branch: branch.key }}
                  numbers={numbers}
                  width="branch"
                />
                {env.readOnly ? null : (
                  <>
                    <Line />
                    <AddStepMenu
                      list={{ kind: 'branch', ifId: action.id, branch: branch.key }}
                      index={action.config[branch.key].length}
                      variant="branch"
                      label={t('flow.addInBranch', { label: branch.label })}
                    />
                  </>
                )}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}

/**
 * The flow (board "S5 · Automation builder"): trigger → condition → steps,
 * vertical, 600 px wide; "+" between steps to insert, an `if` splits into
 * "True" / "False" columns with their own "Add step"; the end shows how
 * many steps of the 20 allowed are used. Steps are dragged by their grip
 * within their list (pointer) or moved with Alt+↑/↓ (keyboard).
 */
export function FlowCanvas(props: FlowCanvasProps) {
  const { t } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  const { definition } = props;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const numbers = new Map(
    placedActions(definition).map((placed) => [placed.action.id, placed.number]),
  );
  const trigger = useTriggerSummary(definition);
  const TriggerIcon = TRIGGER_ICONS[definition.trigger.type];
  const recordless = !hasTriggerRecord(definition.trigger);
  const condition = definition.condition;
  const onDragEnd = (event: DragEndEvent) => {
    if (event.over === null) return;
    props.onMoveTo(String(event.active.id), String(event.over.id));
  };
  return (
    <CanvasContext.Provider value={props}>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <div className="mx-auto flex w-full max-w-[600px] flex-col items-center" data-testid="flow">
          <StepCard
            stepKey={TRIGGER_STEP}
            eyebrow={t('flow.when')}
            title={trigger.title}
            body={trigger.body}
            icon={TriggerIcon}
            selected={props.selected === 'trigger'}
            issueCount={issuesOf(env.issues, 'trigger').length}
            readOnly={env.readOnly}
            narrow={env.readOnly}
            onSelect={() => {
              props.onSelect('trigger');
            }}
          />
          {recordless ? null : (
            <>
              <Line height="h-3.5" />
              <StepCard
                stepKey={CONDITION_STEP}
                eyebrow={t('flow.onlyIf')}
                title={
                  condition === null
                    ? t('flow.noCondition')
                    : condition['op'] === 'or'
                      ? t('flow.anyCondition')
                      : t('flow.allConditions')
                }
                body={<FilterSummary filter={condition} tableId={props.triggerTableId} />}
                icon={Filter}
                selected={props.selected === 'condition'}
                issueCount={issuesOf(env.issues, 'condition').length}
                readOnly={env.readOnly}
                narrow={env.readOnly}
                onSelect={() => {
                  props.onSelect('condition');
                }}
              />
            </>
          )}
          {env.readOnly ? null : (
            <>
              <Line />
              <AddStepMenu list={ROOT} index={0} variant="dot" />
            </>
          )}
          <ActionList actions={definition.actions} list={ROOT} numbers={numbers} width="full" />
          {env.readOnly ? null : (
            <>
              <Line />
              <AddStepMenu list={ROOT} index={definition.actions.length} variant="button" />
            </>
          )}
          {definition.actions.length === 0 ? (
            <p className="mt-3 flex items-center gap-1.5 text-label font-normal text-fg-muted">
              <MessageSquare aria-hidden="true" className="size-3.5" />
              {t('flow.noActions')}
            </p>
          ) : null}
        </div>
      </DndContext>
    </CanvasContext.Provider>
  );
}
