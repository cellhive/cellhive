/**
 * Constants the web client's first load needs (API client, share page),
 * kept apart from the zod schemas of the modules that re-export them
 * (`auth.ts`, `records.ts`, `shares.ts`, `forms.ts`): importing one of them
 * does not pull those schemas into the page (T422, FRONTEND §11.1).
 */

/**
 * Readable (non-HttpOnly) cookie holding the CSRF token. Clients copy its
 * value into the `X-CSRF-Token` header of every request other than
 * GET/HEAD/OPTIONS that carries the session cookie; otherwise the server
 * answers `403 CSRF_INVALID`.
 */
export const CSRF_COOKIE = 'ob_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/** Header of CONTRACTS §1.1. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/**
 * Request header carrying the CSRF token of a link unlock cookie
 * (CONTRACTS §12.0): required on every non-GET request to
 * `/shares/{token}/*` that carries a valid unlock cookie of that link
 * (except `unlock` itself).
 */
export const SHARE_CSRF_HEADER = 'x-share-csrf-token';

/** Most files one attachment question takes through a form link (and at most its `max_files`). */
export const SHARE_FORM_MAX_FILES_PER_QUESTION = 10;
/** Most bytes (announced sizes) uploaded with one submit token. */
export const SHARE_FORM_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
