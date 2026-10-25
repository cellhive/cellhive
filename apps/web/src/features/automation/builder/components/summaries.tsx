import { useQuery } from '@tanstack/react-query';
import { Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { isAutomationValue } from '../../../../lib/automation/condition-editor';
import { summarizeTrigger } from '../../list/model/summary';
import { baseEmailIdentitiesQuery } from '../actions/send-email/queries';
import { isUnset } from '../model/draft';
import { chipNameOf, sourceNameOf, type ValueScope } from '../model/scope';
import { isEmptyValue, templateSegments } from '../model/values';

import { useBuilderEnv } from './env';
import { Chip } from './values/chips';
import { useTemplateDisplays } from './values/use-template-chips';

import type {
  AutomationAction,
  AutomationDefinition,
  AutomationValue,
  EmailRecipientValue,
  FieldDto,
} from '@cellhive/contracts';
import type { TFunction } from 'i18next';

/** "2 days", "90 minutes" (largest whole unit). */
function durationText(t: TFunction<'automationBuilder'>, minutes: number): string {
  if (minutes % 1_440 === 0) return t('summary.days', { count: minutes / 1_440 });
  if (minutes % 60 === 0) return t('summary.hours', { count: minutes / 60 });
  return t('summary.minutes', { count: minutes });
}

/** At most this many items of a list are spelt out on a card ("+N" after). */
const SHOWN = 3;

function useFieldName() {
  const env = useBuilderEnv();
  // `null`: no such field (deleted or not readable); `undefined`: fields still loading.
  return (tableId: string | null, fieldId: string): string | null | undefined => {
    if (tableId === null) return null;
    const fields = env.fieldsOf(tableId);
    if (fields === undefined) return undefined;
    return fields.find((field) => field.id === fieldId)?.name ?? null;
  };
}

function optionName(field: FieldDto | undefined, id: unknown): string | null {
  const options = (field?.options as { options?: { id: string; name: string }[] } | undefined)
    ?.options;
  return options?.find((option) => option.id === id)?.name ?? null;
}

/** A literal as short text (option ids by name, people by count). */
function literalText(value: unknown, field: FieldDto | undefined, yes: string, no: string): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? yes : no;
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        typeof item === 'object' && item !== null && 'id' in item
          ? (item as { id: string }).id
          : (optionName(field, item) ?? JSON.stringify(item)),
      )
      .join(', ');
  }
  if (typeof value === 'object') return '…';
  return optionName(field, value) ?? (typeof value === 'string' ? value : JSON.stringify(value));
}

/** A value on a card: chips for sources and placeholders, text for the rest. */
export function ValueSummary({
  value,
  scope,
  field,
}: {
  readonly value: AutomationValue | undefined;
  readonly scope: ValueScope;
  readonly field?: FieldDto | undefined;
}) {
  const { t } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  if (value === undefined) return <em className="text-fg-muted">{t('summary.empty')}</em>;
  if ('field' in value || 'trigger' in value || 'step' in value) {
    return <Chip name={sourceNameOf(value, scope, env)} />;
  }
  if ('literal' in value) {
    return (
      <strong className="font-semibold">
        {literalText(value.literal, field, t('values.checked'), t('values.unchecked'))}
      </strong>
    );
  }
  if ('digest' in value) return <span>{t('values.digest')}</span>;
  return <TemplateSummary template={value.template} scope={scope} />;
}

/**
 * A template on a card: text and chips; a formula chip by the names the
 * server gives it (`[Số tiền] + 1`), never by the stored field ids (T527).
 */
function TemplateSummary({
  template,
  scope,
}: {
  readonly template: string;
  readonly scope: ValueScope;
}) {
  const env = useBuilderEnv();
  const displays = useTemplateDisplays(template, scope);
  const segments = templateSegments(template);
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === 'text') return <Fragment key={index}>{segment.text}</Fragment>;
        // Its position among the placeholders (the server's `index`).
        const at = segments.slice(0, index).filter((item) => item.kind === 'ref').length;
        const shown = displays?.find((item) => item.index === at)?.display;
        return <Chip key={index} name={chipNameOf(segment.expression, scope, env, shown)} />;
      })}
    </>
  );
}

/** "Field = value, …" of a field map. */
function FieldValues({
  tableId,
  fields,
  scope,
}: {
  readonly tableId: string;
  readonly fields: Readonly<Record<string, AutomationValue | undefined>>;
  readonly scope: ValueScope;
}) {
  const { t } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  const entries = Object.entries(fields);
  if (entries.length === 0) return <span>{t('summary.noValues')}</span>;
  const all = env.fieldsOf(tableId) ?? [];
  return (
    <>
      {entries.slice(0, SHOWN).map(([fieldId, value], index) => {
        const field = all.find((item) => item.id === fieldId);
        return (
          <Fragment key={fieldId}>
            {index === 0 ? null : <br />}
            {field?.name ?? t('chip.ref')} ={' '}
            <ValueSummary value={value} scope={scope} field={field} />
          </Fragment>
        );
      })}
      {entries.length > SHOWN ? (
        <>
          <br />
          {t('summary.more', { count: entries.length - SHOWN })}
        </>
      ) : null}
    </>
  );
}

/** Top-level conditions of a filter: "Field operator value" lines. */
export function FilterSummary({
  filter,
  tableId,
  scope,
}: {
  readonly filter: Readonly<Record<string, unknown>> | null;
  readonly tableId: string | null;
  /** Values from the automation in the filter (`update_records`) show as chips. */
  readonly scope?: ValueScope | undefined;
}) {
  const { t } = useTranslation(['automationBuilder', 'toolbar']);
  const fieldName = useFieldName();
  const env = useBuilderEnv();
  if (filter === null || Object.keys(filter).length === 0) {
    return <span>{t('summary.noConditions')}</span>;
  }
  const items = Array.isArray(filter['items']) ? (filter['items'] as unknown[]) : [filter];
  const lines: ReactNode[] = [];
  for (const item of items.slice(0, SHOWN)) {
    if (typeof item !== 'object' || item === null || !('field' in item)) {
      lines.push(t('summary.group'));
      continue;
    }
    const condition = item as { field: string; operator: string; value?: unknown };
    const field =
      tableId === null ? undefined : env.fieldsOf(tableId)?.find((f) => f.id === condition.field);
    const name = fieldName(tableId, condition.field);
    lines.push(
      <>
        {name === null ? (
          <Chip name={{ tone: 'error', ref: condition.field }} />
        ) : (
          <Chip name={{ tone: 'field', field: name ?? '…' }} />
        )}{' '}
        {t(`toolbar:filter.operators.${condition.operator}` as 'toolbar:filter.operators.is')}
        {condition.value === undefined ? null : scope !== undefined &&
          isAutomationValue(condition.value) ? (
          <>
            {' '}
            <ValueSummary value={condition.value as AutomationValue} scope={scope} />
          </>
        ) : (
          <>
            {' '}
            <strong className="font-semibold">
              {literalText(condition.value, field, t('values.checked'), t('values.unchecked'))}
            </strong>
          </>
        )}
      </>,
    );
  }
  return (
    <>
      {lines.map((line, index) => (
        <Fragment key={index}>
          {index === 0 ? null : <br />}
          {line}
        </Fragment>
      ))}
      {items.length > SHOWN ? (
        <>
          <br />
          {t('summary.more', { count: items.length - SHOWN })}
        </>
      ) : null}
    </>
  );
}

/** Title and details of the trigger card (board: "When a record is updated in Orders"). */
export function useTriggerSummary(definition: AutomationDefinition): {
  title: string;
  body: ReactNode;
} {
  const { t, i18n } = useTranslation('automation');
  const tb = useTranslation('automationBuilder').t;
  const env = useBuilderEnv();
  const fieldName = useFieldName();
  const trigger = definition.trigger;
  const summary = summarizeTrigger(
    { definition },
    {
      table: env.tableName,
      field: (tableId, fieldId) => fieldName(tableId, fieldId) ?? undefined,
      view: (viewId) => env.forms.find((view) => view.id === viewId)?.name,
      hook: env.webhookName,
    },
    t,
    i18n.language,
  );
  const lines: ReactNode[] = [];
  if (trigger.type === 'record.updated') {
    lines.push(
      <>
        {tb('summary.watching')}{' '}
        {trigger.watch_fields.length === 0 ? (
          <em>{tb('summary.empty')}</em>
        ) : (
          trigger.watch_fields.map((fieldId) => {
            const name = fieldName(trigger.table_id, fieldId);
            return (
              <Fragment key={fieldId}>
                <Chip
                  name={
                    name === null
                      ? { tone: 'error', ref: fieldId }
                      : { tone: 'field', field: name ?? '…' }
                  }
                />{' '}
              </Fragment>
            );
          })
        )}
      </>,
    );
  } else if (summary.detail !== null) {
    lines.push(summary.detail);
  }
  if ('skip_bulk' in trigger && trigger.skip_bulk) lines.push(tb('trigger.skipBulk'));
  return {
    title: summary.label,
    body: (
      <>
        {lines.map((line, index) => (
          <Fragment key={index}>
            {index === 0 ? null : <br />}
            {line}
          </Fragment>
        ))}
      </>
    ),
  };
}

/** Title and details of an action card. */
export function useActionSummary(
  action: AutomationAction,
  scope: ValueScope,
): { title: string; body: ReactNode } {
  const { t, i18n } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  const title = t(`actionType.${action.type}` as 'actionType.if');
  switch (action.type) {
    case 'create_record':
      return {
        title,
        body: isUnset(action.config.table_id) ? (
          <em>{t('summary.chooseTable')}</em>
        ) : (
          <>
            {t('summary.in', { table: env.tableName(action.config.table_id) ?? '' })}
            <br />
            <FieldValues
              tableId={action.config.table_id}
              fields={action.config.fields}
              scope={scope}
            />
          </>
        ),
      };
    case 'update_record': {
      const target = action.config.record_id;
      const which =
        target === null
          ? t('summary.triggerRecord', { table: env.tableName(action.config.table_id) ?? '' })
          : 'step' in target
            ? t('summary.stepRecord', {
                number: scope.steps.find((step) => step.id === target.step)?.number ?? '?',
              })
            : t('action.otherRecord');
      return {
        title,
        body: (
          <>
            {which}
            <br />
            {isUnset(action.config.table_id) ? null : (
              <FieldValues
                tableId={action.config.table_id}
                fields={action.config.fields}
                scope={scope}
              />
            )}
          </>
        ),
      };
    }
    case 'find_records':
      return {
        title,
        body: isUnset(action.config.table_id) ? (
          <em>{t('summary.chooseTable')}</em>
        ) : (
          <>
            {t('summary.find', {
              table: env.tableName(action.config.table_id) ?? '',
              count: action.config.limit,
            })}
            <br />
            <FilterSummary filter={action.config.filter} tableId={action.config.table_id} />
          </>
        ),
      };
    case 'delete_record':
      return {
        title,
        body: t('summary.delete', {
          table: scope.triggerTableId === null ? '' : (env.tableName(scope.triggerTableId) ?? ''),
        }),
      };
    case 'update_records':
      return {
        title,
        body: isUnset(action.config.table_id) ? (
          <em>{t('summary.chooseTable')}</em>
        ) : (
          <>
            {t('summary.updateMany', {
              table: env.tableName(action.config.table_id) ?? '',
              count: action.config.limit,
              formatted: new Intl.NumberFormat(i18n.language).format(action.config.limit),
            })}
            <br />
            <FilterSummary
              filter={action.config.filter}
              tableId={action.config.table_id}
              scope={scope}
            />
            <br />
            <FieldValues
              tableId={action.config.table_id}
              fields={action.config.fields}
              scope={scope}
            />
          </>
        ),
      };
    case 'delay': {
      const minutes = action.config.minutes;
      const wait =
        minutes !== null ? (
          t('summary.waitFor', { duration: durationText(t, minutes) })
        ) : (
          <>
            {t('summary.waitUntil')}{' '}
            <ValueSummary value={action.config.until ?? undefined} scope={scope} />
          </>
        );
      return {
        title:
          minutes !== null ? t('summary.waitTitle', { duration: durationText(t, minutes) }) : title,
        body: (
          <>
            {wait}
            {action.config.recheck_condition === null ? null : (
              <>
                <br />
                {t('summary.recheck')}{' '}
                <FilterSummary
                  filter={action.config.recheck_condition}
                  tableId={scope.triggerTableId}
                  scope={scope}
                />
              </>
            )}
          </>
        ),
      };
    }
    case 'send_telegram': {
      const chat = action.config.chat_id;
      return {
        title,
        body:
          'literal' in chat && chat.literal === '' ? (
            <em>{t('summary.telegramChoose')}</em>
          ) : (
            <>
              {t('summary.telegramTo')} <ValueSummary value={chat} scope={scope} />
            </>
          ),
      };
    }
    case 'if':
      return {
        title,
        body: (
          <>
            {t(action.config.match === 'or' ? 'summary.ifAny' : 'summary.ifAll', {
              count: action.config.conditions.length,
            })}
            {action.config.on_false === 'stop' ? (
              <>
                <br />
                {t('summary.ifStop')}
              </>
            ) : null}
          </>
        ),
      };
    case 'send_email':
      return { title, body: <EmailSummary action={action} scope={scope} /> };
    case 'send_notification':
      return {
        title,
        body: (
          <>
            {t('summary.notifyTo', { count: action.config.recipients.length })}
            <br />
            {action.config.title.template === '' ? (
              <em>{t('summary.empty')}</em>
            ) : (
              <ValueSummary value={{ template: action.config.title.template }} scope={scope} />
            )}
          </>
        ),
      };
    case 'http_request':
    case 'run_n8n_workflow':
      // (T613) Method and URL (the n8n preset always POSTs).
      return {
        title,
        body: isEmptyValue(action.config.url) ? (
          <em>{t('summary.urlChoose')}</em>
        ) : (
          <span className="break-all">
            <span className="font-code text-label font-semibold">
              {action.type === 'http_request' ? action.config.method : 'POST'}
            </span>{' '}
            <ValueSummary value={action.config.url} scope={scope} />
          </span>
        ),
      };
    default:
      return { title, body: t('summary.comingSoon') };
  }
}

/** Recipients of a list, short: addresses as text, fields and steps as chips. */
function Recipients({
  values,
  scope,
}: {
  readonly values: readonly EmailRecipientValue[];
  readonly scope: ValueScope;
}) {
  const { t } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  const items = values.flatMap((value) =>
    'literal' in value && Array.isArray(value.literal)
      ? value.literal.map((literal) => ({ literal }))
      : [value],
  );
  if (items.length === 0) return <em>{t('summary.empty')}</em>;
  return (
    <>
      {items.slice(0, SHOWN).map((value, index) => (
        <Fragment key={index}>
          {index === 0 ? null : ', '}
          {'literal' in value ? (
            <span className="text-fg">{String(value.literal)}</span>
          ) : (
            <Chip name={sourceNameOf(value, scope, env)} />
          )}
        </Fragment>
      ))}
      {items.length > SHOWN ? ` ${t('summary.more', { count: items.length - SHOWN })}` : null}
    </>
  );
}

/**
 * (T522) A `send_email` card: sender, To, subject; on phones (read only,
 * FRONTEND §13.2) also Cc, files and footer — the board's 375 px view.
 */
function EmailSummary({
  action,
  scope,
}: {
  readonly action: Extract<AutomationAction, { type: 'send_email' }>;
  readonly scope: ValueScope;
}) {
  const { t } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  const identities = useQuery({ ...baseEmailIdentitiesQuery(env.base.id) });
  const config = action.config;
  const identity = identities.data?.items.find((item) => item.id === config.identity_id);
  const sender =
    config.identity_id === null
      ? t('summary.email.system')
      : identity === undefined
        ? t('summary.email.identity')
        : `${identity.display_name} <${identity.email}>`;
  const files = (env.fieldsOf(scope.triggerTableId ?? '') ?? []).filter((field) =>
    config.attachments.some((item) => item.field === field.id),
  );
  return (
    <>
      {t('summary.email.from', { sender })}
      <br />
      {t('summary.email.to')} <Recipients values={config.to} scope={scope} />
      {env.readOnly && config.cc.length > 0 ? (
        <>
          <br />
          {t('summary.email.cc')} <Recipients values={config.cc} scope={scope} />
        </>
      ) : null}
      <br />
      {t('summary.email.subject')}{' '}
      {config.subject.template === '' ? (
        <em>{t('summary.empty')}</em>
      ) : (
        <ValueSummary value={{ template: config.subject.template }} scope={scope} />
      )}
      {env.readOnly && files.length > 0 ? (
        <>
          <br />
          {t('summary.email.files', { names: files.map((field) => field.name).join(', ') })}
        </>
      ) : null}
      {env.readOnly ? (
        <>
          <br />
          {t(`summary.email.footer.${config.footer}`)}
          {config.include_signature ? ` · ${t('summary.email.signature')}` : ''}
        </>
      ) : null}
    </>
  );
}
