import {
  MAX_NOTIFICATION_RECIPIENT_VALUES,
  MAX_NOTIFICATION_STEP_RECIPIENTS,
  type AutomationAction,
  type NotificationRecipientValue,
  type SendNotificationConfig,
  AutomationDefinition,
} from '@cellhive/contracts';
import { Button, cn, Select, Switch, Tooltip } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Clock,
  Hash,
  Layers,
  Plus,
  User,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { orgGroupsQuery, orgMembersQuery } from '../../../../../lib/query/queries';
import { useBuilderEnv } from '../../components/env';
import { IssueText, Note, PanelField } from '../../components/panels/common';
import { CHIP_CLASS, CHIP_TONE_CLASS, useChipText } from '../../components/values/chips';
import { ExpressionDialog } from '../../components/values/ExpressionDialog';
import { pickerSections } from '../../components/values/sections';
import { TemplateInput } from '../../components/values/TemplateInput';
import { useTemplateChips } from '../../components/values/use-template-chips';
import { ValuePicker, type PickerSection } from '../../components/values/ValuePicker';
import { earlierActions, hasTriggerRecord } from '../../model/draft';
import { issuesOf, type StepKey } from '../../model/issues';
import { sourceNameOf, type ChipTone, type ValueScope } from '../../model/scope';
import { USER_FIELD_TYPES } from '../send-email/model';

const PATH_CONFIG_BODY_TEMPLATE = 'config.body.template';
const PATH_CONFIG_LINK_RECORD = 'config.link_record';
const PATH_CONFIG_TITLE_TEMPLATE = 'config.title.template';
const TEST_NOTIFICATION_BODY = 'notification-body';
const TEST_NOTIFICATION_NOTE = 'notification-note';
const TEST_NOTIFICATION_TITLE = 'notification-title';

type SendNotificationAction = Extract<AutomationAction, { type: 'send_notification' }>;

export interface SendNotificationPanelProps {
  readonly action: SendNotificationAction;
  readonly definition: AutomationDefinition;
  readonly scope: ValueScope;
  readonly onChange: (action: AutomationAction) => void;
}

/** Steps whose record a notification may show and link (CONTRACTS §21: not `find_records`). */
const RECORD_STEPS: ReadonlySet<string> = new Set(['create_record', 'update_record']);

const ICONS: Record<ChipTone | 'user' | 'group', LucideIcon> = {
  user: User,
  group: Users,
  field: Hash,
  trigger: Clock,
  step: Layers,
  expression: Hash,
  error: AlertTriangle,
};

/** A recipient value as one token each (fixed users one by one). */
function tokensOf(values: readonly NotificationRecipientValue[]): NotificationRecipientValue[] {
  return values.flatMap((value): NotificationRecipientValue[] =>
    'user_ids' in value ? value.user_ids.map((user) => ({ user_ids: [user] })) : [value],
  );
}

/** Tokens back to values: fixed users gathered in one `{ user_ids }` (CONTRACTS §21). */
function valuesOf(tokens: readonly NotificationRecipientValue[]): NotificationRecipientValue[] {
  const users = tokens.flatMap((token) => ('user_ids' in token ? token.user_ids : []));
  const others = tokens.filter((token) => !('user_ids' in token));
  return users.length === 0 ? others : [...others, { user_ids: [...new Set(users)] }];
}

function tokenKey(token: NotificationRecipientValue): string {
  if ('user_ids' in token) return `user:${token.user_ids.join(',')}`;
  if ('group_id' in token) return `group:${token.group_id}`;
  if ('field' in token) return `field:${token.field}`;
  if ('step' in token) return `step:${token.step}:${token.path ?? ''}`;
  return `trigger:${token.trigger}`;
}

/** What a picked item of the menu stands for (`ref` carries an encoded value). */
function decode(expression: string): NotificationRecipientValue | null {
  const [kind, ...rest] = expression.split(':');
  const value = rest.join(':');
  switch (kind) {
    case 'user':
      return { user_ids: [value as `usr_${string}`] };
    case 'group':
      return { group_id: value as `grp_${string}` };
    case 'field':
      return { field: value as `fld_${string}` };
    case 'trigger':
      return { trigger: 'clicked_by' };
    case 'step': {
      const [stepId, ...path] = value.split(':');
      return { step: stepId ?? '', path: path.join(':') };
    }
    default:
      return null;
  }
}

/**
 * `send_notification` (T515/T522, ADR-32 §1; board "S5 · Email template
 * editor" — the shared settings of the other send steps): who receives it
 * (people fields of the trigger record, fixed users, groups, the person who
 * clicked, a person of an earlier step's record), a one-line title and a
 * plain-text body (templates on the trigger record and records created or
 * updated before — never `find_records` data nor `digest`), the record it
 * links to, and whether the person behind the event is left out. Only
 * recipients who can read the record and every field used receive it.
 */
export function SendNotificationPanel({
  action,
  definition,
  scope,
  onChange,
}: SendNotificationPanelProps) {
  const { t } = useTranslation('automationEmail');
  const { t: tb } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  const chipText = useChipText();
  const id = useId();
  const step = action.id as StepKey;
  const config = action.config;
  const [picking, setPicking] = useState(false);
  const [expression, setExpression] = useState<((stored: string) => void) | null>(null);
  const members = useQuery(orgMembersQuery(env.orgId));
  const groups = useQuery(orgGroupsQuery(env.orgId));
  const set = (patch: Partial<SendNotificationConfig>) => {
    onChange({ ...action, config: { ...config, ...patch } });
  };

  // Templates may read the trigger record and records of earlier create/update steps.
  const textScope: ValueScope = {
    ...scope,
    steps: scope.steps.filter((item) => RECORD_STEPS.has(item.type)),
  };
  const sections = pickerSections({
    scope: textScope,
    names: env,
    tableName: env.tableName,
    mode: 'template',
    t: tb,
  });
  const titleChips = useTemplateChips(config.title.template, textScope);
  const bodyChips = useTemplateChips(config.body.template, textScope);

  const tokens = tokensOf(config.recipients);
  const userName = (userId: string) =>
    members.data?.items.find((member) => member.user.id === userId)?.user.display_name ??
    t('notification.unknownUser');
  const groupName = (groupId: string) =>
    groups.data?.items.find((group) => group.id === groupId)?.name ??
    t('notification.unknownGroup');
  const nameOf = (
    token: NotificationRecipientValue,
  ): { text: string; tone: ChipTone | 'user' | 'group' } => {
    if ('user_ids' in token) return { text: userName(token.user_ids[0] ?? ''), tone: 'user' };
    if ('group_id' in token) return { text: groupName(token.group_id), tone: 'group' };
    if ('step' in token && token.path?.startsWith('records[0].fields.') === true) {
      const fieldId = token.path.slice('records[0].fields.'.length);
      const owner = scope.steps.find((item) => item.id === token.step);
      const field =
        owner === undefined || owner.tableId === null
          ? undefined
          : env.fieldsOf(owner.tableId)?.find((item) => item.id === fieldId);
      if (owner !== undefined && field !== undefined) {
        return {
          text: t('recipients.stepField', { number: owner.number, field: field.name }),
          tone: 'step',
        };
      }
    }
    const name = sourceNameOf(token, scope, env);
    return { text: chipText(name), tone: name.tone };
  };
  const taken = new Set(tokens.map(tokenKey));

  const recipientSections: PickerSection[] = [];
  if (scope.triggerTableId !== null && hasTriggerRecord(definition.trigger)) {
    const items = (env.fieldsOf(scope.triggerTableId) ?? [])
      .filter((field) => USER_FIELD_TYPES.has(field.type))
      .map((field) => ({
        key: `field:${field.id}`,
        label: field.name,
        tone: 'field' as const,
        pick: { kind: 'ref' as const, expression: `field:${field.id}` },
      }));
    if (items.length > 0) {
      recipientSections.push({
        key: 'record',
        title: tb('picker.record', { table: env.tableName(scope.triggerTableId) ?? '' }),
        items,
      });
    }
  }
  if (definition.trigger.type === 'button.clicked') {
    recipientSections.push({
      key: 'trigger',
      title: tb('picker.trigger'),
      items: [
        {
          key: 'trigger:clicked_by',
          label: tb('chip.trigger.clicked_by'),
          tone: 'trigger',
          pick: { kind: 'ref', expression: 'trigger:clicked_by' },
        },
      ],
    });
  }
  const stepItems = scope.steps.flatMap((item) => {
    if (item.type !== 'find_records' || item.tableId === null) return [];
    return (env.fieldsOf(item.tableId) ?? [])
      .filter((field) => USER_FIELD_TYPES.has(field.type))
      .map((field) => ({
        key: `step:${item.id}:${field.id}`,
        label: t('recipients.stepField', { number: item.number, field: field.name }),
        tone: 'step' as const,
        pick: {
          kind: 'ref' as const,
          expression: `step:${item.id}:records[0].fields.${field.id}`,
        },
      }));
  });
  if (stepItems.length > 0) {
    recipientSections.push({ key: 'steps', title: tb('picker.steps'), items: stepItems });
  }
  recipientSections.push(
    {
      key: 'users',
      title: t('notification.users'),
      items: (members.data?.items ?? [])
        .filter((member) => !taken.has(`user:${member.user.id}`))
        .map((member) => ({
          key: `user:${member.user.id}`,
          label: member.user.display_name,
          hint: member.user.email,
          tone: 'trigger' as const,
          pick: { kind: 'ref' as const, expression: `user:${member.user.id}` },
        })),
    },
    {
      key: 'groups',
      title: t('notification.groups'),
      items: (groups.data?.items ?? []).map((group) => ({
        key: `group:${group.id}`,
        label: group.name,
        hint: t('notification.members', { count: group.member_count }),
        tone: 'step' as const,
        pick: { kind: 'ref' as const, expression: `group:${group.id}` },
      })),
    },
  );

  const recipientIssues = issuesOf(env.issues, step).filter((issue) =>
    issue.path.startsWith('config.recipients'),
  );
  const linkSteps = earlierActions(definition, action.id).filter(({ action: earlier }) =>
    RECORD_STEPS.has(earlier.type),
  );
  const linkKey =
    config.link_record === null
      ? 'none'
      : config.link_record === 'trigger'
        ? 'trigger'
        : `step:${config.link_record.step}`;
  const full = tokens.length >= MAX_NOTIFICATION_RECIPIENT_VALUES;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span id={`${id}-recipients`} className="text-label text-fg">
          {t('notification.recipients')}
        </span>
        <div className="relative flex min-w-0 items-start gap-1">
          <div
            className={cn(
              'flex min-h-control min-w-0 flex-1 flex-wrap items-center gap-1 rounded-md border border-line-control bg-surface px-1.5 py-1',
              recipientIssues.length > 0 && 'border-danger',
            )}
            data-testid="notification-recipients"
          >
            {tokens.length === 0 ? (
              <span className="px-1 text-body text-fg-subtle">{t('notification.empty')}</span>
            ) : (
              <ul className="contents" aria-labelledby={`${id}-recipients`}>
                {tokens.map((token, index) => {
                  const { text, tone } = nameOf(token);
                  const Icon = ICONS[tone];
                  return (
                    <li key={`${tokenKey(token)}-${String(index)}`} className="flex min-w-0">
                      <span
                        className={cn(
                          CHIP_CLASS,
                          tone === 'user' || tone === 'group'
                            ? 'border-line bg-surface-sunken text-fg'
                            : CHIP_TONE_CLASS[tone],
                        )}
                      >
                        <Icon aria-hidden="true" className="size-3 shrink-0" />
                        <span className="truncate">{text}</span>
                        <button
                          type="button"
                          className="-mr-0.5 ml-0.5 inline-flex size-4 items-center justify-center rounded-full hover:bg-surface/60"
                          aria-label={t('recipients.remove', { name: text })}
                          onClick={() => {
                            set({
                              recipients: valuesOf(
                                tokens.filter((_, position) => position !== index),
                              ),
                            });
                          }}
                        >
                          <X aria-hidden="true" className="size-3" />
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <Tooltip content={t('notification.add')}>
            <Button
              variant="secondary"
              size="icon"
              className="size-8 max-lg:size-control"
              aria-label={t('notification.add')}
              aria-expanded={picking}
              disabled={full}
              data-testid="notification-add"
              onClick={() => {
                setPicking(true);
              }}
            >
              <Plus aria-hidden="true" />
            </Button>
          </Tooltip>
          {picking ? (
            <ValuePicker
              label={t('notification.add')}
              sections={recipientSections}
              onPick={(picked) => {
                if (picked.kind !== 'ref') return;
                const next = decode(picked.expression);
                if (next === null || taken.has(tokenKey(next))) return;
                set({ recipients: valuesOf([...tokens, next]) });
              }}
              onClose={() => {
                setPicking(false);
              }}
            />
          ) : null}
        </div>
        <p className="text-label font-normal text-fg-muted">
          {t('notification.recipientsHint', { max: MAX_NOTIFICATION_STEP_RECIPIENTS })}
        </p>
        <IssueText id={`${id}-recipient-issues`} issues={recipientIssues} />
      </div>

      <PanelField label={t('notification.title')} step={step} path={PATH_CONFIG_TITLE_TEMPLATE}>
        {(control) => (
          <TemplateInput
            value={config.title.template}
            onChange={(template) => {
              set({ title: { template: template.replace(/[\r\n]+/gu, ' ') } });
            }}
            chipLabel={titleChips}
            sections={sections}
            onExpression={(insert) => {
              setExpression(() => insert);
            }}
            label={t('notification.title')}
            invalid={control['aria-invalid']}
            describedBy={control['aria-describedby']}
            testId={TEST_NOTIFICATION_TITLE}
          />
        )}
      </PanelField>
      <PanelField
        label={t('notification.body')}
        step={step}
        path={PATH_CONFIG_BODY_TEMPLATE}
        hint={t('notification.bodyHint')}
      >
        {(control) => (
          <TemplateInput
            value={config.body.template}
            onChange={(template) => {
              set({ body: { template } });
            }}
            chipLabel={bodyChips}
            sections={sections}
            onExpression={(insert) => {
              setExpression(() => insert);
            }}
            label={t('notification.body')}
            multiline
            invalid={control['aria-invalid']}
            describedBy={control['aria-describedby']}
            testId={TEST_NOTIFICATION_BODY}
          />
        )}
      </PanelField>
      <PanelField label={t('notification.link')} step={step} path={PATH_CONFIG_LINK_RECORD}>
        {(control) => (
          <Select
            {...control}
            value={linkKey}
            data-testid="notification-link"
            onChange={(event) => {
              const next = event.target.value;
              set({
                link_record:
                  next === 'none'
                    ? null
                    : next === 'trigger'
                      ? 'trigger'
                      : { step: next.slice('step:'.length) },
              });
            }}
          >
            {hasTriggerRecord(definition.trigger) ? (
              <option value="trigger">
                {tb('action.triggerRecord', {
                  table:
                    scope.triggerTableId === null
                      ? ''
                      : (env.tableName(scope.triggerTableId) ?? ''),
                })}
              </option>
            ) : null}
            {linkSteps.map(({ action: earlier, number }) => (
              <option key={earlier.id} value={`step:${earlier.id}`}>
                {tb('action.stepRecord', {
                  number,
                  type: tb(`actionType.${earlier.type}` as 'actionType.if'),
                })}
              </option>
            ))}
            <option value="none">{t('notification.noLink')}</option>
          </Select>
        )}
      </PanelField>
      <div className="flex items-start gap-2">
        <Switch
          id={`${id}-skip`}
          checked={config.skip_actor}
          aria-describedby={`${id}-skip-hint`}
          data-testid="notification-skip-actor"
          onChange={(event) => {
            set({ skip_actor: event.target.checked });
          }}
        />
        <span className="flex flex-col gap-0.5">
          <label htmlFor={`${id}-skip`} className="text-body">
            {t('notification.skipActor')}
          </label>
          <span id={`${id}-skip-hint`} className="text-label font-normal text-fg-muted">
            {t('notification.skipActorHint')}
          </span>
        </span>
      </div>
      <Note testId={TEST_NOTIFICATION_NOTE}>{t('notification.permissions')}</Note>
      {expression === null ? null : (
        <ExpressionDialog
          baseId={env.base.id}
          scope={textScope}
          onCancel={() => {
            setExpression(null);
          }}
          onInsert={(stored) => {
            expression(stored);
            setExpression(null);
          }}
        />
      )}
    </div>
  );
}
