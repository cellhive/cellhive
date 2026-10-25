import type { RecordFilterMode, RecordSortMode, recordSortSchema } from '@cellhive/contracts';
import type { z } from 'zod';

type RecordSortInput = z.input<typeof recordSortSchema>;

/**
 * Query key factory (FRONTEND §3.2). Every query key is built here so that
 * prefix invalidation (`['base', id]`, `['table', id]`) reaches everything
 * that depends on a resource. Never write keys by hand.
 */
export const keys = {
  me: () => ['me'] as const,
  setupStatus: () => ['setup'] as const,
  orgs: () => ['orgs'] as const,
  org: (orgId: string) => ['org', orgId] as const,
  workspaces: (orgId: string) => ['org', orgId, 'workspaces'] as const,
  /** Members of an organization (user pickers of the grid). */
  orgMembers: (orgId: string) => ['org', orgId, 'members'] as const,
  /** `GET /orgs/:id/groups` (T522: recipients of `send_notification`). */
  orgGroups: (orgId: string) => ['org', orgId, 'groups'] as const,
  /**
   * (T524) Prefix of the caller's notifications in an organization (CONTRACTS
   * §22): list pages, unread count, preferences, settings. A
   * `notification.created` of the organization or a read in another tab
   * invalidates it.
   */
  notifications: (orgId: string) => ['org', orgId, 'notifications'] as const,
  /** Pages of the notification list for a filter (`unread`, `base_id`). */
  notificationList: (orgId: string, filter: { unread: boolean; baseId: string | null }) =>
    ['org', orgId, 'notifications', 'list', filter] as const,
  notificationUnreadCount: (orgId: string) =>
    ['org', orgId, 'notifications', 'unread-count'] as const,
  notificationPreferences: (orgId: string) =>
    ['org', orgId, 'notifications', 'preferences'] as const,
  notificationSettings: (orgId: string) => ['org', orgId, 'notifications', 'settings'] as const,
  workspace: (workspaceId: string) => ['workspace', workspaceId] as const,
  bases: (workspaceId: string) => ['workspace', workspaceId, 'bases'] as const,
  invitation: (token: string) => ['invitation', token] as const,
  /** (T715) Connected accounts of the signed-in user (`GET /me/identities`). */
  meIdentities: () => ['me', 'identities'] as const,

  /** Base detail with `permission_version` and `access`; also the prefix of base data. */
  base: (baseId: string) => ['base', baseId] as const,
  tables: (baseId: string) => ['base', baseId, 'tables'] as const,
  /** (T469) Tables of the base in the trash; under `tables` so that table changes refresh it. */
  tableTrash: (baseId: string) => ['base', baseId, 'tables', 'trash'] as const,
  roles: (baseId: string) => ['base', baseId, 'roles'] as const,
  /** People who can open the base (`GET /bases/:id/members`, user questions of forms). */
  baseMembers: (baseId: string) => ['base', baseId, 'members'] as const,
  /** Whether the caller reached a form's submission limit (`…/submission-status`). */
  formSubmissionStatus: (viewId: string) => ['form', viewId, 'submission-status'] as const,
  /**
   * (T520) Automations of a base the caller manages (CONTRACTS §21). Under
   * the base prefix: a `permission.changed` (new `permission_version`) asks
   * it again, since what the caller manages may have changed.
   */
  automations: (baseId: string) => ['base', baseId, 'automations'] as const,
  /** (T811) Dashboards of a base the caller sees (sidebar); under the base prefix. */
  dashboards: (baseId: string) => ['base', baseId, 'dashboards'] as const,
  /** (T811) Dashboards in the base trash (base admins), under the list's prefix. */
  dashboardTrash: (baseId: string) => ['base', baseId, 'dashboards', 'trash'] as const,
  /** (T811) One dashboard with its widgets (`GET /dashboards/:id`). */
  dashboard: (dashboardId: string) => ['dashboard', dashboardId] as const,
  /** (T521) One automation in the builder; under the list, so list refreshes reach it. */
  automation: (baseId: string, automationId: string) =>
    ['base', baseId, 'automations', automationId] as const,
  /** (T521) A template checked by `validate-template` (names ⇄ ids of the chips). */
  automationTemplate: (baseId: string, requestHash: string) =>
    ['base', baseId, 'automation-template', requestHash] as const,
  /**
   * (T523) Pages of a run history: of one automation (`scope` = its id) or of
   * the whole base (`scope` = `base`), with the list's filters. Not under
   * `automations`, so saving the builder does not refetch them.
   */
  automationRuns: (baseId: string, scope: string, filter: string, range: string) =>
    ['base', baseId, 'automation-runs', scope, filter, range] as const,
  /** (T523) Prefix of every run history page of a base (re-run, cancel refresh them). */
  automationRunsOfBase: (baseId: string) => ['base', baseId, 'automation-runs'] as const,
  /** (T523) One run with its steps (`GET /automation-runs/:id`). */
  automationRun: (runId: string) => ['automation-run', runId] as const,

  /** Prefix of everything of a table: invalidated on `schema.changed`. */
  table: (tableId: string) => ['table', tableId] as const,
  tableMeta: (tableId: string) => ['table', tableId, 'meta'] as const,
  fields: (tableId: string) => ['table', tableId, 'fields'] as const,
  /** Live fields plus the restorable deleted ones (schema managers, trash screen). */
  fieldTrash: (tableId: string) => ['table', tableId, 'fields', 'trash'] as const,
  views: (tableId: string) => ['table', tableId, 'views'] as const,
  /** Prefix of every record block of a table (all query hashes and permission versions). */
  recordBlocks: (tableId: string) => ['table', tableId, 'records'] as const,
  recordBlock: (tableId: string, queryHash: string, permissionVersion: number, index: number) =>
    ['table', tableId, 'records', queryHash, permissionVersion, index] as const,
  record: (tableId: string, recordId: string) => ['table', tableId, 'record', recordId] as const,
  /**
   * (T553) Whether the caller follows a record (`GET …/follow`, CONTRACTS
   * §22.5). Under the table prefix (a permission or schema change asks it
   * again) but not under `record`, which holds a `RecordDto`.
   */
  recordFollow: (tableId: string, recordId: string) =>
    ['table', tableId, 'follow', recordId] as const,
  /** (T552) Titles of the ≤ 20 records of a bulk `record.assigned` notification (`ids` joined). */
  notificationRecords: (tableId: string, ids: string) =>
    ['table', tableId, 'notification-records', ids] as const,
  /** Prefix of every group count of a table (`POST …/records/group-counts`, kanban columns). */
  groupCountLists: (tableId: string) => ['table', tableId, 'group-counts'] as const,
  groupCounts: (tableId: string, queryHash: string, permissionVersion: number) =>
    ['table', tableId, 'group-counts', queryHash, permissionVersion] as const,
  recordTrash: (tableId: string) => ['table', tableId, 'trash'] as const,
  /** (T472) Prefix of every summary bar of a table (`POST …/records/summaries`). */
  summaryLists: (tableId: string) => ['table', tableId, 'summaries'] as const,
  summaries: (tableId: string, requestHash: string, permissionVersion: number) =>
    ['table', tableId, 'summaries', requestHash, permissionVersion] as const,
  /**
   * (T320b) Records of the table the caller reads, without any view or
   * filter: the sidebar count and the "N of M" of a filtered grid footer.
   * Outside the `['table', id]` prefix on purpose: schema changes (which
   * also bump `permission_version`) must not re-count every table of the
   * sidebar; it is refreshed when stale instead.
   */
  tableRecordCount: (tableId: string) => ['record-count', tableId] as const,
  /** History of a record; with `fieldId`, the history of one cell (FRONTEND §10.3). */
  recordHistory: (recordId: string, fieldId?: string) =>
    fieldId === undefined
      ? (['record', recordId, 'history'] as const)
      : (['record', recordId, 'history', fieldId] as const),

  /**
   * (T413) Candidates of a link picker (`POST /fields/:id/link-candidates`),
   * under the linked table's prefix: its schema or record changes refresh
   * them. `request` = the body without `offset` (pages are an infinite query).
   */
  linkCandidates: (
    linkTableId: string,
    fieldId: string,
    request?: Readonly<Record<string, unknown>>,
  ) =>
    request === undefined
      ? (['table', linkTableId, 'link-candidates', fieldId] as const)
      : (['table', linkTableId, 'link-candidates', fieldId, request] as const),
  /**
   * (T466) The first records of a table for the formula editor's preview
   * when no grid block of it is in the cache (`records/query { limit: 5 }`).
   * Under the table prefix: schema and record changes refresh it.
   */
  formulaPreviewRows: (tableId: string) => ['table', tableId, 'formula-preview-rows'] as const,

  /**
   * (T467) Preview of a formula/lookup definition being edited
   * (`POST /tables/:id/computed-preview`), by the request's hash; under the
   * table's prefix so schema changes refresh it.
   */
  computedPreview: (tableId: string, requestHash: string) =>
    ['table', tableId, 'computed-preview', requestHash] as const,

  widgetData: (widgetId: string, effectiveHash: string) =>
    ['widget', widgetId, effectiveHash] as const,
  job: (jobId: string) => ['job', jobId] as const,

  // T316: share link management (CONTRACTS §16).
  /** Prefix of the share links (and previews) of every view. */
  allViewShareLinks: () => ['view'] as const,
  /** Links of a view (at most one not revoked) and, under it, the scope preview. */
  viewShareLinks: (viewId: string) => ['view', viewId, 'share-links'] as const,
  shareLinkPreview: (viewId: string) => ['view', viewId, 'share-links', 'preview'] as const,
  /** (T814) Links of a dashboard (at most one not revoked). */
  dashboardShareLinks: (dashboardId: string) => ['dashboard', dashboardId, 'share-links'] as const,
  /** Prefix of every share link list of a base; with `filters`, one page. */
  baseShareLinks: (baseId: string, filters?: Readonly<Record<string, unknown>>) =>
    filters === undefined
      ? (['base', baseId, 'share-links'] as const)
      : (['base', baseId, 'share-links', filters] as const),
  /** Prefix of every share link list of an organization; with `filters`, one page. */
  orgShareLinks: (orgId: string, filters?: Readonly<Record<string, unknown>>) =>
    filters === undefined
      ? (['org', orgId, 'share-links'] as const)
      : (['org', orgId, 'share-links', filters] as const),
  /** Names of the bases of an organization (column and filter of its share link list). */
  orgBaseNames: (orgId: string) => ['org', orgId, 'base-names'] as const,
  /** `GET /bases/:id/email-identities` (T522): verified senders an automation of the base may use. */
  baseEmailIdentities: (baseId: string) => ['base', baseId, 'email-identities'] as const,
  /** `POST /automations/:id/actions/:actionId/email-preview` (T522), by draft and record. */
  automationEmailPreview: (automationId: string, actionId: string, request: string) =>
    ['automation', automationId, 'email-preview', actionId, request] as const,
  /** `GET /orgs/:id/email-settings` (CONTRACTS §23.2): instance SMTP and automation email settings. */
  orgEmailSettings: (orgId: string) => ['org', orgId, 'email-settings'] as const,
  /** `GET /orgs/:id/email-identities` (T533, CONTRACTS §23.3). */
  orgEmailIdentities: (orgId: string) => ['org', orgId, 'email-identities'] as const,
  /** `GET /orgs/:id/secrets` (T516, CONTRACTS §24): the organization's Telegram bots. */
  orgSecrets: (orgId: string) => ['org', orgId, 'secrets'] as const,
  /** `GET /orgs/:id/notification-channels` (T555, CONTRACTS §22.7): the notification bot. */
  orgNotificationChannels: (orgId: string) => ['org', orgId, 'notification-channels'] as const,
  /** `GET /orgs/:id/me/channels` (T555, CONTRACTS §22.7): the caller's own Telegram link. */
  userChannels: (orgId: string) => ['org', orgId, 'me-channels'] as const,
  /** `GET /secrets/:id/usages`: automations using a bot. */
  secretUsages: (orgId: string, secretId: string) =>
    ['org', orgId, 'secrets', secretId, 'usages'] as const,
  /** `GET /bases/:id/secrets?kind=…`: bots an automation of the base may use (names only). */
  baseSecrets: (baseId: string, kind: string) => ['base', baseId, 'secrets', kind] as const,
  /** `GET /email-identities/:id/usages`: automations sending as an identity. */
  emailIdentityUsages: (orgId: string, identityId: string) =>
    ['org', orgId, 'email-identities', identityId, 'usages'] as const,
  // Public share page (T317): everything read through one link lives under `['share', token]`.
  /** Prefix of what the page read through a link. */
  share: (token: string) => ['share', token] as const,
  /** `GET /shares/:token/meta`. */
  shareMeta: (token: string) => ['share', token, 'meta'] as const,
  /** (T814) `GET /shares/:token/dashboard` (a dashboard link). */
  shareDashboard: (token: string) => ['share', token, 'dashboard'] as const,
  /** (T814) Widget data and filter values read through a dashboard link. */
  shareWidgets: (token: string) => ['share', token, 'widgets'] as const,
  /** `POST /shares/:token/records/group-counts` for a query hash. */
  shareGroupCounts: (token: string, queryHash: string) =>
    ['share', token, 'group-counts', queryHash] as const,
  /** `POST /shares/:token/records/summaries` (the summary bar, T470) for a query hash. */
  shareSummaries: (token: string, queryHash: string) =>
    ['share', token, 'summaries', queryHash] as const,
  /** Pages of cards of a shared kanban board (`records/query`) for a query hash. */
  shareCards: (token: string, queryHash: string) => ['share', token, 'cards', queryHash] as const,
  /** `GET /shares/:token/members` (T321): people the user questions of an `org` form link offer. */
  shareFormMembers: (token: string) => ['share', token, 'members'] as const,
  /** `GET /shares/:token/submission-status` (T321). */
  shareSubmissionStatus: (token: string) => ['share', token, 'submission-status'] as const,
  /** `GET /shares/:token/records/:recordId`. */
  shareRecord: (token: string, recordId: string) => ['share', token, 'record', recordId] as const,
  /**
   * Table id under which the grid's block loader keys the rows of a link
   * (`keys.recordBlock(shareRowsScope(token), …)`): never a real table id.
   */
  shareRowsScope: (token: string) => `share:${token}`,
} as const;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

/**
 * Stable hash input for `queryHash` (FRONTEND §3.2): JSON with sorted object
 * keys, so `{ a, b }` and `{ b, a }` give the same key. Array order matters.
 */
export function stableQueryHash(value: unknown): string {
  const normalized = canonical(value);
  // `undefined` has no JSON form; hash it like `null`.
  return normalized === undefined ? 'null' : JSON.stringify(normalized);
}

/**
 * The parts of a record query that decide which rows come back and in which
 * order (FRONTEND §3.2): the effective view config, saved or temporary.
 * Paging (`offset`, `limit`, `include_total`) is not part of it.
 */
export interface EffectiveRecordQuery {
  view_id?: string | null | undefined;
  filter?: Readonly<Record<string, unknown>> | null | undefined;
  /**
   * `replace` (T311, CONTRACTS §1.4): `filter` takes the place of the part of
   * the view's saved filter the user sees (a temporary filter change).
   */
  filter_mode?: RecordFilterMode | undefined;
  sort?: readonly RecordSortInput[] | null | undefined;
  /** `replace` (T311): `sort` takes the place of the view's saved sort. */
  sort_mode?: RecordSortMode | undefined;
  search?: string | null | undefined;
  /** Group keys of the view (S3); the server orders by them. */
  group?: readonly RecordSortInput[] | null | undefined;
  fields?: readonly string[] | null | undefined;
}

function isBlank(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * `queryHash` of `keys.recordBlock` (FRONTEND §3.2): sorted JSON of
 * `{ view_id, filter, filter_mode, sort, sort_mode, search, group, fields }`.
 * Absent, `null`, empty string and (except for `fields` and `group`) empty
 * lists all mean "not set", so equivalent queries share their cached blocks; the
 * modes count only when they are `replace` (the default otherwise).
 */
export function recordQueryHash(query: EffectiveRecordQuery): string {
  const { view_id, filter, sort, search, group, fields } = query;
  const normalized: Record<string, unknown> = {};
  const set = (key: string, value: unknown) => {
    if (!isBlank(value)) normalized[key] = value;
  };
  set('view_id', view_id);
  set('filter', filter);
  // `direction` defaults to `asc` on the server: `{ field }` is `{ field, direction: 'asc' }`.
  set(
    'sort',
    sort?.map((key) => ({ field: key.field, direction: key.direction ?? 'asc' })),
  );
  set('search', search);
  // `group: []` sets the view's group aside (CONTRACTS §1.4), unlike an absent group.
  if (group !== undefined && group !== null) {
    normalized['group'] = group.map((key) => ({
      field: key.field,
      direction: key.direction ?? 'asc',
    }));
  }
  if (query.filter_mode === 'replace') normalized['filter_mode'] = 'replace';
  if (query.sort_mode === 'replace') normalized['sort_mode'] = 'replace';
  // `fields: []` asks for no field at all, unlike an absent list (all readable fields).
  if (fields !== undefined && fields !== null) normalized['fields'] = fields;
  return stableQueryHash(normalized);
}
