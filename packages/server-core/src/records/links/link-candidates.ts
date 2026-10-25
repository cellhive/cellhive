import {
  linkCandidatesRequestSchema,
  MAX_LINK_CANDIDATE_FIELDS,
  type Id,
  type LinkCandidatesRequest,
} from '@cellhive/contracts';
import { linkCellLimit, type LocaleContext, type UserRef } from '@cellhive/field-types';
import { sql, type RawBuilder, type SqlBool } from 'kysely';

import { REQUEST_STATEMENT_TIMEOUT_MS, type Db, type Tx } from '../../db/create-db.js';
import { isStatementTimeout, SQLSTATE, sqlStateOf } from '../../db/pg-errors.js';
import { withTxScope, type OrgScope } from '../../db/repository.js';
import { AppError } from '../../errors/app-error.js';
import { zodIssuesToProblemErrors } from '../../errors/zod-issues.js';
import { compileToSql } from '../../query/index.js';
import { FieldsRepository } from '../../schema/fields.repository.js';
import { TablesRepository } from '../../schema/tables.repository.js';
import { MemberDirectoryRepository } from '../member-directory.repository.js';
import {
  buildTableModel,
  readable,
  resolveRule,
  ruleSql,
  type FieldModel,
} from '../table-model.js';

import { LinkFilterMeta, rulesOf } from './link-filters.js';
import { toLinkFieldModel, type LinkFieldModel } from './link-model.js';
import { junctionRef, titleOf, titleUserIds } from './link-reader.js';
import {
  accessibleTable,
  dataTableRef,
  LinkTargets,
  relatedAccessContext,
  TARGET_ALIAS,
  targetReadableSql,
  type LinkTarget,
} from './link-targets.js';
import { recordFilterSql } from './record-filter.js';

import type { TableRow } from '../../db/schema.js';
import type { RecordAccessContext } from '../types.js';
import type { ResolveContext } from '@cellhive/filter-dsl';
import type { TableAccess } from '@cellhive/permissions';

/** Aliases of the junction / the field's own table. Code constants, never input. */
const J = 'j';
const SOURCE_ALIAS = 's';

/** The request of {@link LinkCandidateReader.read} (`POST /fields/:fieldId/link-candidates`). */
export type LinkCandidatesInput = Partial<LinkCandidatesRequest>;

/** One offered record of the linked table. */
export interface LinkCandidateOutput {
  readonly id: Id<'rec'>;
  readonly title: string | null;
  readonly fields: Record<string, unknown>;
  readonly linked: boolean;
  readonly full: boolean;
  readonly selectable: boolean;
}

/** The candidate page (CONTRACTS §2, BACKLOG T402). */
export interface LinkCandidatesOutput {
  readonly items: LinkCandidateOutput[];
  readonly fields: { readonly id: Id<'fld'>; readonly name: string; readonly type: string }[];
  readonly offset: number;
  readonly limit: number;
  readonly has_more: boolean;
  readonly cell: { readonly count: number; readonly limit: number } | null;
}

export interface LinkCandidateReaderOptions {
  /** `statement_timeout` of the read; default `REQUEST_STATEMENT_TIMEOUT_MS`. */
  readonly statementTimeoutMs?: number;
  /** Clock of date operands (`record_filter`, read rules). */
  readonly now?: () => Date;
}

const notFound = () => new AppError('NOT_FOUND', { detail: 'The field does not exist.' });
const recordNotFound = () => new AppError('NOT_FOUND', { detail: 'The record does not exist.' });

interface PageRow extends Record<string, unknown> {
  readonly __id: Id<'rec'>;
  readonly selectable: boolean;
}

/**
 * Records a link picker may offer for one link field (BACKLOG T402,
 * CONTRACTS §2): live records of the linked table the caller reads (table
 * access + read rule), matching the field's `record_filter` resolved for the
 * caller, optionally narrowed by an unaccented search of the primary field
 * (the trigram index) — or, with `ids`, exactly those records in that order
 * with `record_filter` reported as `selectable` instead of applied.
 *
 * - The field, its table, the field itself and the linked table must be
 *   readable by the caller (else `404`, one answer); reading them without
 *   the right to write the link field is `403`.
 * - `record_id` names the record whose cell is edited (read rule, else
 *   `404`): items it links are `linked`, and `cell` counts its links.
 * - `full`: the reverse cell of a two-way link already holds its limit.
 *
 * One statement reads the page (ids, title, display columns); linked /
 * full flags and member names are batched over the page ids.
 */
export class LinkCandidateReader {
  private readonly tables: TablesRepository;
  private readonly fields: FieldsRepository;
  private readonly targets: LinkTargets;
  private readonly linkFilters: LinkFilterMeta;
  private readonly members: MemberDirectoryRepository;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly db: Db,
    options: LinkCandidateReaderOptions = {},
  ) {
    this.tables = new TablesRepository(db);
    this.fields = new FieldsRepository(db);
    this.targets = new LinkTargets(db);
    this.linkFilters = new LinkFilterMeta(db);
    this.members = new MemberDirectoryRepository(db);
    this.timeoutMs = options.statementTimeoutMs ?? REQUEST_STATEMENT_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
  }

  async read(
    scope: OrgScope,
    fieldId: Id<'fld'>,
    access: RecordAccessContext,
    request: LinkCandidatesInput = {},
  ): Promise<LinkCandidatesOutput> {
    const parsed = linkCandidatesRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'The candidate request is invalid.',
        errors: zodIssuesToProblemErrors(parsed.error.issues),
      });
    }
    const input = parsed.data;

    // The field and its table, as the caller sees them.
    const row = await this.fields.getById(scope, fieldId);
    const link = row === undefined ? null : toLinkFieldModel(row);
    if (row === undefined || link === null) throw notFound();
    const source = await this.tables.getById(scope, row.table_id);
    if (source?.base_id !== access.baseId) throw notFound();
    const sourceAccess = accessibleTable(access, source.id);
    if (sourceAccess === null || !readable(sourceAccess, link.id)) throw notFound();
    const targetRow = await this.tables.getById(scope, link.targetTableId);
    if (targetRow?.base_id !== access.baseId) throw notFound();

    try {
      return await this.db.withTx(
        async (tx) => {
          await sql`SET TRANSACTION READ ONLY`.execute(tx);
          // Locks first: the snapshot must see meta and data of one moment.
          await lockForRead(tx, targetRow);
          if (
            input.record_id !== undefined &&
            input.record_id !== null &&
            source.id !== targetRow.id
          ) {
            await lockForRead(tx, source);
          }
          return await this.run(withTxScope(scope, tx), tx, {
            access,
            link,
            source,
            sourceAccess,
            input,
          });
        },
        { timeoutMs: this.timeoutMs, isolationLevel: 'repeatable read' },
      );
    } catch (error) {
      if (isStatementTimeout(error)) {
        throw new AppError('QUERY_TIMEOUT', {
          detail: 'The query took too long and was cancelled.',
          cause: error,
        });
      }
      throw error;
    }
  }

  private async run(
    scope: OrgScope,
    tx: Tx,
    c: {
      readonly access: RecordAccessContext;
      readonly link: LinkFieldModel;
      readonly source: TableRow;
      readonly sourceAccess: TableAccess;
      readonly input: LinkCandidatesRequest;
    },
  ): Promise<LinkCandidatesOutput> {
    const { access, link, input } = c;
    // The linked table under `relatedAccess` when the caller has one (form links: the creator's, T410).
    const targetAccess = relatedAccessContext(access, link.targetTableId);
    const target = await this.targets.load(scope, link.targetTableId, targetAccess);
    if (target === null || target.access === null) throw notFound();
    const context: ResolveContext = {
      userId: access.userId,
      groupMemberUserIds: access.groupMemberUserIds,
      timeZone: access.timeZone,
      now: this.now(),
    };

    // The record whose cell is edited: live and in the caller's read rule.
    const recordId = input.record_id ?? null;
    let linkedIds: Set<string> | null = null;
    if (recordId !== null) {
      if (!(await this.sourceReadable(scope, tx, c, recordId, context))) throw recordNotFound();
      linkedIds = await this.cellOf(tx, link, target, recordId);
    }

    // Readable but not writable: the picker exists to write the cell.
    const perm: string | undefined = c.sourceAccess.fields[link.id];
    const writable =
      c.sourceAccess.perm !== 'read_only' &&
      (perm === 'edit' || (perm === 'create' && recordId === null));
    if (!writable) {
      throw new AppError('PERMISSION_DENIED', {
        detail: 'You cannot change this link field.',
      });
    }

    const search = input.search?.trim() ?? '';
    const primary = target.titleReadable ? target.primary : null;
    if (search !== '' && primary === null) {
      // The primary field is hidden from the caller: searching it would leak it.
      throw new AppError('VALIDATION_FAILED', {
        detail: 'Search is not available on this table.',
        errors: [{ path: 'search', code: 'UNKNOWN_FIELD', message: 'Field does not exist' }],
      });
    }
    const display = target.model.visible
      .filter((field) => !field.isPrimary)
      .slice(0, MAX_LINK_CANDIDATE_FIELDS);

    const t = (column: string) => sql.id(TARGET_ALIAS, column);
    const ids = input.ids ?? null;
    const recordFilter = recordFilterSql(link, target, context);
    const conditions: RawBuilder<SqlBool>[] = [
      sql<SqlBool>`${t('__deleted_at')} IS NULL`,
      targetReadableSql(target, targetAccess, context),
    ];
    if (ids !== null) {
      conditions.push(sql<SqlBool>`${t('__id')} = ANY(${sql.val([...ids])}::text[])`);
    } else if (recordFilter !== null) {
      conditions.push(recordFilter);
    }
    if (search !== '' && primary !== null) {
      conditions.push(
        compileToSql(
          { field: primary.id, operator: 'contains', value: search },
          target.model.filterMeta,
          { tableAlias: TARGET_ALIAS },
        ),
      );
    }
    const selectable =
      ids === null || recordFilter === null ? sql<SqlBool>`true` : sql<SqlBool>`(${recordFilter})`;
    const order =
      ids === null
        ? t('__auto')
        : sql`array_position(${sql.val([...ids])}::text[], ${t('__id')}), ${t('__auto')}`;
    const columns = [
      ...(primary === null ? [] : [sql`${t(primary.column)} AS title`]),
      ...display.map((field, index) => sql`${t(field.column)} AS ${sql.id(`c${String(index)}`)}`),
    ];
    const { rows } = await sql<PageRow>`
      SELECT ${t('__id')} AS __id, ${selectable} AS selectable
             ${sql.join(
               columns.map((column) => sql`, ${column}`),
               sql``,
             )}
        FROM ${dataTableRef(target.table)} AS ${sql.id(TARGET_ALIAS)}
       WHERE ${sql.join(conditions, sql` AND `)}
       ORDER BY ${order}
       LIMIT ${input.limit + 1} OFFSET ${input.offset}
    `.execute(tx);
    const page = rows.slice(0, input.limit);
    const pageIds = page.map((item) => item.__id);

    const full = await this.fullIds(scope, tx, link, c.source, pageIds, linkedIds);
    const users = await this.usersOf(scope, primary, display, page);
    const locale: LocaleContext = { locale: access.locale, timeZone: access.timeZone };
    const readContext = { resolveUser: (id: string) => users.get(id) };
    return {
      items: page.map((item) => ({
        id: item.__id,
        title: primary === null ? null : titleOf(primary, item['title'], locale, users),
        fields: Object.fromEntries(
          display.map((field, index) => [
            field.id,
            field.definition.fromStorage(item[`c${String(index)}`], field.options, readContext),
          ]),
        ),
        linked: linkedIds?.has(item.__id) === true,
        full: full.has(item.__id),
        selectable: item.selectable,
      })),
      fields: display.map((field) => ({ id: field.id, name: field.name, type: field.type })),
      offset: input.offset,
      limit: input.limit,
      has_more: rows.length > input.limit,
      cell:
        linkedIds === null ? null : { count: linkedIds.size, limit: linkCellLimit(link.options) },
    };
  }

  /** `recordId` is a live record of the field's table in the caller's read rule. */
  private async sourceReadable(
    scope: OrgScope,
    tx: Tx,
    c: {
      readonly source: TableRow;
      readonly sourceAccess: TableAccess;
      readonly access: RecordAccessContext;
    },
    recordId: Id<'rec'>,
    context: ResolveContext,
  ): Promise<boolean> {
    const built = buildTableModel(
      c.source,
      await this.fields.listByTable(scope, c.source.id),
      c.sourceAccess,
    );
    // A read rule naming link fields (T710) compiles with the link meta.
    const model = await this.linkFilters.forRules(
      scope,
      built,
      rulesOf(built, c.access.resolved.internal.readFilters),
    );
    const rule = resolveRule(c.access.resolved.internal.readFilters, model, context);
    const { rows } = await sql<{ one: number }>`
      SELECT 1 AS one
        FROM ${dataTableRef(c.source)} AS ${sql.id(SOURCE_ALIAS)}
       WHERE ${sql.id(SOURCE_ALIAS, '__id')} = ${recordId}
         AND ${sql.id(SOURCE_ALIAS, '__deleted_at')} IS NULL
         AND ${ruleSql(rule, model, SOURCE_ALIAS)}
    `.execute(tx);
    return rows.length > 0;
  }

  /** Live linked records of `recordId`'s cell (whatever the caller reads, like P20 ids). */
  private async cellOf(
    tx: Tx,
    link: LinkFieldModel,
    target: LinkTarget,
    recordId: Id<'rec'>,
  ): Promise<Set<string>> {
    const own = sql.id(J, link.ownColumn);
    const other = sql.id(J, link.otherColumn);
    const { rows } = await sql<{ id: string }>`
      SELECT ${other} AS id
        FROM ${junctionRef(link)} AS ${sql.id(J)}
        JOIN ${dataTableRef(target.table)} AS ${sql.id(TARGET_ALIAS)}
          ON ${sql.id(TARGET_ALIAS, '__id')} = ${other}
       WHERE ${own} = ${recordId}
         AND ${sql.id(TARGET_ALIAS, '__deleted_at')} IS NULL
    `.execute(tx);
    return new Set(rows.map((item) => item.id));
  }

  /**
   * Page records whose reverse cell (two-way link) already holds the most
   * links the other side allows: linking them would be `TOO_MANY_VALUES`.
   */
  private async fullIds(
    scope: OrgScope,
    tx: Tx,
    link: LinkFieldModel,
    source: TableRow,
    pageIds: readonly string[],
    linkedIds: ReadonlySet<string> | null,
  ): Promise<Set<string>> {
    const wanted = pageIds.filter((id) => linkedIds?.has(id) !== true);
    if (wanted.length === 0) return new Set();
    const limit = await this.reverseLimit(scope, link);
    if (limit === null) return new Set();
    const own = sql.id(J, link.ownColumn);
    const other = sql.id(J, link.otherColumn);
    const { rows } = await sql<{ id: string; n: bigint | string }>`
      SELECT ${other} AS id, count(*) AS n
        FROM ${junctionRef(link)} AS ${sql.id(J)}
        JOIN ${dataTableRef(source)} AS ${sql.id(SOURCE_ALIAS)}
          ON ${sql.id(SOURCE_ALIAS, '__id')} = ${own}
       WHERE ${other} = ANY(${sql.val(wanted)}::text[])
         AND ${sql.id(SOURCE_ALIAS, '__deleted_at')} IS NULL
       GROUP BY ${other}
    `.execute(tx);
    return new Set(rows.filter((item) => Number(item.n) >= limit).map((item) => item.id));
  }

  /**
   * Most links of a reverse cell, as the link writer checks them: the
   * partner's limit when it is active; in the trash only the unique index of
   * a single-record side (`a`, or `b` since T404) still limits (1); `null` = no limit.
   */
  private async reverseLimit(scope: OrgScope, link: LinkFieldModel): Promise<number | null> {
    const rows = await this.fields.listByJunction(scope, link.junction);
    const row = rows.find((candidate) => candidate.link_side !== link.side);
    const partner = row === undefined ? null : toLinkFieldModel(row);
    if (row === undefined || partner === null) return null;
    if (row.deleted_at === null) return linkCellLimit(partner.options);
    return partner.options.allow_multiple ? null : 1;
  }

  /** Display data of the users named by the page's titles and user cells. */
  private async usersOf(
    scope: OrgScope,
    primary: FieldModel | null,
    display: readonly FieldModel[],
    page: readonly PageRow[],
  ): Promise<Map<string, UserRef>> {
    const ids = new Set<string>(
      primary === null
        ? []
        : titleUserIds(
            primary,
            page.map((item) => item['title']),
          ),
    );
    display.forEach((field, index) => {
      for (const item of page) {
        const stored = item[`c${String(index)}`];
        if (field.type === 'user' && Array.isArray(stored)) {
          for (const id of stored) if (typeof id === 'string') ids.add(id);
        } else if (
          (field.type === 'created_by' || field.type === 'updated_by') &&
          typeof stored === 'string'
        ) {
          ids.add(stored);
        }
      }
    });
    const members = await this.members.findMembers(scope, [...ids]);
    return new Map(members.map((member) => [member.id as string, member]));
  }
}

/** `ACCESS SHARE` on a data table (see `RecordQueryService.read`); a dropped table is `404`. */
async function lockForRead(tx: Tx, table: TableRow): Promise<void> {
  try {
    await sql`LOCK TABLE ${dataTableRef(table)} IN ACCESS SHARE MODE`.execute(tx);
  } catch (error) {
    if (sqlStateOf(error) === SQLSTATE.undefinedTable) throw notFound();
    throw error;
  }
}
