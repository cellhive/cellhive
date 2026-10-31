import {
  AUTOMATION_RUN_ERROR_CODES,
  automationDefinitionSchema,
  EMAIL_IMAGE_NOT_FOUND,
  isTemplateReferenceId,
  NO_ACTIONS,
  newId,
  type AutomationDefinition,
  type AutomationDto,
  type AutomationList,
  type AutomationListItem,
  type AutomationListQuery,
  type AutomationRunAsReason,
  type AutomationRunErrorCode,
  type CreateAutomationRequest,
  type DuplicateAutomationRequest,
  type EventType,
  type Id,
  type ProblemErrorItem,
  type TakeOverAutomationRequest,
  type UpdateAutomationRequest,
  type ValidateAutomationTemplateRequest,
  type ValidateAutomationTemplateResponse,
} from '@cellhive/contracts';
import {
  aiCrossRecordSources,
  AiSettingsRepository,
  automationSnapshot,
  AutomationRunsRepository,
  AutomationsRepository,
  cancelWaitingRuns,
  checkAiActions,
  checkAutomationTemplate,
  checkSendEmailImages,
  checkSendEmailSenders,
  checkSendNotificationRecipients,
  checkHttpRequestSecrets,
  checkSendTelegramSecrets,
  duplicateAutomationName,
  emailAssetReferencesOf,
  EmailAssetsRepository,
  EmailIdentitiesRepository,
  IncomingWebhooksRepository,
  OrganizationsRepository,
  orgEmailSettingsOf,
  sendEmailSteps,
  stepFieldsOf,
  templateResultType,
  previousSourceOf,
  replaceEmailAssetIds,
  stageEmailAssetCopies,
  TRIGGER_REFERENCES,
  canManageAutomation,
  canSeeAutomation,
  isComputedRow,
  loadBaseSchemaRows,
  lockedComputedFieldIds,
  managedTableIds,
  managesAnyAutomation,
  orgScope,
  SecretsRepository,
  SQLSTATE,
  sqlStateOf,
  strictComputedPermissionsOf,
  validateAutomationDefinition,
  ViewsRepository,
  withTxScope,
  type AuditContext,
  type AutomationListRow,
  type AutomationRow,
  type AutomationRunStats,
  type AutomationValidationContext,
  type AutomationViewMeta,
  type AppConfig,
  type Db,
  type JsonObject,
  type OrgScope,
  type StagedEmailAssetCopies,
  type StorageDriver,
  type TemplateSources,
  type Tx,
  type UpdateAutomationInput,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import {
  AccessService,
  notFound,
  permissionDenied,
  type BaseAccess,
} from '../../common/access/access.service.js';
import { mutationContextOf, recordChange } from '../../common/access/change-log.js';
import { settingOf } from '../../common/access/time-zone.js';
import { iso } from '../../common/dto.js';
import { AppLogger } from '../../common/logging/app-logger.js';
import { APP_CONFIG, DB, STORAGE_DRIVER } from '../../common/tokens.js';
import { readabilityOf } from '../field/computed-fields.js';

import type { Principal } from '../../common/auth/principal.js';
import type { RequestMeta } from '../../common/auth/request-meta.js';

/** An automation the caller manages, with the access that allows it. */
export interface Located {
  readonly base: BaseAccess;
  readonly row: AutomationListRow;
}

function automationInvalid(errors: ProblemErrorItem[]): AppError {
  return new AppError('AUTOMATION_INVALID', {
    detail: 'The automation definition is not valid for you.',
    errors,
  });
}

/**
 * The stored definition of `row`, else `422`: a definition saved before a
 * contract change that no longer parses must be saved again first.
 */
function storedDefinitionOf(row: AutomationRow): AutomationDefinition {
  const stored = automationDefinitionSchema.safeParse(row.definition);
  if (!stored.success) {
    throw automationInvalid([
      { path: 'definition', code: 'INVALID', message: 'The stored definition is outdated' },
    ]);
  }
  return stored.data;
}

/** Detail code: another automation is attached to the button (T517). */
const BUTTON_IN_USE = 'BUTTON_IN_USE';
/** The unique index behind `BUTTON_IN_USE` (migration 0034). */
const BUTTON_FIELD_KEY = 'automations_button_field_key';

/**
 * `422 AUTOMATION_INVALID` / `BUTTON_IN_USE` (BACKLOG T517, "Câu hỏi mở S5"
 * #6): at most one automation (not deleted) per button.
 */
function buttonInUse(automationId: Id<'aut'> | null): AppError {
  return automationInvalid([
    {
      path: 'definition.trigger.field_id',
      code: BUTTON_IN_USE,
      message: 'Another automation already runs from this button',
      ...(automationId === null ? {} : { params: { automation_id: automationId } }),
    },
  ]);
}

/**
 * `BUTTON_IN_USE` of a duplicate (BACKLOG T551): the source still runs from
 * the button, so a copy of a `button.clicked` automation is never saved.
 * `params.reason = duplicate` lets the client explain what to do instead.
 */
function duplicateButtonInUse(source: Id<'aut'>): AppError {
  return automationInvalid([
    {
      path: 'definition.trigger.field_id',
      code: BUTTON_IN_USE,
      message:
        'A button runs a single automation, so a copy cannot keep this button trigger: add ' +
        'another button field and create an automation for it, or change this one',
      params: { automation_id: source, reason: 'duplicate' },
    },
  ]);
}

/** A concurrent save attached another automation to the button first (unique index). */
function isButtonTaken(error: unknown): boolean {
  return (
    sqlStateOf(error) === SQLSTATE.uniqueViolation &&
    (error as { constraint?: unknown }).constraint === BUTTON_FIELD_KEY
  );
}

function cannotManage(): AppError {
  return permissionDenied(
    'Automations are managed by base admins and by people with manage rights on the trigger table.',
  );
}

function noActions(): AppError {
  return automationInvalid([
    {
      path: 'definition.actions',
      code: NO_ACTIONS,
      message: 'An automation needs at least one action to run',
    },
  ]);
}

/** JSON with object keys sorted: `jsonb` does not keep key order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** Audit/event snapshot: configuration only, never record values. */
function snapshotOf(row: AutomationRow, withDefinition: boolean): JsonObject {
  return {
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    disabled_reason: row.disabled_reason,
    trigger_type: row.trigger_type,
    trigger_table_id: row.trigger_table_id,
    version: row.version,
    run_as_user_id: row.run_as_user_id,
    ...(withDefinition ? { definition: row.definition } : {}),
  };
}

/** A list item: the automation, its latest run and its run counts (BACKLOG T518). */
function listItemOf(dto: AutomationDto, stats: AutomationRunStats | undefined): AutomationListItem {
  const last = stats?.lastRun ?? null;
  const counts = (source: AutomationRunStats['counts24h'] | undefined) => ({
    queued: source?.queued ?? 0,
    running: source?.running ?? 0,
    waiting: source?.waiting ?? 0,
    succeeded: source?.succeeded ?? 0,
    failed: source?.failed ?? 0,
    skipped: source?.skipped ?? 0,
    cancelled: source?.cancelled ?? 0,
  });
  return {
    ...dto,
    last_run:
      last === null
        ? null
        : {
            id: last.id,
            status: last.status,
            error_code: isRunErrorCode(last.errorCode) ? last.errorCode : null,
            created_at: iso(last.createdAt),
            finished_at: last.finishedAt === null ? null : iso(last.finishedAt),
          },
    errors_24h: stats?.counts24h.failed ?? 0,
    run_counts_24h: counts(stats?.counts24h),
    run_counts_7d: counts(stats?.counts7d),
  };
}

function isRunErrorCode(code: string | null): code is AutomationRunErrorCode {
  return code !== null && (AUTOMATION_RUN_ERROR_CODES as readonly string[]).includes(code);
}

/** `If-Match` (`3`, `"3"`, `W/"3"`) or body `version`; body wins. */
export function expectedVersionOf(
  ifMatch: string | undefined,
  version: number | undefined,
): number | undefined {
  if (version !== undefined) return version;
  if (ifMatch === undefined) return undefined;
  const digits = /\d+/u.exec(ifMatch)?.[0];
  return digits === undefined ? undefined : Number(digits);
}

/**
 * Automation management (SPEC §11, CONTRACTS §21; BACKLOG T502).
 *
 * - Managing an automation needs base admin, or `manage` on the trigger's
 *   table (ADR-25 §3). Someone who opens the base and reads that table but
 *   cannot manage it gets `403`; anyone else `404`.
 * - Every save that makes the caller `run_as` — create, a definition
 *   change, enable, take over — validates the definition against the
 *   caller's own access (`422 AUTOMATION_INVALID`); renaming, describing,
 *   disabling and deleting do not, and keep `run_as` (ADR-25 §2).
 * - `version` (body or `If-Match`) guards against lost updates (`409`).
 * - Every change writes `automation.*` events + audit in its transaction,
 *   `automation.run_as_changed` when `run_as` moves (ADR-25 §7).
 */
@Injectable()
export class AutomationService {
  /** AI settings of the organization: AI actions need AI and record data (T911). */
  private readonly aiSettings: AiSettingsRepository;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AutomationsRepository) private readonly automations: AutomationsRepository,
    @Inject(ViewsRepository) private readonly views: ViewsRepository,
    @Inject(AutomationRunsRepository) private readonly runs: AutomationRunsRepository,
    @Inject(OrganizationsRepository) private readonly organizations: OrganizationsRepository,
    @Inject(EmailIdentitiesRepository) private readonly identities: EmailIdentitiesRepository,
    @Inject(SecretsRepository) private readonly secrets: SecretsRepository,
    @Inject(EmailAssetsRepository) private readonly emailAssets: EmailAssetsRepository,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
    @Inject(AppLogger) private readonly logger: AppLogger,
    /** Incoming webhooks a `webhook.received` trigger names (T604). */
    @Inject(IncomingWebhooksRepository) private readonly hooks: IncomingWebhooksRepository,
  ) {
    this.aiSettings = new AiSettingsRepository(db);
  }

  async list(
    principal: Principal,
    baseId: Id<'bse'>,
    query: AutomationListQuery,
  ): Promise<AutomationList> {
    const base = await this.access.requireBase(principal, baseId, 'read');
    if (!managesAnyAutomation(base.access)) throw cannotManage();
    const page = await this.automations.listPage(
      base.org.scope,
      base.base.id,
      {
        ...(base.access.is_admin ? {} : { triggerTableIds: managedTableIds(base.access) }),
        ...(query.table_id === undefined ? {} : { tableId: query.table_id }),
      },
      query,
    );
    const stats = await this.runs.statsOf(
      base.org.scope,
      page.items.map((row) => row.id),
    );
    return {
      items: page.items.map((row) => listItemOf(this.dtoOf(row), stats.get(row.id))),
      total: page.total,
      offset: query.offset,
      limit: query.limit,
    };
  }

  async get(principal: Principal, automationId: Id<'aut'>): Promise<AutomationDto> {
    return this.dtoOf((await this.locate(principal, automationId)).row);
  }

  async create(
    principal: Principal,
    baseId: Id<'bse'>,
    input: CreateAutomationRequest,
    meta: RequestMeta,
  ): Promise<AutomationDto> {
    const base = await this.access.requireBase(principal, baseId, 'read');
    if (!managesAnyAutomation(base.access)) throw cannotManage();
    const { definition, triggerTableId } = await this.validate(base, input.definition, null);
    if (!canManageAutomation(base.access, triggerTableId)) throw cannotManage();
    if (input.enabled && definition.actions.length === 0) throw noActions();
    const context = mutationContextOf(meta, principal.userId);
    const id = await this.withButtonCheck(() =>
      this.db.withTx(async (tx) => {
        const scope = withTxScope(base.org.scope, tx);
        await this.assertButtonFree(scope, definition, null);
        const row = await this.automations.insert(scope, {
          id: newId('aut'),
          baseId: base.base.id,
          name: input.name,
          description: input.description,
          enabled: input.enabled,
          definition: definition as unknown as JsonObject,
          triggerType: definition.trigger.type,
          triggerTableId,
          createdBy: principal.userId,
        });
        await this.record(tx, row, 'automation.created', context, {
          before: null,
          after: snapshotOf(row, true),
        });
        await this.recordRunAs(tx, row, null, 'created', context);
        if (row.enabled) await this.recordToggle(tx, row, 'automation.enabled', context);
        return row.id;
      }),
    );
    return this.reload(base.org.scope, id);
  }

  async update(
    principal: Principal,
    automationId: Id<'aut'>,
    input: UpdateAutomationRequest,
    ifMatch: string | undefined,
    meta: RequestMeta,
  ): Promise<AutomationDto> {
    const { base, row } = await this.locate(principal, automationId);
    let next: { definition: AutomationDefinition; triggerTableId: Id<'tbl'> | null } | undefined;
    if (input.definition !== undefined && !sameJson(input.definition, row.definition)) {
      next = await this.validate(base, input.definition, row.id);
      if (sameJson(next.definition, row.definition)) next = undefined;
    }
    if (next !== undefined) {
      if (!canManageAutomation(base.access, next.triggerTableId)) throw cannotManage();
      if (row.enabled && next.definition.actions.length === 0) throw noActions();
    }
    const expected = expectedVersionOf(ifMatch, input.version);
    const context = mutationContextOf(meta, principal.userId);
    await this.withButtonCheck(() =>
      this.db.withTx(async (tx) => {
        const scope = withTxScope(base.org.scope, tx);
        const current = await this.lockAt(scope, automationId, expected);
        if (next !== undefined) await this.assertButtonFree(scope, next.definition, automationId);
        const patch: UpdateAutomationInput = {
          updatedBy: principal.userId,
          ...(input.name === undefined || input.name === current.name ? {} : { name: input.name }),
          ...(input.description === undefined || input.description === current.description
            ? {}
            : { description: input.description }),
          ...(next === undefined
            ? {}
            : {
                definition: next.definition as unknown as JsonObject,
                triggerType: next.definition.trigger.type,
                triggerTableId: next.triggerTableId,
                ...(current.run_as_user_id === principal.userId ? {} : { runAs: principal.userId }),
              }),
        };
        if (Object.keys(patch).length === 1) return;
        const updated = await this.update0(scope, automationId, patch);
        await this.record(tx, updated, 'automation.updated', context, {
          before: snapshotOf(current, next !== undefined),
          after: snapshotOf(updated, next !== undefined),
          data: {
            changed: [
              ...(patch.name === undefined ? [] : ['name']),
              ...(patch.description === undefined ? [] : ['description']),
              ...(next === undefined ? [] : ['definition']),
            ],
          },
        });
        if (patch.runAs !== undefined) {
          await this.recordRunAs(tx, updated, current.run_as_user_id, 'edited', context);
        }
      }),
    );
    return this.reload(base.org.scope, automationId);
  }

  /**
   * Duplicates an automation (BACKLOG T551, CONTRACTS §21; "Quyết định S5b"
   * #4). Like a create by the caller (ADR-25 §2–3): the caller must manage
   * the source (`404` when they do not see it, `403` when they see it but
   * cannot manage it) and the copy's definition is checked with the
   * caller's own permissions (`422 AUTOMATION_INVALID`, nothing created).
   * The copy is in the same base, off, the caller `run_as` and creator;
   * runs, history and counters are not copied. A `button.clicked`
   * automation cannot be copied (`BUTTON_IN_USE`: a button runs one
   * automation, T517).
   *
   * Body images (`meta.email_assets`, `kind = automation`) the definition
   * shows are copied — new rows and objects in the same organization
   * (`stageEmailAssetCopies`) — and `asset:<id>` of the copy names the
   * copies, attached to it in the transaction that creates it; when that
   * transaction fails the copies are discarded (or, failing that, deleted
   * by `attachments.cleanup` since nothing references them).
   * `automation.created` (`after.duplicated_from`) and
   * `automation.run_as_changed` (`reason: created`) in that transaction.
   */
  async duplicate(
    principal: Principal,
    automationId: Id<'aut'>,
    input: DuplicateAutomationRequest,
    meta: RequestMeta,
  ): Promise<AutomationDto> {
    const { base, row: source } = await this.locate(principal, automationId);
    const scope = base.org.scope;
    // The source's own images pass the check; they map one to one to the copies.
    const { definition, triggerTableId } = await this.validate(
      base,
      storedDefinitionOf(source),
      source.id,
    );
    if (!canManageAutomation(base.access, triggerTableId)) throw cannotManage();
    if (definition.trigger.type === 'button.clicked') throw duplicateButtonInUse(source.id);
    const name = input.name ?? duplicateAutomationName(source.name, this.localeOf(principal, base));
    const staged = await this.stageImages(scope, source.id, definition, principal.userId);
    const context = mutationContextOf(meta, principal.userId);
    let id: Id<'aut'>;
    try {
      id = await this.db.withTx(async (tx) => {
        const txScope = withTxScope(scope, tx);
        const row = await this.automations.insert(txScope, {
          id: newId('aut'),
          baseId: base.base.id,
          name,
          description: source.description,
          enabled: false,
          definition: replaceEmailAssetIds(definition, staged.mapping) as unknown as JsonObject,
          triggerType: definition.trigger.type,
          triggerTableId,
          createdBy: principal.userId,
        });
        const attached = await this.emailAssets.attachCopies(txScope, staged.ids, row.id);
        // Only the cleanup deletes a staged copy, 24 hours after it was made: not reachable
        // in practice, never a copy naming an image that is not there.
        if (attached !== staged.ids.length) {
          throw new AppError('INTERNAL', { detail: 'The images could not be copied.' });
        }
        await this.record(tx, row, 'automation.created', context, {
          before: null,
          after: { ...snapshotOf(row, true), duplicated_from: source.id },
        });
        await this.recordRunAs(tx, row, null, 'created', context);
        return row.id;
      });
    } catch (error) {
      if (!(await staged.discard())) {
        this.logger.warn(
          { organization_id: scope.organizationId, images: staged.ids.length },
          'copied email images left for the cleanup',
        );
      }
      throw error;
    }
    return this.reload(scope, id);
  }

  /** The caller's language: their own, else the organization's, else the default. */
  private localeOf(principal: Principal, base: BaseAccess): string {
    const locales = [principal.user.locale, settingOf(base.org.membership.settings, 'locale')];
    return (
      locales.find((locale): locale is string => typeof locale === 'string' && locale !== '') ??
      this.config.defaults.locale
    );
  }

  /**
   * Copies the body images `definition` shows (assets of `source`, checked
   * by `validate`): `422 EMAIL_IMAGE_NOT_FOUND` when one is no longer
   * there, or its object is gone from storage.
   */
  private async stageImages(
    scope: OrgScope,
    source: Id<'aut'>,
    definition: AutomationDefinition,
    userId: Id<'usr'>,
  ): Promise<StagedEmailAssetCopies> {
    const references = emailAssetReferencesOf(definition);
    const imagesNotFound = (assetIds: ReadonlySet<string>) =>
      automationInvalid(
        references
          .filter((reference) => assetIds.has(reference.assetId))
          .map((reference) => ({
            path: reference.path,
            code: EMAIL_IMAGE_NOT_FOUND,
            message: 'This image is not an image uploaded for this automation',
            params: { asset_id: reference.assetId },
          })),
      );
    const wanted = [...new Set(references.map((reference) => reference.assetId))];
    const sources = (await this.emailAssets.getReady(scope, wanted)).filter(
      (asset) => asset.kind === 'automation' && asset.automation_id === source,
    );
    const found = new Set<string>(sources.map((asset) => asset.id));
    const lost = wanted.filter((assetId) => !found.has(assetId));
    if (lost.length > 0) throw imagesNotFound(new Set(lost));
    const result = await stageEmailAssetCopies(
      { assets: this.emailAssets, storage: this.storage },
      scope,
      { sources, createdBy: userId },
    );
    if (!result.ok) throw imagesNotFound(new Set([result.missing]));
    return result.staged;
  }

  /**
   * `BUTTON_IN_USE` (T517) when another automation (not deleted) is already
   * attached to the button of a `button.clicked` trigger.
   */
  private async assertButtonFree(
    scope: OrgScope,
    definition: AutomationDefinition,
    self: Id<'aut'> | null,
  ): Promise<void> {
    if (definition.trigger.type !== 'button.clicked') return;
    const attached = await this.automations.listForButtons(scope, [definition.trigger.field_id]);
    const other = attached.find((row) => row.id !== self);
    if (other !== undefined) throw buttonInUse(other.id);
  }

  /** Runs a save; a race lost on the button's unique index is `BUTTON_IN_USE` too. */
  private async withButtonCheck<T>(save: () => Promise<T>): Promise<T> {
    try {
      return await save();
    } catch (error) {
      if (isButtonTaken(error)) throw buttonInUse(null);
      throw error;
    }
  }

  async remove(
    principal: Principal,
    automationId: Id<'aut'>,
    ifMatch: string | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    const { base } = await this.locate(principal, automationId);
    const expected = expectedVersionOf(ifMatch, undefined);
    const context = mutationContextOf(meta, principal.userId);
    await this.db.withTx(async (tx) => {
      const scope = withTxScope(base.org.scope, tx);
      const current = await this.lockAt(scope, automationId, expected);
      const deleted = await this.automations.softDelete(scope, automationId, principal.userId);
      if (deleted === undefined) throw notFound();
      // Runs waiting in a `delay` never resume (T506).
      await cancelWaitingRuns(this.db, scope, automationId, 'automation_deleted');
      await this.record(tx, deleted, 'automation.deleted', context, {
        before: snapshotOf(current, true),
        after: null,
      });
    });
  }

  async enable(
    principal: Principal,
    automationId: Id<'aut'>,
    ifMatch: string | undefined,
    meta: RequestMeta,
  ): Promise<AutomationDto> {
    return this.takeOverOrEnable(principal, automationId, true, 'enabled', ifMatch, meta);
  }

  async takeOver(
    principal: Principal,
    automationId: Id<'aut'>,
    input: TakeOverAutomationRequest,
    ifMatch: string | undefined,
    meta: RequestMeta,
  ): Promise<AutomationDto> {
    return this.takeOverOrEnable(
      principal,
      automationId,
      input.enable,
      'taken_over',
      ifMatch,
      meta,
    );
  }

  async disable(
    principal: Principal,
    automationId: Id<'aut'>,
    ifMatch: string | undefined,
    meta: RequestMeta,
  ): Promise<AutomationDto> {
    const { base } = await this.locate(principal, automationId);
    const expected = expectedVersionOf(ifMatch, undefined);
    const context = mutationContextOf(meta, principal.userId);
    await this.db.withTx(async (tx) => {
      const scope = withTxScope(base.org.scope, tx);
      const current = await this.lockAt(scope, automationId, expected);
      if (!current.enabled) return;
      const updated = await this.update0(scope, automationId, {
        updatedBy: principal.userId,
        enabled: false,
        disabledReason: null,
      });
      // Runs waiting in a `delay` are cancelled with it (SPEC §11.7, T506).
      await cancelWaitingRuns(this.db, scope, automationId, 'automation_disabled');
      await this.recordToggle(tx, updated, 'automation.disabled', context);
    });
    return this.reload(base.org.scope, automationId);
  }

  /**
   * Template check for the builder (CONTRACTS §21, BACKLOG T504): the same
   * check as saving, with the caller's permissions (the caller becomes
   * `run_as` when they save). Needs to manage an automation of the base;
   * `table_id` must be a table the caller reads (`404` otherwise). Never
   * returns record values.
   */
  async validateTemplate(
    principal: Principal,
    baseId: Id<'bse'>,
    input: ValidateAutomationTemplateRequest,
  ): Promise<ValidateAutomationTemplateResponse> {
    const base = await this.access.requireBase(principal, baseId, 'read');
    if (!managesAnyAutomation(base.access)) throw cannotManage();
    if (input.table_id !== null && base.access.tables[input.table_id] === undefined) {
      throw notFound();
    }
    const context = await this.schemaContext(base);
    if (input.table_id !== null && !context.tables.some((table) => table.id === input.table_id)) {
      throw notFound();
    }
    const digestRow = input.table_id !== null && input.row_fields !== null;
    // Trigger data and earlier step records (T505), only for a template on the trigger row.
    const sources: TemplateSources | null = digestRow
      ? null
      : {
          trigger: input.trigger_type === null ? [] : TRIGGER_REFERENCES[input.trigger_type],
          // `[@previous]` of a `record.updated` trigger (the record before the change).
          ...previousSourceOf(input.trigger_type, input.table_id),
          steps: new Map(
            input.steps
              .filter((step) => context.tables.some((table) => table.id === step.table_id))
              .map((step) => [step.id, step.table_id]),
          ),
          // `{{ [@digest] }}` of a `send_email` body with a digest (T514).
          ...(input.digest ? { digest: true } : {}),
          // `{{ [act_…] }}`: the text of an earlier `ai_generate_text` step (T911).
          texts: new Set(input.text_steps),
        };
    const snapshot = automationSnapshot(
      context,
      input.table_id,
      input.table_id === null || input.row_fields === null
        ? null
        : stepFieldsOf(context, input.table_id, input.row_fields),
      sources,
    );
    const { check, errors } = checkAutomationTemplate(
      input.template,
      snapshot,
      'template',
      input.form,
    );
    return {
      valid: errors.length === 0,
      stored: check.stored,
      display: check.display,
      placeholders: check.placeholders.map((placeholder) => ({
        index: placeholder.index,
        start: placeholder.start,
        length: placeholder.length,
        stored: placeholder.stored,
        display: placeholder.display,
        result_type: templateResultType(placeholder.type),
        fields: placeholder.dependencies
          .filter((dependency) => !isTemplateReferenceId(dependency.field_id))
          .map((dependency) => ({
            field_id: dependency.field_id as Id<'fld'>,
            link_path: [...dependency.link_path],
          })),
      })),
      errors,
    };
  }

  // --- Internals --------------------------------------------------------------------

  /**
   * Enable (`enable = true`, reason `enabled`) and take over (reason
   * `taken_over`): the caller becomes `run_as`, so the stored definition
   * must be valid with the caller's access (ADR-25 §2, §6). Nothing changes
   * — no version, no event — when the caller already is `run_as` and the
   * state is already the requested one.
   */
  private async takeOverOrEnable(
    principal: Principal,
    automationId: Id<'aut'>,
    enable: boolean,
    reason: Extract<AutomationRunAsReason, 'enabled' | 'taken_over'>,
    ifMatch: string | undefined,
    meta: RequestMeta,
  ): Promise<AutomationDto> {
    const { base, row } = await this.locate(principal, automationId);
    const { definition, triggerTableId } = await this.validate(
      base,
      storedDefinitionOf(row),
      row.id,
    );
    if (!canManageAutomation(base.access, triggerTableId)) throw cannotManage();
    if (enable && definition.actions.length === 0) throw noActions();
    const expected = expectedVersionOf(ifMatch, undefined);
    const context = mutationContextOf(meta, principal.userId);
    await this.db.withTx(async (tx) => {
      const scope = withTxScope(base.org.scope, tx);
      const current = await this.lockAt(scope, automationId, expected);
      const turnsOn = enable && !current.enabled;
      const movesRunAs = current.run_as_user_id !== principal.userId;
      // Take over resolves `run_as_lost_access` (the caller was just validated);
      // other reasons (circuit breaker) stay until the automation is turned on.
      const clearsLostAccess =
        reason === 'taken_over' && current.disabled_reason === 'run_as_lost_access';
      if (!turnsOn && !movesRunAs && !clearsLostAccess) return;
      const updated = await this.update0(scope, automationId, {
        updatedBy: principal.userId,
        ...(turnsOn || clearsLostAccess ? { disabledReason: null } : {}),
        ...(turnsOn ? { enabled: true } : {}),
        ...(movesRunAs ? { runAs: principal.userId } : {}),
      });
      if (movesRunAs) {
        await this.recordRunAs(tx, updated, current.run_as_user_id, reason, context);
      }
      if (turnsOn) await this.recordToggle(tx, updated, 'automation.enabled', context);
    });
    return this.reload(base.org.scope, automationId);
  }

  /**
   * The automation if the caller may manage it: `404` when it does not
   * exist in the caller's organizations, its base is not readable or its
   * trigger table is hidden; `403` when visible but not manageable —
   * `404` too with `hideUnmanaged` (the run log, BACKLOG T518: runs carry
   * record data, "Quy ước S5").
   */
  async locate(
    principal: Principal,
    automationId: Id<'aut'>,
    hideUnmanaged = false,
  ): Promise<Located> {
    for (const membership of await this.access.memberships(principal)) {
      const row = await this.automations.get(orgScope(membership.organizationId), automationId);
      if (row === undefined) continue;
      const base = await this.access.findBase(principal, row.base_id);
      if (base === undefined || !canSeeAutomation(base.access, row.trigger_table_id)) {
        throw notFound();
      }
      if (!canManageAutomation(base.access, row.trigger_table_id)) {
        throw hideUnmanaged ? notFound() : cannotManage();
      }
      return { base, row };
    }
    throw notFound();
  }

  /**
   * Validates a definition against the base and the caller's access, else
   * `422`. `send_email` steps also need a usable sender identity (or the
   * system sender) and a footer the policies allow (T514, ADR-33);
   * `send_notification` steps, known users and groups (T515); `send_telegram`
   * and `http_request` steps, secrets usable in the base (T516, T606); AI
   * steps, AI and record data on (T911).
   * Also the check of an AI draft (T908): what `create` would accept.
   */
  async validate(
    base: BaseAccess,
    definition: AutomationDefinition,
    automationId: Id<'aut'> | null,
  ): Promise<{ definition: AutomationDefinition; triggerTableId: Id<'tbl'> | null }> {
    // `webhook.received` (T604, "Quyết định S5c" #7): base admins only, refused
    // before the check so a table manager learns nothing about the base's hooks.
    if (definition.trigger.type === 'webhook.received' && !base.access.is_admin) {
      throw cannotManage();
    }
    const result = validateAutomationDefinition(
      definition,
      await this.validationContext(base, definition),
    );
    const errors = result.ok ? [] : [...result.errors];
    const checked = result.ok ? result.definition : definition;
    if (sendEmailSteps(checked).length > 0) {
      const organization = await this.organizations.findById(base.org.organizationId);
      errors.push(
        ...(await checkSendEmailSenders(
          {
            identities: this.identities,
            mail: this.config.mail,
            instanceFooterPolicy: this.config.email.automationFooter,
          },
          base.org.scope,
          {
            baseId: base.base.id,
            definition: checked,
            orgSettings: orgEmailSettingsOf(organization?.settings),
          },
        )),
        // Body images (T534): assets uploaded for this automation, at most EMAIL_MAX_INLINE_IMAGES.
        ...(await checkSendEmailImages({ assets: this.emailAssets }, base.org.scope, {
          automationId,
          definition: checked,
          maxInlineImages: this.config.email.maxInlineImages,
        })),
      );
    }
    // `send_notification` (T515): fixed users and groups of this organization.
    errors.push(...(await checkSendNotificationRecipients(this.db, base.org.scope, checked)));
    // `send_telegram` (T516): a bot of the organization shared with this base.
    errors.push(
      ...(await checkSendTelegramSecrets(this.secrets, base.org.scope, {
        baseId: base.base.id,
        definition: checked,
      })),
    );
    // `http_request` (T606): `http_header` / `webhook_signing` secrets shared with this base.
    errors.push(
      ...(await checkHttpRequestSecrets(this.secrets, base.org.scope, {
        baseId: base.base.id,
        definition: checked,
      })),
    );
    // AI actions (T911): AI available and allowed to see record values.
    errors.push(...(await checkAiActions(this.aiSettings, base.org.scope, checked)));
    if (!result.ok || errors.length > 0) throw automationInvalid(errors);
    return { definition: result.definition, triggerTableId: result.triggerTableId };
  }

  private async validationContext(
    base: BaseAccess,
    definition: AutomationDefinition,
  ): Promise<AutomationValidationContext> {
    const scope = base.org.scope;
    const context = await this.schemaContext(base);
    const views = new Map<string, AutomationViewMeta>();
    if (definition.trigger.type === 'form.submitted') {
      const view = await this.views.getById(scope, definition.trigger.view_id);
      if (view !== undefined && context.tables.some((table) => table.id === view.table_id)) {
        views.set(view.id, {
          id: view.id,
          table_id: view.table_id,
          type: view.type,
          is_personal: view.is_personal,
        });
      }
    }
    // `webhook.received` (T604): the hook must be live in this base.
    const incomingWebhookIds = new Set<string>();
    if (definition.trigger.type === 'webhook.received') {
      const hook = await this.hooks.findById(scope, definition.trigger.incoming_webhook_id);
      if (hook?.base_id === base.base.id) incomingWebhookIds.add(hook.id);
    }
    return { ...context, views, incomingWebhookIds };
  }

  /**
   * Fields of the base the caller reads (EffectiveAccess) and that are not
   * locked computed fields for them (T457), by table: what a run log may
   * show them (BACKLOG T518).
   */
  async readableFieldsOf(base: BaseAccess): Promise<Map<string, ReadonlySet<string>>> {
    const context = await this.schemaContext(base);
    const readable = new Map<string, ReadonlySet<string>>();
    for (const [tableId, table] of Object.entries(base.access.tables)) {
      readable.set(
        tableId,
        // EffectiveAccess lists only the fields the caller reads (CONTRACTS §5A).
        new Set(
          Object.keys(table.fields).filter(
            (fieldId) => context.lockedFieldIds?.has(fieldId) !== true,
          ),
        ),
      );
    }
    return readable;
  }

  /** Tables, fields and the caller's access, computed fields locked for them (T457). */
  async schemaContext(base: BaseAccess): Promise<AutomationValidationContext> {
    const scope = base.org.scope;
    const rows = await loadBaseSchemaRows(this.db, scope, base.base.id);
    const locked = new Set<string>();
    if (rows.fields.some(isComputedRow)) {
      const readable = readabilityOf(base.access);
      const strict = strictComputedPermissionsOf(base.base.settings);
      for (const table of rows.tables) {
        for (const id of lockedComputedFieldIds(rows, table.id, readable, strict)) locked.add(id);
      }
    }
    return {
      tables: rows.tables,
      fields: rows.fields,
      access: base.access,
      lockedFieldIds: locked,
      // AI action prompts read the same record only, like AI fields (T911).
      aiCrossRecord: (fieldIds) => aiCrossRecordSources(fieldIds, rows),
    };
  }

  /** Locks the automation; `409 VERSION_CONFLICT` when `expected` is not its version. */
  private async lockAt(
    scope: OrgScope,
    automationId: Id<'aut'>,
    expected: number | undefined,
  ): Promise<AutomationRow> {
    const current = await this.automations.lockForUpdate(scope, automationId);
    if (current === undefined) throw notFound();
    if (expected !== undefined && expected !== current.version) {
      const named = await this.automations.get(scope, automationId);
      throw new AppError('VERSION_CONFLICT', {
        detail: 'The automation was changed by someone else.',
        errors: [
          {
            path: 'version',
            code: 'VERSION_CONFLICT',
            message: 'The automation was changed by someone else',
            params: {
              current_version: current.version,
              version: expected,
              updated_at: iso(current.updated_at),
              updated_by:
                named === undefined ? null : { id: named.updated_by, name: named.updated_by_name },
            },
          },
        ],
      });
    }
    return current;
  }

  private async update0(
    scope: OrgScope,
    automationId: Id<'aut'>,
    patch: UpdateAutomationInput,
  ): Promise<AutomationRow> {
    const updated = await this.automations.update(scope, automationId, patch);
    if (updated === undefined) throw notFound();
    return updated;
  }

  private async reload(scope: OrgScope, automationId: Id<'aut'>): Promise<AutomationDto> {
    const row = await this.automations.get(scope, automationId);
    if (row === undefined) throw notFound();
    return this.dtoOf(row);
  }

  private record(
    tx: Tx,
    row: AutomationRow,
    type: EventType,
    context: AuditContext,
    change: { before: JsonObject | null; after: JsonObject | null; data?: JsonObject },
  ): Promise<void> {
    return recordChange(tx, {
      type,
      organizationId: row.organization_id,
      baseId: row.base_id,
      tableId: row.trigger_table_id,
      entityType: 'automation',
      entityId: row.id,
      context,
      before: change.before,
      after: change.after,
      ...(change.data === undefined ? {} : { data: change.data }),
    });
  }

  /** `automation.enabled` / `automation.disabled` (by a person: `disabled_reason = null`). */
  private recordToggle(
    tx: Tx,
    row: AutomationRow,
    type: 'automation.enabled' | 'automation.disabled',
    context: AuditContext,
  ): Promise<void> {
    return this.record(tx, row, type, context, {
      before: { enabled: !row.enabled },
      after: { enabled: row.enabled, disabled_reason: row.disabled_reason },
      data: { run_as_user_id: row.run_as_user_id },
    });
  }

  /** `automation.run_as_changed` (ADR-25 §7). */
  private recordRunAs(
    tx: Tx,
    row: AutomationRow,
    previous: Id<'usr'> | null,
    reason: AutomationRunAsReason,
    context: AuditContext,
  ): Promise<void> {
    return this.record(tx, row, 'automation.run_as_changed', context, {
      before: previous === null ? null : { run_as_user_id: previous },
      after: { run_as_user_id: row.run_as_user_id, reason },
      data: { reason, run_as_user_id: row.run_as_user_id, previous_run_as_user_id: previous },
    });
  }

  private dtoOf(row: AutomationListRow): AutomationDto {
    return {
      id: row.id,
      base_id: row.base_id,
      name: row.name,
      description: row.description,
      enabled: row.enabled,
      disabled_reason: row.disabled_reason,
      definition: row.definition as unknown as AutomationDefinition,
      version: row.version,
      run_as: { id: row.run_as_user_id, name: row.run_as_name },
      run_as_since: iso(row.run_as_since),
      created_by: { id: row.created_by, name: row.created_by_name },
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    };
  }
}
