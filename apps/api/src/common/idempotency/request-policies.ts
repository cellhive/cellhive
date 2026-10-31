import { scopeParamOf } from '../access/route-scope.service.js';

/** Global prefix of the API routes (see `app.factory.ts`). */
const API_PREFIX = '/api/v1';

/**
 * `POST` routes that ignore `Idempotency-Key` (CONTRACTS §1.1). Every other
 * `POST` route of the API honours it; a unit test walks the controllers to
 * keep this list and the routes in sync.
 */
export const IDEMPOTENCY_EXCLUDED_ROUTES: Readonly<Record<string, string>> = {
  '/setup': 'Not bound to an organization; runs once per instance (CONTRACTS §1.1).',
  '/auth/login': 'Not bound to an organization (CONTRACTS §1.1).',
  '/auth/logout': 'Not bound to an organization (CONTRACTS §1.1).',
  '/auth/forgot-password': 'Not bound to an organization (CONTRACTS §1.1).',
  '/auth/password-reset/:token': 'Not bound to an organization (CONTRACTS §1.1).',
  '/me/identities/:provider/start':
    'Not bound to an organization; a retry only starts a new link attempt with a fresh state ' +
    'cookie (CONTRACTS §1.1, §27.3).',
  '/me/password':
    'Not bound to an organization; a retry checks the current password again (CONTRACTS ' +
    '§1.1, §12.0).',
  '/invitations/:token/accept':
    'Public and token-scoped: the caller may have no account yet, so there is no principal ' +
    'to own a key; the single-use token already makes a retry harmless.',
  '/email-identities/verify/preview':
    'Public and token-scoped, a read: the reader of the mailbox may have no account to own a ' +
    'key (CONTRACTS §23.3).',
  '/email-identities/verify':
    'Public and token-scoped: no principal owns a key; the single-use token already makes a ' +
    'retry harmless (CONTRACTS §23.3).',
  '/tables/:tableId/records/query': 'A read, not a write (CONTRACTS §1.1).',
  '/tables/:tableId/records/group-counts': 'A read, not a write (CONTRACTS §1.1).',
  '/tables/:tableId/records/tree': 'A read, not a write (CONTRACTS §1.1, §1.4).',
  '/tables/:tableId/records/summaries': 'A read, not a write (CONTRACTS §1.1, §1.4, T472).',
  '/fields/:fieldId/link-candidates': 'A read, not a write (CONTRACTS §2, T402).',
  '/tables/:tableId/computed-preview': 'A read, not a write (CONTRACTS §13, T456).',
  '/widgets/:widgetId/data': 'A read, not a write (CONTRACTS §1.1, §28.3, T806).',
  '/widgets/:widgetId/options': 'A read, not a write (CONTRACTS §1.1, §28.4, T808).',
  '/widgets/:widgetId/records': 'A read, not a write (CONTRACTS §1.1, §28.4, T808).',
  '/tables/:tableId/ai/ask':
    'A read, not a write; its answers are never kept (CONTRACTS §1.1, §29.4, T909).',
  '/shares/:token/records/query':
    'Public share link, a read: no principal owns a key (CONTRACTS §1.1, §16A).',
  '/shares/:token/records/group-counts':
    'Public share link, a read: no principal owns a key (CONTRACTS §1.1, §16A).',
  '/shares/:token/records/summaries':
    'Public share link, a read: no principal owns a key (CONTRACTS §1.1, §16A, T472).',
  '/shares/:token/unlock':
    'Public share link: no principal owns a key; a retry only re-checks the password ' +
    '(CONTRACTS §1.1, §16A).',
  '/shares/:token/submit':
    'Public and token-scoped: most submitters have no account to own a key; the single-use ' +
    'submit token already makes a resend fail instead of creating a second record ' +
    '(CONTRACTS §17).',
  '/shares/:token/uploads':
    'Public and token-scoped: most uploaders have no account to own a key; a retry only leaves ' +
    'an unused pending upload that the cleanup deletes after 24 hours (CONTRACTS §17, §20).',
  '/shares/:token/uploads/:attachmentId/complete':
    'Public and token-scoped; idempotent by itself like `/files/uploads/:attachmentId/complete` ' +
    '(CONTRACTS §17, §20).',
  '/files/uploads':
    'Not bound to an organization by its route, and a retry only leaves an unused pending ' +
    'upload that the cleanup deletes after 24 hours (CONTRACTS §1.1, §20).',
  '/files/uploads/:attachmentId/complete':
    'Idempotent by itself: completing a ready upload again returns the same attachment ' +
    '(CONTRACTS §1.1, §20).',
  '/hooks/:token':
    'Public incoming webhook (CONTRACTS §25.2): no principal owns a key, and an outbound ' +
    '`Idempotency-Key` of the sender belongs to the payload; replays are caught by ' +
    '`webhook-id` (CONTRACTS §10).',
  '/telegram/webhook/:pathToken':
    'Called by Telegram only (CONTRACTS §22.7, T609): no principal owns a key; a redelivered ' +
    'update is handled again harmlessly (a used link token from the same chat answers like a ' +
    'success, `/stop` of an unlinked chat is ignored).',
  '/mcp':
    'JSON-RPC of the MCP server (CONTRACTS §30.1): no organization in the route, and a ' +
    'message is not a resource write; the tools that write check their inputs like REST.',
  '/bases/:baseId/imports/uploads':
    'A streamed multipart file body cannot be fingerprinted; a repeated upload only leaves an ' +
    'unused temporary upload that expires after 24 hours (CONTRACTS §1.1, §19).',
};

/**
 * Routes counted against the per-principal rate limit only, not the
 * per-principal-and-base one (SPEC §13.1). The grid reads records in
 * blocks: fast scrolling plus prefetching, and realtime `record.added`
 * bursts, easily exceed 20 requests/s on one base for a single user. These
 * reads still count against the per-principal limit (60/s), which bounds a
 * runaway client, and every query runs under the 10 s statement timeout.
 */
export const BASE_RATE_LIMIT_EXEMPT_ROUTES: ReadonlySet<string> = new Set([
  '/tables/:tableId/records/query',
  // The tree grid reads roots and expanded branches the same way (T405).
  '/tables/:tableId/records/tree',
  // A dashboard opens with up to 30 widgets, each one request (T806); the
  // widget line (4 per user, 20 per instance) bounds the work.
  '/widgets/:widgetId/data',
]);

/** A route pattern without the API prefix (`/api/v1/orgs/:orgId` → `/orgs/:orgId`). */
export function routeKeyOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  if (url === API_PREFIX) return '/';
  return url.startsWith(`${API_PREFIX}/`) ? url.slice(API_PREFIX.length) : undefined;
}

/**
 * How a `POST` route treats `Idempotency-Key`:
 * - `excluded`: ignored (see `IDEMPOTENCY_EXCLUDED_ROUTES`);
 * - `scoped`: the key belongs to the organization named by the route;
 * - `home`: the route creates an organization (`POST /orgs`), so the key
 *   belongs to the caller's oldest organization;
 * - `unscoped`: no organization parameter; a new `POST` route must be one
 *   of the above (the unit test fails otherwise).
 */
export function idempotencyModeOf(routeKey: string): 'excluded' | 'scoped' | 'home' | 'unscoped' {
  if (IDEMPOTENCY_EXCLUDED_ROUTES[routeKey] !== undefined) return 'excluded';
  if (routeKey === '/orgs') return 'home';
  return scopeParamOf(routeKey) === undefined ? 'unscoped' : 'scoped';
}
