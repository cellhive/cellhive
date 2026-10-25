import {
  automationDefinitionSchema,
  INVALID_URL,
  type AutomationAction,
  type AutomationBranchAction,
  type AutomationDefinition,
  type HttpRequestConfig,
  type HttpTestWarning,
  type Id,
  type ProblemErrorItem,
  type RunN8nWorkflowConfig,
} from '@cellhive/contracts';

import { AuditWriter } from '../../../audit/audit-writer.js';
import { withTxScope, type OrgScope } from '../../../db/repository.js';
import { AppError } from '../../../errors/app-error.js';
import { HttpOutbox } from '../../../http-out/http-outbox.js';
import {
  loadMemberAccessBase,
  resolveMemberBaseAccess,
  type AccessDefaults,
  type MemberBaseAccess,
} from '../../../import/member-access.js';
import { isOutboundHttpError } from '../../../net/errors.js';
import { SecretsRepository } from '../../../secrets/secrets.repository.js';
import { IncomingWebhooksRepository } from '../../../webhooks/incoming/incoming-webhooks.repository.js';
import { sampleFromJson } from '../../../webhooks/incoming/sample/sample.js';
import { flattenActions, validateAutomationDefinition } from '../../definition/validate.js';
import { AutomationStepError } from '../../engine/errors.js';
import { loadAutomationSchema } from '../../engine/schema-context.js';
import { AutomationValueError, AutomationValueEvaluator } from '../../values/evaluator.js';
import { recordQueryReader } from '../../values/record-reader.js';
import { buildN8nPayload } from '../run-n8n-workflow/payload.js';
import { n8nHttpRequestConfig } from '../run-n8n-workflow/run-n8n-workflow-action.js';

import { renderHttpRequest } from './render.js';
import { checkHttpRequestSecrets } from './secret-check.js';

import type { AuditContext } from '../../../audit/audit-entry.js';
import type { Db } from '../../../db/create-db.js';
import type { JsonValue } from '../../../db/schema.js';
import type { RecordQueryService } from '../../../records/record-query.service.js';
import type { AutomationRunInfo } from '../../engine/action-registry.js';
import type { WebhookRequestData } from '../../values/webhook-data.js';

/** The automation as stored. */
export interface HttpTestAutomation {
  readonly id: Id<'aut'>;
  /** Shown in a `run_n8n_workflow` payload (`automation.name`). */
  readonly name: string;
  readonly base_id: Id<'bse'>;
  readonly definition: unknown;
  readonly trigger_table_id: Id<'tbl'> | null;
}

export interface HttpTestRequestInput {
  readonly automation: HttpTestAutomation;
  readonly actionId: string;
  /**
   * The builder's unsaved configuration (default: the saved step): an
   * `http_request` or a `run_n8n_workflow` config (T616), of the saved
   * step's type when the step exists.
   */
  readonly draft?: HttpRequestConfig | RunN8nWorkflowConfig;
  readonly recordId: Id<'rec'> | null;
  /** Who asked: the request is rendered with their permissions, and only they read the result. */
  readonly requesterUserId: Id<'usr'>;
}

export interface HttpRequestTesterOptions {
  /** `APP_MASTER_KEY` (the outbox seals the request). */
  readonly masterKey: Buffer | string;
  readonly query: RecordQueryService;
  readonly defaults: AccessDefaults;
  /** `PUBLIC_URL` (record links of `[@url]`). */
  readonly publicUrl: string;
}

type AnyAction = AutomationAction | AutomationBranchAction;

/** A step "Send a test" can send. */
type TestedStep =
  | { readonly type: 'http_request'; readonly config: HttpRequestConfig }
  | { readonly type: 'run_n8n_workflow'; readonly config: RunN8nWorkflowConfig };

const TESTED_TYPES: ReadonlySet<string> = new Set(['http_request', 'run_n8n_workflow']);

/** The type of a draft: only an `http_request` config has `method`. */
function stepOfDraft(draft: HttpRequestConfig | RunN8nWorkflowConfig): TestedStep {
  return 'method' in draft
    ? { type: 'http_request', config: draft }
    : { type: 'run_n8n_workflow', config: draft };
}

/** Empty webhook data: values and placeholders of the request read `null`/"". */
const NO_WEBHOOK_DATA: WebhookRequestData = { body: null, headers: null, query: null };

const audit = new AuditWriter();

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function invalid(errors: ProblemErrorItem[]): AppError {
  return new AppError('AUTOMATION_INVALID', {
    detail: 'The HTTP request step is not valid for you.',
    errors,
  });
}

/** The definition with the step `actionId` set to `step` (added at the end when new). */
function withStep(
  definition: AutomationDefinition,
  actionId: string,
  step: TestedStep,
): AutomationDefinition {
  const seen = { found: false };
  const replace = <A extends AnyAction>(action: A): A => {
    if (action.id === actionId && action.type === step.type) {
      seen.found = true;
      return { ...action, config: step.config };
    }
    if (action.type === 'if') {
      return {
        ...action,
        config: {
          ...action.config,
          then: action.config.then.map(replace),
          else: action.config.else.map(replace),
        },
      };
    }
    return action;
  };
  const actions = definition.actions.map(replace);
  if (!seen.found) actions.push({ id: actionId, ...step });
  return { ...definition, actions };
}

/** Problem code of a render failure of "Send a test" (`422 AUTOMATION_INVALID`). */
const RENDER_CODES: Readonly<Record<string, string>> = {
  invalid_value: 'INVALID_VALUE',
  http_request_too_large: 'TOO_BIG',
  ssrf_blocked: INVALID_URL,
  unsupported_function: 'UNSUPPORTED_FUNCTION',
  trigger_data_expired: 'UNSUPPORTED_VALUE_SOURCE',
};

/**
 * "Send a test" of an `http_request` step (BACKLOG T606, CONTRACTS §25.5,
 * "Quyết định S5c" #13): the step — saved, or the builder's draft — is
 * checked like a save **as the caller** (`422 AUTOMATION_INVALID`, its
 * secrets too), rendered with the **caller's** permissions on a record of
 * the trigger table they read (`404` otherwise; earlier steps did not run:
 * their values are empty), then inserted as a `test` delivery of the
 * outbox — no network call from the API, no causation, kept 24 hours —
 * and audited `automation.test_http_sent` (action, delivery id, host). The
 * caller checks who may do this (managers of the automation) and the rate
 * limit.
 */
export class HttpRequestTester {
  private readonly outbox: HttpOutbox;
  private readonly secrets: SecretsRepository;
  private readonly hooks: IncomingWebhooksRepository;

  constructor(
    private readonly db: Db,
    private readonly options: HttpRequestTesterOptions,
  ) {
    this.outbox = new HttpOutbox(db, { masterKey: options.masterKey });
    this.secrets = new SecretsRepository(db);
    this.hooks = new IncomingWebhooksRepository(db);
  }

  async send(
    scope: OrgScope,
    request: HttpTestRequestInput,
    context: AuditContext,
  ): Promise<{ readonly deliveryId: Id<'hdl'>; readonly warnings: readonly HttpTestWarning[] }> {
    const { automation } = request;
    const baseId = automation.base_id;
    const loaded = await loadMemberAccessBase(this.db, scope, baseId);
    const access =
      loaded === undefined
        ? undefined
        : await resolveMemberBaseAccess(
            this.db,
            scope,
            { userId: request.requesterUserId, baseId },
            this.options.defaults,
            loaded,
          );
    if (loaded === undefined || access === undefined) throw new AppError('NOT_FOUND');
    const stored = automationDefinitionSchema.safeParse(automation.definition);
    if (!stored.success) {
      throw invalid([
        { path: 'definition', code: 'INVALID', message: 'The stored definition is outdated' },
      ]);
    }
    const found = flattenActions(stored.data.actions).find(
      (item) => item.action.id === request.actionId,
    );
    if (found !== undefined && !TESTED_TYPES.has(found.action.type)) {
      throw new AppError('NOT_FOUND');
    }
    const saved =
      found?.action.type === 'http_request' || found?.action.type === 'run_n8n_workflow'
        ? ({ type: found.action.type, config: found.action.config } as TestedStep)
        : undefined;
    const step = request.draft === undefined ? saved : stepOfDraft(request.draft);
    // A draft of another type than the saved step is not that step.
    if (step === undefined || (saved !== undefined && saved.type !== step.type)) {
      throw new AppError('NOT_FOUND');
    }
    const definition = withStep(stored.data, request.actionId, step);
    const path =
      flattenActions(definition.actions).find((item) => item.action.id === request.actionId)
        ?.path ?? 'definition.actions';
    const own = (errors: readonly ProblemErrorItem[]) =>
      errors.filter((error) => error.path === path || error.path.startsWith(`${path}.`));

    // The step as a save by the caller would check it (their access).
    const schema = await loadAutomationSchema(
      this.db,
      scope,
      baseId,
      access.record.resolved.access,
      loaded.base.settings,
    );
    const validation = validateAutomationDefinition(definition, schema);
    let tested: TestedStep = step;
    if (validation.ok) {
      const checked = flattenActions(validation.definition.actions).find(
        (item) => item.action.id === request.actionId,
      )?.action;
      if (checked?.type === 'http_request' || checked?.type === 'run_n8n_workflow') {
        tested = { type: checked.type, config: checked.config } as TestedStep;
      }
    } else if (own(validation.errors).length > 0) {
      throw invalid(own(validation.errors));
    }
    const secretErrors = own(
      await checkHttpRequestSecrets(this.secrets, scope, { baseId, definition }),
    );
    if (secretErrors.length > 0) throw invalid(secretErrors);

    const triggerType = definition.trigger.type;
    const tableId = automation.trigger_table_id;
    const hasRecord =
      tableId !== null && triggerType !== 'schedule' && triggerType !== 'webhook.received';
    if (request.recordId !== null) {
      if (!hasRecord || !(await this.readable(scope, tableId, request.recordId, access))) {
        throw new AppError('NOT_FOUND');
      }
    }

    // `webhook.received` (T616): the hook's captured sample stands in for the request — only
    // for a base admin, who alone may see the sample (and manage such automations, T604).
    const warnings: HttpTestWarning[] = [];
    let webhookData: WebhookRequestData | undefined;
    if (definition.trigger.type === 'webhook.received') {
      webhookData = NO_WEBHOOK_DATA;
      const hook = access.isAdmin
        ? await this.hooks.findById(scope, definition.trigger.incoming_webhook_id)
        : undefined;
      const sample = hook?.base_id === baseId ? sampleFromJson(hook.sample) : null;
      if (sample === null) warnings.push({ code: 'no_sample' });
      else webhookData = { body: sample.body, headers: sample.headers, query: sample.query };
    }

    const settings = loaded.organization.settings;
    const timeZone = settingOf(settings, 'timezone') ?? this.options.defaults.timeZone;
    const locale = settingOf(settings, 'locale') ?? this.options.defaults.locale;
    const now = new Date();
    const at = now.toISOString();
    const publicUrl = this.options.publicUrl.replace(/\/+$/u, '');
    const values = new AutomationValueEvaluator({
      context: schema,
      definition,
      reader: recordQueryReader(this.options.query, scope, access.record),
      trigger: {
        tableId: hasRecord ? tableId : null,
        recordId: request.recordId,
        data: {
          fired_at: at,
          due_at: at,
          clicked_at: at,
          clicked_by: request.requesterUserId,
          actor: request.requesterUserId,
        },
      },
      steps: new Map(),
      timeZone,
      locale,
      now,
      recordUrl: (table, record) =>
        `${publicUrl}/b/${encodeURIComponent(baseId)}/t/${encodeURIComponent(table)}?record=${encodeURIComponent(record)}`,
      ...(webhookData === undefined
        ? {}
        : { webhook: { load: () => Promise.resolve(webhookData) } }),
    });
    let rendered: Awaited<ReturnType<typeof renderHttpRequest>>;
    try {
      let config: HttpRequestConfig;
      if (tested.type === 'http_request') {
        config = tested.config;
      } else {
        // `run_n8n_workflow` (T616): the payload as the caller reads the sample record now.
        const run: AutomationRunInfo = {
          id: '' as Id<'run'>,
          automationId: automation.id,
          baseId,
          triggerTableId: hasRecord ? tableId : null,
          triggerRecordId: request.recordId,
          triggerEventId: null,
          triggerType,
          timeZone,
          locale,
          triggerEventCreatedAt: at,
          automationName: automation.name,
          baseName: loaded.base.name,
        };
        const built = await buildN8nPayload(
          { query: this.options.query },
          { db: this.db, scope, run, access, schema, values, now: () => now },
          tested.config,
        );
        config = n8nHttpRequestConfig(tested.config, built.payload);
      }
      rendered = await renderHttpRequest(values, config);
    } catch (error) {
      if (error instanceof AutomationStepError || error instanceof AutomationValueError) {
        throw invalid([
          {
            path: `${path}.config`,
            code: RENDER_CODES[error.code] ?? 'INVALID_VALUE',
            message: 'This request cannot be sent',
            params: {
              code: error.code,
              ...stringParams(
                error instanceof AutomationStepError ? error.options.params : error.params,
              ),
            },
          },
        ]);
      }
      throw error;
    }

    try {
      return await this.db.withTx(async (tx) => {
        const { row } = await this.outbox.enqueue(tx, withTxScope(scope, tx), {
          kind: 'test',
          automationId: automation.id,
          actionId: request.actionId,
          requestedBy: request.requesterUserId,
          request: { ...rendered.delivery.request, causation: null },
          authSecretId: rendered.delivery.authSecretId ?? null,
          signingSecretId: rendered.delivery.signingSecretId ?? null,
        });
        await audit.write(tx, {
          action: 'automation.test_http_sent',
          organizationId: scope.organizationId,
          baseId,
          tableId: automation.trigger_table_id,
          entityType: 'automation',
          entityId: automation.id,
          after: {
            action_id: request.actionId,
            delivery_id: row.id,
            target_host: row.target_host,
          },
          context,
        });
        return { deliveryId: row.id, warnings };
      });
    } catch (error) {
      if (isOutboundHttpError(error)) {
        throw invalid([
          {
            path: `${path}.config.url`,
            code: INVALID_URL,
            message: 'This URL can never be called',
            params: { ...error.params },
          },
        ]);
      }
      throw error;
    }
  }

  /** Whether `access` reads the record (outside its read rule or table → no). */
  private async readable(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    recordId: Id<'rec'>,
    access: MemberBaseAccess,
  ): Promise<boolean> {
    if (access.record.resolved.access.tables[tableId] === undefined) return false;
    try {
      const records = await this.options.query.getRecords(
        scope,
        tableId,
        [recordId],
        access.record,
        { field_key_type: 'id', fields: [] },
      );
      return records.length > 0;
    } catch (error) {
      if (error instanceof AppError && error.status === 404) return false;
      throw error;
    }
  }
}

/** A non-empty string setting of the organization (`timezone`, `locale`), else `undefined`. */
function settingOf(settings: JsonValue, key: string): string | undefined {
  const value = isObject(settings) ? settings[key] : undefined;
  if (typeof value !== 'string' || value === '') return undefined;
  if (key === 'timezone') {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
    } catch {
      return undefined;
    }
  }
  return value;
}

/** Scalar params of an error (codes, sizes, field names — never values). */
function stringParams(
  params: Readonly<Record<string, unknown>> | undefined,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (typeof value === 'string' || typeof value === 'number') out[key] = value;
  }
  return out;
}
