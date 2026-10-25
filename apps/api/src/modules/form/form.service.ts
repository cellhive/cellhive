import {
  SUBMISSION_LIMIT_REACHED,
  type FormSubmissionStatus,
  type FormSubmitRequest,
  type FormSubmitResponse,
  type FormSubmitTokenDto,
  type Id,
  isId,
  type ShareFormMemberList,
  type ProblemErrorItem,
  type StoredFormSettings,
  type SubmissionLimit,
} from '@cellhive/contracts';
import { isViewVisible } from '@cellhive/permissions';
import {
  FieldsRepository,
  FormSubmissionsRepository,
  GroupMembersRepository,
  orgScope,
  RecordMutationService,
  storedViewConfigOf,
  submissionPeriod,
  ViewsRepository,
  withTxScope,
  type AppConfig,
  type AuditContext,
  type FormUploadSession,
  type OrgScope,
  type RecordAccessContext,
  type Tx,
  type ViewRow,
} from '@cellhive/server-core';
import { AppError, isAppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { AccessService, notFound, type BaseAccess } from '../../common/access/access.service.js';
import { recordChange } from '../../common/access/change-log.js';
import { recordAccessContextOf } from '../../common/access/record-access-context.js';
import { firstTimeZone, settingOf } from '../../common/access/time-zone.js';
import { auditContextOf, type RequestMeta } from '../../common/auth/request-meta.js';
import { AppLogger } from '../../common/logging/app-logger.js';
import { SchemaAccess } from '../../common/schema/schema-access.js';
import { APP_CONFIG } from '../../common/tokens.js';
import { ShareAccessService } from '../share/share-access.service.js';
import { hidesPrivateQuestions, PRIVATE_QUESTION_TYPES } from '../share/share-form-questions.js';
import {
  ShareLinkResolver,
  type ResolvedShareLink,
} from '../share-link/share-link-resolver.service.js';

import { FormSpamGuard, type ClaimedSubmitToken } from './form-spam-guard.js';

import type { Principal } from '../../common/auth/principal.js';
import type { FastifyRequest } from 'fastify';

/** Everything one submission needs, however it arrived. */
interface Submission {
  readonly scope: OrgScope;
  readonly base: BaseAccess;
  readonly view: ViewRow;
  readonly form: StoredFormSettings;
  readonly access: RecordAccessContext;
  readonly audit: AuditContext;
  /** The signed-in person the submission is attributed to; `null` = anonymous. */
  readonly submitter: Id<'usr'> | null;
  readonly shareLinkId: Id<'shl'> | null;
  readonly fields: Readonly<Record<string, unknown>>;
  /**
   * `user` and `link` questions of a form link (T321, T410): `hidden` on
   * links outside the organization (not on the form for this submitter),
   * `org` on `org` links (`user` answers limited to the people who can open
   * the base; `link` answers checked by the record service under the
   * creator's access to the linked table). Omitted on the member route.
   */
  readonly privateQuestions?: 'hidden' | 'org';
  /** Link submissions (T410): attachment answers must be uploads of this session. */
  readonly formUpload?: FormUploadSession;
}

function formNotFound(): AppError {
  return new AppError('NOT_FOUND', { detail: 'The form does not exist.' });
}

function signInRequired(): AppError {
  return new AppError('UNAUTHENTICATED', { detail: 'Sign in to fill in this form.' });
}

/** Raw values that count as "not filled in" for a field the form requires. */
function isEmptyAnswer(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Rewrites the paths of a record-service error for a form: `records[0].fields.X`
 * becomes `fields.X`, `records[0]` becomes `fields`.
 */
function formError(error: AppError): AppError {
  if (error.errors === undefined) return error;
  const errors: ProblemErrorItem[] = error.errors.map((item) => ({
    ...item,
    path: item.path.startsWith('records[0].')
      ? item.path.slice('records[0].'.length)
      : item.path === 'records[0]'
        ? 'fields'
        : item.path,
  }));
  return new AppError(error.code, {
    ...(error.detail === undefined ? {} : { detail: error.detail }),
    errors,
    ...(error.params === undefined ? {} : { params: error.params }),
    ...(error.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: error.retryAfterSeconds }),
    cause: error,
  });
}

/**
 * Form submissions (SPEC §8, §15A; CONTRACTS §17; BACKLOG T306).
 *
 * - Members: `POST /views/:viewId/submit` needs to see the form view (else
 *   `404`) and, through `RecordMutationService`, `add` on the table and
 *   `create`/`edit` on the submitted fields (`403`), with the record rule
 *   applied to the new record (P13/P14).
 * - Links: `POST /shares/:token/submit` acts with the link's access
 *   (creator ∩ form fields, create only; `404`/`410` from
 *   `ShareLinkResolver`). Audience `org` and `require_login` need a session
 *   (`401`); an `org` link refuses people outside the organization (`404`).
 * - One record per submission, always typecast with the base locale, never
 *   creating select options; only fields of the form (`422 UNKNOWN_FIELD`);
 *   the form's `required` on top of the table's.
 * - Signed-in submitters (member route, `org` links, `require_login`) are
 *   the actor and `created_by`, and are tracked for the per-person limit;
 *   other link submissions are anonymous: actor `share_link`, `created_by`
 *   `null`. Link submissions carry `via.share_link_id`.
 * - `form.submitted` + audit in the record's transaction; the response is
 *   the form's closing settings, never the record.
 */
@Injectable()
export class FormService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AccessService) private readonly accessService: AccessService,
    @Inject(SchemaAccess) private readonly schemaAccess: SchemaAccess,
    @Inject(ViewsRepository) private readonly views: ViewsRepository,
    @Inject(FieldsRepository) private readonly fields: FieldsRepository,
    @Inject(GroupMembersRepository) private readonly groupMembers: GroupMembersRepository,
    @Inject(FormSubmissionsRepository) private readonly submissions: FormSubmissionsRepository,
    @Inject(RecordMutationService) private readonly mutation: RecordMutationService,
    @Inject(ShareLinkResolver) private readonly resolver: ShareLinkResolver,
    @Inject(FormSpamGuard) private readonly guard: FormSpamGuard,
    @Inject(ShareAccessService) private readonly shareAccess: ShareAccessService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  // --- Member route -------------------------------------------------------------------

  async submitAsMember(
    principal: Principal,
    viewId: Id<'viw'>,
    body: FormSubmitRequest,
    meta: RequestMeta,
  ): Promise<FormSubmitResponse> {
    await this.guard.hitUser(principal.userId);
    const { base, view } = await this.locateForm(principal, viewId);
    const form = this.formOf(view);
    if (this.isSpam(body, view)) return closingOf(form);
    const own = await recordAccessContextOf(
      { groupMembers: this.groupMembers, config: this.config },
      principal.user,
      base,
    );
    const context = auditContextOf(meta, { type: 'user', id: principal.userId });
    await this.submit({
      scope: base.org.scope,
      base,
      view,
      form,
      access: withoutOptionEditing(own, view.table_id),
      audit: { ...context, batch_id: context.request_id },
      submitter: principal.userId,
      shareLinkId: null,
      fields: body.fields,
    });
    return closingOf(form);
  }

  /**
   * `GET /views/:viewId/submission-status`: whether the member already
   * submitted in the current period of the form's limit — the count the
   * submit route checks, read without a lock (submitting checks again).
   */
  async submissionStatus(principal: Principal, viewId: Id<'viw'>): Promise<FormSubmissionStatus> {
    const { base, view } = await this.locateForm(principal, viewId);
    return this.statusOf(base, view, this.formOf(view), principal.userId);
  }

  /** The submission status of `userId` for a form: the count the submit routes check. */
  private async statusOf(
    base: BaseAccess,
    view: ViewRow,
    form: StoredFormSettings,
    userId: Id<'usr'>,
  ): Promise<FormSubmissionStatus> {
    const limit = form.submission_limit;
    const period =
      limit === 'none'
        ? null
        : submissionPeriod(
            limit,
            this.guard.now(),
            baseTimeZoneOf(base, this.config.defaults.timezone),
          );
    if (period === null) return { limit, reached: false, next_allowed_at: null };
    const count = await this.submissions.countSince(base.org.scope, view.id, userId, period.start);
    return {
      limit,
      reached: count > 0,
      next_allowed_at: count > 0 && period.next !== null ? period.next.toISOString() : null,
    };
  }

  // --- Link routes --------------------------------------------------------------------

  /**
   * `GET /shares/:token/submit-token`: a submit token for a working form
   * link. Checked like the other share reads (CONTRACTS §16A, T319): per-IP
   * read limit (unknown tokens included), `404`/`410`, audience `org`
   * (`401`/`404`); the password is not needed yet (`submit` checks it).
   */
  async submitToken(token: string, request: FastifyRequest): Promise<FormSubmitTokenDto> {
    const { link } = await this.shareAccess.open(token, request, { allowLocked: true });
    if (link.link.target_type !== 'form') throw formNotFound();
    return this.guard.issue(link.link.id);
  }

  /**
   * `GET /shares/:token/submission-status` (T321): the member route's status
   * for the person filling in a form link, checked like `submit-token`
   * (read limit, `404`/`410`, audience `org`; no password needed). Forms
   * with identified submitters (`org` link or `require_login`) need a
   * session (`401`); anonymous ones have no per-person limit (`none`).
   */
  async submissionStatusViaLink(
    token: string,
    request: FastifyRequest,
  ): Promise<FormSubmissionStatus> {
    const { link } = await this.shareAccess.open(token, request, { allowLocked: true });
    if (link.link.target_type !== 'form') throw formNotFound();
    const form = this.formOf(link.view);
    const identified = link.link.audience === 'org' || form.require_login;
    if (!identified) return { limit: 'none', reached: false, next_allowed_at: null };
    const principal = request.principal;
    if (principal === undefined) throw signInRequired();
    return this.statusOf(link.creator, link.view, form, principal.userId);
  }

  /**
   * `GET /shares/:token/members` (T321): the people a `user` question of an
   * `org` form link offers — the members who can open the base, `{ id,
   * display_name }` only. Checked like `meta` (read limit, `404`/`410`,
   * audience, password). Links outside the organization, view links and
   * forms without a `user` question the link can write → `404`.
   */
  async membersViaLink(token: string, request: FastifyRequest): Promise<ShareFormMemberList> {
    const { link } = await this.shareAccess.open(token, request);
    if (link.link.target_type !== 'form' || hidesPrivateQuestions(link.link)) {
      throw formNotFound();
    }
    const userFields = await this.userQuestionFields(link, this.formOf(link.view));
    if (userFields.size === 0) throw formNotFound();
    const members = await this.accessService.membersWithAccess(link.creator);
    return {
      items: members.map((member) => ({
        id: member.user.id,
        display_name: member.user.display_name,
      })),
    };
  }

  /** Fields of the `user` questions of a form link that the link can write. */
  private async userQuestionFields(
    link: ResolvedShareLink,
    form: StoredFormSettings,
  ): Promise<Set<string>> {
    const tableId = link.view.table_id;
    const writable = link.access.access.tables[tableId]?.fields ?? {};
    const users = new Set(
      (await this.fields.listByTable(link.scope, tableId))
        .filter((field) => field.type === 'user')
        .map((field) => field.id as string),
    );
    return new Set(
      form.fields
        .map((item) => item.field)
        .filter((id) => users.has(id) && writable[id as Id<'fld'>] !== undefined),
    );
  }

  async submitViaLink(
    token: string,
    principal: Principal | undefined,
    body: FormSubmitRequest,
    meta: RequestMeta,
    request: FastifyRequest,
  ): Promise<FormSubmitResponse> {
    await this.guard.hitIp(meta.ip);
    const link = await this.resolver.resolve(token);
    if (link.link.target_type !== 'form') throw formNotFound();
    const form = this.formOf(link.view);

    // Who may submit (CONTRACTS §17): `org` links need a member of the
    // organization, `require_login` any signed-in user.
    const identified = link.link.audience === 'org' || form.require_login;
    if (identified && principal === undefined) throw signInRequired();
    if (link.link.audience === 'org') {
      const org = await this.accessService.findOrg(
        principal as Principal,
        link.scope.organizationId,
      );
      if (org === undefined)
        throw new AppError('NOT_FOUND', { detail: 'The link does not exist.' });
    }
    // Password links need the unlock cookie of T305 (and its CSRF token).
    this.shareAccess.checkUnlock(link, request);
    if (this.isSpam(body, link.view)) return closingOf(form);

    const claimed = await this.guard.claim(link.link.id, body.submit_token);
    const submitter = identified ? (principal as Principal).userId : null;
    const context = auditContextOf(
      meta,
      submitter === null
        ? { type: 'share_link', id: link.link.id }
        : { type: 'user', id: submitter },
    );
    try {
      await this.submit({
        scope: link.scope,
        base: link.creator,
        view: link.view,
        form,
        access: link.recordAccess,
        audit: { ...context, via: { share_link_id: link.link.id }, batch_id: context.request_id },
        submitter,
        shareLinkId: link.link.id,
        fields: body.fields,
        privateQuestions: hidesPrivateQuestions(link.link) ? 'hidden' : 'org',
        formUpload: { shareLinkId: link.link.id, session: claimed.session },
      });
    } catch (error) {
      await this.release(claimed);
      throw error;
    }
    return closingOf(form);
  }

  // --- Shared -------------------------------------------------------------------------

  private async submit(input: Submission): Promise<void> {
    const tableId = input.view.table_id;
    const tableFields = await this.fields.listByTable(input.scope, tableId);
    const active = new Set(tableFields.map((field) => field.id as string));
    const userFields = new Set(
      tableFields.filter((field) => field.type === 'user').map((field) => field.id as string),
    );
    const hidden = new Set(
      input.privateQuestions === 'hidden'
        ? tableFields
            .filter((field) => PRIVATE_QUESTION_TYPES.has(field.type))
            .map((field) => field.id as string)
        : [],
    );
    const formFields = input.form.fields.filter(
      (item) => active.has(item.field) && !hidden.has(item.field),
    );
    this.checkAnswers(input, formFields);
    if (input.privateQuestions === 'org') await this.checkPeople(input, userFields);

    const now = this.guard.now();
    const limit = input.form.submission_limit;
    const tracked = input.submitter !== null;
    const zone = baseTimeZoneOf(input.base, this.config.defaults.timezone);
    // Early answer before validating the values; checked again under a lock below.
    if (tracked && limit !== 'none') {
      await this.checkLimit(input.scope, input, limit, now, zone);
    }

    try {
      await this.mutation.create(
        input.scope,
        tableId,
        input.access,
        { field_key_type: 'id', typecast: true, records: [{ fields: input.fields }] },
        input.audit,
        {
          readBack: false,
          ...(input.formUpload === undefined ? {} : { formUpload: input.formUpload }),
          onCreated: async (tx, ids) => {
            await this.afterCreate(tx, input, ids[0] as Id<'rec'>, { now, limit, zone });
          },
        },
      );
    } catch (error) {
      throw isAppError(error) ? formError(error) : error;
    }
  }

  /** Keys must be fields of the form; the form's required fields must have an answer. */
  private checkAnswers(
    input: Submission,
    formFields: readonly StoredFormSettings['fields'][number][],
  ): void {
    const onForm = new Set(formFields.map((item) => item.field));
    const unknown: ProblemErrorItem[] = Object.keys(input.fields)
      .filter((key) => !onForm.has(key))
      .map((key) => ({
        path: `fields.${key}`,
        code: 'UNKNOWN_FIELD',
        // Same message for a field of the table outside the form and a missing one.
        message: 'Field does not exist',
      }));
    if (unknown.length > 0) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'The submission names fields that are not on the form.',
        errors: unknown,
      });
    }
    // Required answers, for the fields the submitter can see: a form field
    // outside the access is not shown to them (the record service still
    // enforces fields required by the table).
    const visible = input.access.resolved.access.tables[input.view.table_id]?.fields ?? {};
    const missing: ProblemErrorItem[] = formFields
      .filter((item) => item.required && visible[item.field as Id<'fld'>] !== undefined)
      .filter((item) => isEmptyAnswer(input.fields[item.field]))
      .map((item) => ({
        path: `fields.${item.field}`,
        code: 'REQUIRED_FIELD_MISSING',
        message: 'A value is required',
      }));
    if (missing.length > 0) {
      throw new AppError('REQUIRED_FIELD_MISSING', {
        detail: 'Required fields of the form have no value.',
        errors: missing,
      });
    }
  }

  /**
   * Answers of `user` questions through an `org` form link (T321): only ids
   * of people who can open the base (the list `GET /shares/:token/members`
   * offers) — an email or anyone else is `422 INVALID_CELL_VALUE` /
   * `USER_NOT_FOUND`, never telling who is in the organization.
   */
  private async checkPeople(input: Submission, userFields: ReadonlySet<string>): Promise<void> {
    const answers = Object.entries(input.fields).filter(([key]) => userFields.has(key));
    if (answers.length === 0) return;
    const members = new Set(
      (await this.accessService.membersWithAccess(input.base)).map(
        (member) => member.user.id as string,
      ),
    );
    const refused: ProblemErrorItem[] = answers
      .filter(([, value]) => userEntriesOf(value).some((entry) => !members.has(entry)))
      .map(([key]) => ({
        path: `fields.${key}`,
        code: 'USER_NOT_FOUND',
        message: 'No member of the base with this id',
      }));
    if (refused.length > 0) {
      throw new AppError('INVALID_CELL_VALUE', {
        detail: 'Some people cannot be picked on this form.',
        errors: refused,
      });
    }
  }

  private async checkLimit(
    scope: OrgScope,
    input: Submission,
    limit: SubmissionLimit,
    now: Date,
    zone: string,
  ): Promise<void> {
    const period = submissionPeriod(limit, now, zone);
    if (period === null || input.submitter === null) return;
    const count = await this.submissions.countSince(
      scope,
      input.view.id,
      input.submitter,
      period.start,
    );
    if (count > 0) {
      throw new AppError('SUBMISSION_LIMIT_REACHED', {
        detail: 'You have already filled in this form.',
        errors: [
          {
            path: '',
            code: SUBMISSION_LIMIT_REACHED,
            message: 'The submission limit of the form is reached',
            params: {
              limit,
              next_allowed_at: period.next === null ? null : period.next.toISOString(),
            },
          },
        ],
      });
    }
  }

  /** In the record's transaction: the per-person limit, tracking, `form.submitted` + audit. */
  private async afterCreate(
    tx: Tx,
    input: Submission,
    recordId: Id<'rec'>,
    at: { readonly now: Date; readonly limit: SubmissionLimit; readonly zone: string },
  ): Promise<void> {
    const scope = withTxScope(input.scope, tx);
    if (input.submitter !== null) {
      await this.submissions.lockPerson(scope, input.view.id, input.submitter);
      if (at.limit !== 'none') await this.checkLimit(scope, input, at.limit, at.now, at.zone);
      await this.submissions.insert(scope, {
        baseId: input.base.base.id,
        viewId: input.view.id,
        userId: input.submitter,
        shareLinkId: input.shareLinkId,
        recordId,
        submittedAt: at.now,
      });
    }
    await recordChange(tx, {
      type: 'form.submitted',
      organizationId: input.scope.organizationId,
      baseId: input.base.base.id,
      tableId: input.view.table_id,
      entityType: 'form',
      entityId: input.view.id,
      context: input.audit,
      after: { record_id: recordId, share_link_id: input.shareLinkId },
      data: {
        view_id: input.view.id,
        record_id: recordId,
        share_link_id: input.shareLinkId,
        submitted_by: input.submitter,
      },
    });
  }

  /** A filled honeypot: answered like a success, nothing written (CONTRACTS §17). */
  private isSpam(body: FormSubmitRequest, view: ViewRow): boolean {
    if (body.honeypot === undefined || body.honeypot === '') return false;
    this.logger.info({ view_id: view.id }, 'form submission dropped: honeypot filled');
    return true;
  }

  private async release(claimed: ClaimedSubmitToken): Promise<void> {
    await this.guard.release(claimed);
  }

  private formOf(view: ViewRow): StoredFormSettings {
    const form = storedViewConfigOf(view.type, view.config).form;
    if (view.type !== 'form' || form === undefined) throw formNotFound();
    return form;
  }

  /** A form view the member can see (`visible_views`), else `404`. */
  private async locateForm(
    principal: Principal,
    viewId: Id<'viw'>,
  ): Promise<{ base: BaseAccess; view: ViewRow }> {
    for (const membership of await this.accessService.memberships(principal)) {
      const view = await this.views.getById(orgScope(membership.organizationId), viewId);
      if (view === undefined) continue;
      if (view.type !== 'form') throw formNotFound();
      const { base } = await this.schemaAccess.requireTable(principal, view.table_id, 'read');
      const tableAccess = base.access.tables[view.table_id];
      const visible = view.is_personal
        ? view.owner_id === principal.userId
        : tableAccess !== undefined && isViewVisible(tableAccess, view.id);
      if (!visible) throw notFound();
      return { base, view };
    }
    throw formNotFound();
  }
}

function closingOf(form: StoredFormSettings): FormSubmitResponse {
  return { success_message: form.success_message, redirect_url: form.redirect_url };
}

/** Zone of the per-person limit: the base's, else the organization's, else the instance default. */
function baseTimeZoneOf(base: BaseAccess, fallback: string): string {
  const zones = [
    settingOf(base.base.settings, 'timezone'),
    settingOf(base.org.membership.settings, 'timezone'),
  ];
  return firstTimeZone(zones, fallback);
}

/**
 * The people named by a raw `user` answer (typecast input, CONTRACTS §2):
 * ids as they are, anything else (an email, `{ email }`) as `''` so that it
 * is refused. Values of other shapes are left to the record service.
 */
function userEntriesOf(value: unknown): string[] {
  const entryOf = (item: unknown): string[] => {
    if (typeof item === 'string') {
      const text = item.trim();
      return text === '' ? [] : [isId('usr', text) ? text : ''];
    }
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      const id = (item as Record<string, unknown>)['id'];
      return [typeof id === 'string' && isId('usr', id) ? id : ''];
    }
    return [];
  };
  if (typeof value === 'string') return value.split(/[,;]/).flatMap(entryOf);
  if (Array.isArray(value)) return value.flatMap(entryOf);
  return [];
}

/** `access` without the right to create select options on the table (forms never create them). */
function withoutOptionEditing(
  access: RecordAccessContext,
  tableId: Id<'tbl'>,
): RecordAccessContext {
  const table = access.resolved.access.tables[tableId];
  if (table === undefined) return access;
  return {
    ...access,
    resolved: {
      ...access.resolved,
      access: {
        ...access.resolved.access,
        tables: {
          ...access.resolved.access.tables,
          [tableId]: { ...table, option_edit_fields: [] },
        },
      },
    },
  };
}
