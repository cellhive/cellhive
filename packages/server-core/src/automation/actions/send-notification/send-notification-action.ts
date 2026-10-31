import {
  AUTOMATION_MESSAGES_PER_HOUR,
  automationDefinitionSchema,
  MAX_NOTIFICATION_STEP_RECIPIENTS,
  TEMPLATE_OUTPUT_LIMITS,
  type AutomationDefinition,
  type AutomationMessageData,
  type Id,
  type NotificationSkipReason,
  type SendNotificationConfig,
  type SendNotificationStepOutput,
} from '@cellhive/contracts';

import { GroupMembersRepository } from '../../../db/repositories/groups.repository.js';
import { withTxScope } from '../../../db/repository.js';
import { EventsRepository } from '../../../events/events.repository.js';
import {
  loadMemberAccessBase,
  resolveMemberBaseAccess,
  type AccessDefaults,
  type MemberBaseAccess,
} from '../../../import/member-access.js';
import {
  NotificationWriter,
  type PreparedNotification,
} from '../../../notifications/notification-writer.js';
import { flattenActions } from '../../definition/validate.js';
import { AutomationStepError } from '../../engine/errors.js';
import { loadAutomationSchema } from '../../engine/schema-context.js';
import { AutomationRunsRepository } from '../../repository/automation-runs.repository.js';
import { AutomationsRepository } from '../../repository/automations.repository.js';
import { escapeHeader, truncateText } from '../../values/escape.js';
import { recordQueryReader } from '../../values/record-reader.js';
import {
  definitionSources,
  stepRecordId,
  stepRecordTable,
  TRIGGER_REFERENCES,
} from '../../values/references.js';
import { RecipientMembersRepository } from '../send-email/recipient-members.repository.js';
import { recipientPartsOf } from '../send-email/recipients.js';

import {
  AutomationMessageQuotaRepository,
  SUMMARY_GROUP_KEY_PREFIX,
} from './message-quota.repository.js';
import { permissionProfileKey } from './permission-profile.js';
import {
  notificationReferences,
  withTextStepSources,
  type NotificationReferences,
} from './references.js';
import { summaryBody, summaryTitle } from './summary-text.js';

import type { Db } from '../../../db/create-db.js';
import type { OrgScope } from '../../../db/repository.js';
import type { JsonObject, JsonValue } from '../../../db/schema.js';
import type { RecordQueryService } from '../../../records/record-query.service.js';
import type {
  AutomationActionContext,
  AutomationActionHandler,
  AutomationActionResult,
} from '../../engine/action-registry.js';
import type { AutomationValueEvaluator, TemplateWarning } from '../../values/evaluator.js';

/**
 * The `send_notification` handler of the run engine (SPEC §11.5, BACKLOG
 * T515, ADR-32 §1). One attempt:
 *
 * 1. **Recipients**: `user` fields of the trigger record, earlier step
 *    outputs and `clicked_by` resolved as `run_as`; fixed users; groups
 *    expanded. More than {@link MAX_NOTIFICATION_STEP_RECIPIENTS} distinct
 *    users → the step fails with `too_many_recipients`, nothing is sent.
 *    `skip_actor` leaves out the user behind the trigger event.
 * 2. **Access, per recipient, now**: an active member who reads the base,
 *    the linked record, every record the text starts from and every field
 *    the title and body use (whatever `run_as` reads). The others are left
 *    out and listed in the step output (`user_id` + reason, no value).
 * 3. **Render once per permission profile** (`permissionProfileKey`): the
 *    title (one line, ≤ 200) and body (plain text, ≤ 2,000) are rendered
 *    with that group's schema and records — link titles and lookups as the
 *    recipients see them (P20, P35), never as `run_as`.
 * 4. **Write** in one transaction with the step (`complete`): one
 *    `automation.message` per recipient through `NotificationWriter`
 *    (preferences, base mutes, email queue, realtime after commit),
 *    `group_key = <run_id>:<action_id>` so a retried step never doubles.
 *    A recipient who already received {@link AUTOMATION_MESSAGES_PER_HOUR}
 *    messages in the past hour gets, instead, one summary per automation
 *    and hour, replaced by a new one with the count + 1 on each message.
 *
 * The step output holds counts, ids and reasons — never the title or body.
 */

export interface SendNotificationActionDeps {
  readonly db: Db;
  readonly query: RecordQueryService;
  readonly defaults: AccessDefaults;
  /** The instance has SMTP: emails are queued by the recipients' choices (T512). */
  readonly emailEnabled: boolean;
  readonly emailBatchMs?: number;
  /** Wait of the Telegram batch (T550; default 5 seconds). */
  readonly telegramBatchMs?: number;
  readonly now?: () => Date;
}

type Config = SendNotificationConfig;

/** A group of recipients sharing one permission profile. */
interface ProfileGroup {
  readonly access: MemberBaseAccess;
  readonly userIds: Id<'usr'>[];
}

interface RecordRef {
  readonly tableId: Id<'tbl'>;
  readonly recordId: Id<'rec'>;
}

interface Rendered {
  readonly title: string;
  readonly body: string;
}

const HOUR_MS = 60 * 60 * 1000;

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function createSendNotificationAction(
  deps: SendNotificationActionDeps,
): AutomationActionHandler {
  const now = deps.now ?? (() => new Date());
  const writer = new NotificationWriter(deps.db, {
    emailEnabled: deps.emailEnabled,
    ...(deps.emailBatchMs === undefined ? {} : { emailBatchMs: deps.emailBatchMs }),
    ...(deps.telegramBatchMs === undefined ? {} : { telegramBatchMs: deps.telegramBatchMs }),
  });
  const runs = new AutomationRunsRepository(deps.db);
  const automations = new AutomationsRepository(deps.db);
  const events = new EventsRepository(deps.db);
  const groups = new GroupMembersRepository(deps.db);
  const members = new RecipientMembersRepository(deps.db);
  const quota = new AutomationMessageQuotaRepository(deps.db);

  /** Users named by the recipient values, groups expanded, distinct and sorted. */
  async function recipientsOf(
    scope: OrgScope,
    config: Config,
    values: AutomationValueEvaluator,
  ): Promise<Id<'usr'>[]> {
    const userIds: Id<'usr'>[] = [];
    const groupIds: Id<'grp'>[] = [];
    for (const value of config.recipients) {
      if ('user_ids' in value) userIds.push(...value.user_ids);
      else if ('group_id' in value) groupIds.push(value.group_id);
      else {
        const resolved = await values.resolve(value);
        userIds.push(...recipientPartsOf(resolved.value).userIds);
      }
    }
    if (groupIds.length > 0) userIds.push(...(await groups.userIdsOfGroups(scope, groupIds)));
    return [...new Set(userIds)].sort();
  }

  return {
    async execute(context: AutomationActionContext): Promise<AutomationActionResult> {
      const { action, scope, run } = context;
      if (action.type !== 'send_notification') {
        throw new TypeError('send_notification handler: wrong action');
      }
      const config = action.config;
      const [runRow, automation] = await Promise.all([
        runs.get(scope, run.id),
        automations.get(scope, run.automationId),
      ]);
      const input = isObject(runRow?.input) ? runRow.input : {};
      const parsed = automationDefinitionSchema.safeParse(input['definition']);
      if (!parsed.success) throw new TypeError('send_notification: run without definition');
      const definition = parsed.data;
      const trigger = isObject(input['trigger']) ? input['trigger'] : {};

      // 1. Recipients.
      const candidates = await recipientsOf(scope, config, context.values);
      if (candidates.length > MAX_NOTIFICATION_STEP_RECIPIENTS) {
        throw new AutomationStepError('too_many_recipients', 'Too many recipients.', {
          params: { count: candidates.length, limit: MAX_NOTIFICATION_STEP_RECIPIENTS },
        });
      }
      const skipped: { user_id: Id<'usr'>; reason: NotificationSkipReason }[] = [];
      let addressed = candidates;
      if (config.skip_actor) {
        const actor = await actorOf(scope, trigger);
        if (actor !== null && addressed.includes(actor)) {
          addressed = addressed.filter((id) => id !== actor);
          skipped.push({ user_id: actor, reason: 'actor' });
        }
      }

      // The linked record and what the text reads.
      const triggerTableId = run.triggerRecordId === null ? null : run.triggerTableId;
      const link = await linkOf(config, definition, context, triggerTableId);
      const flat = flattenActions(definition.actions).map((item) => item.action);
      const sources = definitionSources(definition, flat, triggerTableId);
      const references = withTextStepSources(
        notificationReferences(
          [config.title.template, config.body.template],
          context.schema,
          triggerTableId,
          {
            trigger: TRIGGER_REFERENCES[definition.trigger.type],
            steps: sources.steps,
            ...(sources.texts === undefined ? {} : { texts: sources.texts }),
          },
        ),
        flat,
        triggerTableId,
      );
      const required = await requiredRecords(context, link, references, sources.steps);

      // 2. Access of each recipient, grouped by permission profile.
      const shared = await loadMemberAccessBase(deps.db, scope, run.baseId);
      const active = await members.activeMembers(scope, addressed);
      const profiles = new Map<string, ProfileGroup>();
      for (const userId of addressed) {
        if (!active.has(userId)) {
          skipped.push({ user_id: userId, reason: 'not_member' });
          continue;
        }
        const access =
          shared === undefined
            ? undefined
            : await resolveMemberBaseAccess(
                deps.db,
                scope,
                { userId, baseId: run.baseId },
                deps.defaults,
                shared,
              );
        if (access === undefined || shared === undefined) {
          skipped.push({ user_id: userId, reason: 'cannot_read_base' });
          continue;
        }
        const key = permissionProfileKey(access, shared.base.permission_version);
        const group = profiles.get(key);
        if (group === undefined) profiles.set(key, { access, userIds: [userId] });
        else group.userIds.push(userId);
      }

      // 3. Check and render once per group.
      const warnings: TemplateWarning[] = [];
      const allowed: { userId: Id<'usr'>; locale: string; rendered: Rendered }[] = [];
      let renderedGroups = 0;
      for (const group of profiles.values()) {
        const groupAccess = group.access.record.resolved.access;
        const schema = await loadAutomationSchema(
          deps.db,
          scope,
          run.baseId,
          groupAccess,
          shared?.base.settings,
        );
        const reader = recordQueryReader(deps.query, scope, group.access.record);
        let reason: NotificationSkipReason | null = null;
        for (const record of required) {
          const found =
            groupAccess.tables[record.tableId] === undefined
              ? []
              : await reader.read(record.tableId, [record.recordId], []);
          if (found.length === 0) {
            reason = 'cannot_read_record';
            break;
          }
        }
        if (reason === null) {
          for (const [fieldId, tableId] of references.fields) {
            if (
              groupAccess.tables[tableId]?.fields[fieldId] === undefined ||
              schema.lockedFieldIds?.has(fieldId) === true
            ) {
              reason = 'cannot_read_field';
              break;
            }
          }
        }
        if (reason !== null) {
          for (const userId of group.userIds) skipped.push({ user_id: userId, reason });
          continue;
        }
        const values = context.values.withAccess(schema, reader);
        const title = await values.renderTemplate(config.title.template, {
          context: 'header',
          maxLength: TEMPLATE_OUTPUT_LIMITS.notification_title,
        });
        const body = await values.renderTemplate(config.body.template, {
          context: 'plain',
          maxLength: TEMPLATE_OUTPUT_LIMITS.notification_body,
        });
        warnings.push(...title.warnings, ...body.warnings);
        renderedGroups += 1;
        const rendered: Rendered = {
          // An empty title (every value empty) falls back to the automation name.
          title:
            title.text.trim() === ''
              ? truncateText(
                  escapeHeader(automation?.name ?? '') || '…',
                  TEMPLATE_OUTPUT_LIMITS.notification_title,
                ).text
              : title.text,
          body: body.text,
        };
        for (const userId of group.userIds) {
          allowed.push({ userId, locale: group.access.record.locale, rendered });
        }
      }

      // 4. The hourly cap, then one transaction with the step.
      const at = now();
      const counts = await quota.countSince(
        scope,
        allowed.map((item) => item.userId),
        new Date(at.getTime() - HOUR_MS),
      );
      const direct = allowed.filter(
        (item) => (counts.get(item.userId) ?? 0) < AUTOMATION_MESSAGES_PER_HOUR,
      );
      const over = allowed.filter(
        (item) => (counts.get(item.userId) ?? 0) >= AUTOMATION_MESSAGES_PER_HOUR,
      );
      const entity =
        link === null
          ? ({ entityType: 'automation', entityId: run.automationId, tableId: null } as const)
          : ({ entityType: 'record', entityId: link.recordId, tableId: link.tableId } as const);
      const automationName = automation?.name ?? '';
      const summaryKey = `${SUMMARY_GROUP_KEY_PREFIX}${run.automationId}:${at
        .toISOString()
        .slice(0, 13)}`;

      const output = await deps.db.withTx(async (tx) => {
        const txScope = withTxScope(scope, tx);
        const prepared: PreparedNotification[] = direct.map((item) => ({
          userId: item.userId,
          type: 'automation.message',
          baseId: run.baseId,
          tableId: entity.tableId,
          entityType: entity.entityType,
          entityId: entity.entityId,
          actor: { type: 'automation', id: run.automationId },
          groupKey: `${run.id}:${action.id}`,
          data: messageData({
            automation_id: run.automationId,
            run_id: run.id,
            title: item.rendered.title,
            body: item.rendered.body,
          }),
        }));
        // Past the cap: the summary of this automation and hour, replaced with the new count.
        const existing = await quota.lockSummaries(
          txScope,
          over.map((item) => item.userId),
          summaryKey,
        );
        await quota.deleteSummaries(
          txScope,
          [...existing.values()].map((row) => row.id),
        );
        for (const item of over) {
          const previous = existing.get(item.userId)?.payload;
          const counted = isObject(previous) ? previous['summary_count'] : undefined;
          const count = (typeof counted === 'number' ? counted : 0) + 1;
          prepared.push({
            userId: item.userId,
            type: 'automation.message',
            baseId: run.baseId,
            tableId: null,
            entityType: 'automation',
            entityId: run.automationId,
            actor: { type: 'automation', id: run.automationId },
            groupKey: summaryKey,
            data: messageData({
              automation_id: run.automationId,
              run_id: run.id,
              title: summaryTitle(item.locale, count, automationName),
              body: summaryBody(item.locale, AUTOMATION_MESSAGES_PER_HOUR),
              summary_count: count,
            }),
          });
        }
        const written = await writer.write(tx, scope.organizationId, prepared);
        const delivered = written.filter((item) => item.id !== null).length;
        const result: SendNotificationStepOutput = {
          recipients: candidates.length,
          delivered,
          turned_off: written.filter((item) => item.id === null).length,
          summarized: over.length,
          groups: renderedGroups,
          record_id: link?.recordId ?? null,
          skipped: skipped.sort((a, b) => (a.user_id < b.user_id ? -1 : 1)),
        };
        const stepOutput: JsonObject = {
          ...(result as unknown as JsonObject),
          ...(warnings.length === 0 ? {} : { warnings: dedupe(warnings) as unknown as JsonValue }),
        };
        await context.complete(tx, stepOutput);
        return stepOutput;
      });
      return { output, warnings: dedupe(warnings) };
    },
  };

  /** The user behind the trigger event (`null` for the system, a schedule, a missing event). */
  async function actorOf(
    scope: OrgScope,
    trigger: Readonly<Record<string, unknown>>,
  ): Promise<Id<'usr'> | null> {
    const data = isObject(trigger['data']) ? trigger['data'] : {};
    const clickedBy = data['clicked_by'];
    if (typeof clickedBy === 'string') return clickedBy as Id<'usr'>;
    const eventId = trigger['event_id'];
    const createdAt = trigger['event_created_at'];
    if (typeof eventId !== 'string' || typeof createdAt !== 'string') return null;
    const event = await events.getByKey(scope, { id: eventId as Id<'evt'>, createdAt });
    return event?.actor_type === 'user' && event.actor_id !== null
      ? (event.actor_id as Id<'usr'>)
      : null;
  }
}

/** The record to link: the trigger record, a step record, or none. */
async function linkOf(
  config: Config,
  definition: AutomationDefinition,
  context: AutomationActionContext,
  triggerTableId: Id<'tbl'> | null,
): Promise<RecordRef | null> {
  const target = config.link_record;
  if (target === null) return null;
  if (target === 'trigger') {
    const recordId = context.run.triggerRecordId;
    return triggerTableId === null || recordId === null
      ? null
      : { tableId: triggerTableId, recordId };
  }
  const step = flattenActions(definition.actions).find((item) => item.action.id === target.step);
  const tableId = step === undefined ? null : stepRecordTable(step.action, triggerTableId);
  const recordId = await stepOutputRecord(context, target.step);
  return tableId === null || recordId === null ? null : { tableId, recordId };
}

/** The record id of an earlier step's output (`null`: not run, no record). */
async function stepOutputRecord(
  context: AutomationActionContext,
  actionId: string,
): Promise<Id<'rec'> | null> {
  const output = await context.values.resolve({ step: actionId });
  const id = stepRecordId(output.value);
  return id === null ? null : (id as Id<'rec'>);
}

/**
 * Records every recipient must read: the linked one, the trigger record
 * when the text uses its fields, the step records it uses.
 */
async function requiredRecords(
  context: AutomationActionContext,
  link: RecordRef | null,
  references: NotificationReferences,
  steps: ReadonlyMap<string, Id<'tbl'>>,
): Promise<RecordRef[]> {
  const { run } = context;
  const out = new Map<string, RecordRef>();
  const add = (ref: RecordRef) => {
    out.set(`${ref.tableId}:${ref.recordId}`, ref);
  };
  if (link !== null) add(link);
  if (references.triggerRecord && run.triggerTableId !== null && run.triggerRecordId !== null) {
    add({ tableId: run.triggerTableId, recordId: run.triggerRecordId });
  }
  for (const actionId of references.steps) {
    const tableId = steps.get(actionId);
    const recordId = await stepOutputRecord(context, actionId);
    if (tableId !== undefined && recordId !== null) add({ tableId, recordId });
  }
  return [...out.values()];
}

function messageData(data: AutomationMessageData): JsonObject {
  return data as unknown as JsonObject;
}

function dedupe(warnings: readonly TemplateWarning[]): TemplateWarning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.code}|${String(warning.placeholder ?? '')}|${warning.field_id ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
