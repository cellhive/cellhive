/**
 * Detail codes (`errors[].code` of a problem document, CONTRACTS §6). Unlike
 * the top-level `code` they are not a closed enum on the wire (`z.string()`),
 * but every code the documentation lists is enumerated here so that clients
 * can prove they translate all of them. Adding a detail code means updating
 * the matching list and CONTRACTS §6 in the same change.
 */

/**
 * Cell values (`code = INVALID_CELL_VALUE`), produced by `@cellhive/field-types`
 * (`VALUE_ISSUE_CODES` there must stay equal; its tests check it).
 */
export const CELL_VALUE_DETAIL_CODES = [
  'EXPECTED_STRING',
  'EXPECTED_NUMBER',
  'EXPECTED_BOOLEAN',
  'EXPECTED_ARRAY',
  'EXPECTED_DATE',
  'EXPECTED_DATETIME',
  'EXPECTED_USER',
  'INVALID_SELECT_OPTION',
  'TOO_MANY_VALUES',
  'INVALID_USER_ID',
  'INVALID_EMAIL',
  'USER_NOT_FOUND',
  'FIELD_READ_ONLY',
  'INVALID_RECORD_ID',
  'LINK_TARGET_NOT_FOUND',
  'EXPECTED_ATTACHMENT',
  'ATTACHMENT_NOT_FOUND',
] as const;

/**
 * Record queries (`code = VALIDATION_FAILED` / `INVALID_SORT`).
 * `FIELD_NOT_SORTABLE`: a sort or group on a readable field of a type that
 * cannot be ordered (link, attachment, parent; S4). `SUBRECORDS_NOT_ENABLED`:
 * a tree read (`records/tree`, `children`, `ancestors`) on a table without
 * a `parent` field the caller reads (T405).
 */
export const RECORD_QUERY_DETAIL_CODES = [
  'UNKNOWN_FIELD',
  'TOO_BIG',
  'TOO_SMALL',
  'FIELD_NOT_SORTABLE',
  'SUBRECORDS_NOT_ENABLED',
] as const;

/** Record writes: per-record problems of a bulk request (`path` = `records[i]…`). */
export const RECORD_WRITE_DETAIL_CODES = [
  'DUPLICATE_ID',
  'DUPLICATE_FIELD',
  'MERGE_FIELD_NOT_ALLOWED',
  'UNIQUE_VIOLATION',
  'REQUIRED_FIELD_MISSING',
  'RECORD_RULE_VIOLATION',
  'VERSION_CONFLICT',
  'NOT_FOUND',
  'TOO_BIG',
  'SUBRECORD_CYCLE',
  'SUBRECORD_TOO_DEEP',
  'SUBRECORDS_NOT_ENABLED',
] as const;

/** Roles (`code = VALIDATION_FAILED`, CONTRACTS §6, §14). */
export const ROLE_DETAIL_CODES = [
  'SYSTEM_ROLE',
  'ROLE_IN_USE',
  'UNKNOWN_ROLE',
  'UNKNOWN_TABLE',
  'UNKNOWN_FIELD',
  'UNKNOWN_VIEW',
  'UNKNOWN_DASHBOARD',
] as const;

/** Administration of organizations, members and workspaces (`code = VALIDATION_FAILED`). */
export const ADMIN_DETAIL_CODES = [
  'LAST_OWNER',
  'ALREADY_MEMBER',
  'UNKNOWN_PRINCIPAL',
  'WORKSPACE_NOT_EMPTY',
  'OWNS_BASES',
] as const;

/** Tables and fields (`code = VALIDATION_FAILED`, CONTRACTS §6, §13). */
export const SCHEMA_DETAIL_CODES = [
  'PRIMARY_FIELD_NOT_DELETABLE',
  'UNSUPPORTED_FIELD_TYPE',
  'UNIQUE_NOT_SUPPORTED',
  'UNKNOWN_COLLATION',
  'INVALID_LENGTH',
  'INVALID_CHARACTERS',
  'UNKNOWN_OPTION',
  'SUBRECORDS_ALREADY_ENABLED',
  'REQUIRED_NOT_SUPPORTED',
  // Table purge (T461, CONTRACTS §13).
  'TABLE_NOT_IN_TRASH',
  'CONFIRM_NAME_MISMATCH',
  'LINK_TABLE_PURGED',
  // `datetime.options.reminder` (T547, CONTRACTS §22.6): `user_field_id` missing
  // or of another table (`UNKNOWN_FIELD`), not a `user`/`created_by` field
  // (`INVALID_FIELD_TYPE`); a `user_ids` entry not a member (`USER_NOT_FOUND`).
  'UNKNOWN_FIELD',
  'INVALID_FIELD_TYPE',
  'USER_NOT_FOUND',
] as const;

/**
 * Field type conversion (CONTRACTS §4.4, §6; T403): `errors[].code` of
 * `422 CONVERSION_NOT_ALLOWED` / `CONVERSION_REQUIRES_CONFIRM` /
 * `TOO_MANY_OPTIONS` (path `type`, `options…`, `confirm` or
 * `accept_data_loss`) and of `409 SCHEMA_LOCKED` for a field whose values
 * are being converted (`FIELD_CONVERTING`, path `fields.<key>` on record
 * writes).
 */
export const FIELD_CONVERSION_DETAIL_CODES = [
  'CONVERSION_NOT_ALLOWED',
  'CONVERSION_REQUIRES_CONFIRM',
  'TOO_MANY_OPTIONS',
  'FIELD_CONVERTING',
] as const;

/** Views (`code = VALIDATION_FAILED` / `INVALID_SORT`, CONTRACTS §6, §15). */
export const VIEW_DETAIL_CODES = [
  'LAST_VIEW',
  'VIEW_LIMIT_EXCEEDED',
  'VIEW_LOCKED',
  'INVALID_FIELD_TYPE',
  'UNKNOWN_FIELD',
  'DUPLICATE_FIELD',
  'FIELD_READ_ONLY',
  'REQUIRED_FIELD_MISSING',
  'TREE_WITH_GROUP',
  // Two color rules of a view with the same id (T816, CONTRACTS §15).
  'DUPLICATE_RULE',
  // A link/parent title matching several readable records (T421a; problem `LINK_TARGET_NOT_FOUND`).
  'LINK_TARGET_AMBIGUOUS',
] as const;

/**
 * Dashboards and widgets (`code = VALIDATION_FAILED`, CONTRACTS §6, §28; T805):
 * 50 dashboards per base / 30 widgets per dashboard
 * (`DASHBOARD_LIMIT_EXCEEDED`, `WIDGET_LIMIT_EXCEEDED`, `params.limit`); a
 * place outside the 12-column grid or overlapping another widget
 * (`LAYOUT_OUT_OF_BOUNDS`, `LAYOUT_OVERLAP` with `params.widget_id`); `PUT
 * …/layout` missing a widget (`LAYOUT_INCOMPLETE`); a dimension that cannot
 * be grouped (`INVALID_DIMENSION`) or a date one without bucket
 * (`DATE_BUCKET_REQUIRED`); an aggregation that does not fit its field
 * (`INVALID_METRIC`); a binding or parent that is not a filter control of
 * the dashboard (`UNKNOWN_WIDGET`); a filter control whose field does not fit
 * its kind or whose parents loop (`INVALID_FILTER_CONTROL`). Also
 * `UNKNOWN_TABLE`, `UNKNOWN_FIELD`. Widget data (T806): more than 1 000
 * groups to compute (`WIDGET_TOO_LARGE`, `params.groups`, `params.limit`).
 * Live filters (T808): a global filter the dashboard does not declare
 * (`UNKNOWN_FILTER`), a value that does not fit the control kind or the
 * dimension (`INVALID_FILTER_VALUE`); a CSV export of a widget without an
 * aggregate table (`WIDGET_NOT_EXPORTABLE`).
 */
export const DASHBOARD_DETAIL_CODES = [
  'DASHBOARD_LIMIT_EXCEEDED',
  'WIDGET_LIMIT_EXCEEDED',
  'LAYOUT_OUT_OF_BOUNDS',
  'LAYOUT_OVERLAP',
  'LAYOUT_INCOMPLETE',
  'INVALID_DIMENSION',
  'DATE_BUCKET_REQUIRED',
  'INVALID_METRIC',
  'UNKNOWN_WIDGET',
  'INVALID_FILTER_CONTROL',
  'UNKNOWN_TABLE',
  'UNKNOWN_FIELD',
  'WIDGET_TOO_LARGE',
  'UNKNOWN_FILTER',
  'INVALID_FILTER_VALUE',
  'WIDGET_NOT_EXPORTABLE',
] as const;

/**
 * CSV/XLSX import (`code = VALIDATION_FAILED`, CONTRACTS §19; also `UNKNOWN_FIELD`, `DUPLICATE_FIELD`,
 * `FIELD_READ_ONLY`, `INVALID_FIELD_TYPE`), plus the row error `LINK_TARGET_AMBIGUOUS` (T411).
 */
export const IMPORT_DETAIL_CODES = [
  'TOO_MANY_ROWS',
  'TOO_MANY_COLUMNS',
  'INVALID_FILE',
  'ARCHIVE_LIMIT_EXCEEDED',
  'UNKNOWN_SHEET',
  'UNKNOWN_COLUMN',
  'DUPLICATE_COLUMN',
  'FILE_REQUIRED',
  'EMPTY_FILE',
  'LINK_TARGET_AMBIGUOUS',
] as const;

/** Share links (`code = VALIDATION_FAILED`, CONTRACTS §6, §16). */
export const SHARE_LINK_DETAIL_CODES = [
  'NOT_AVAILABLE_YET',
  'PERSONAL_VIEW',
  // T809: embedding (S7 decisions 14–16).
  'EMBED_NOT_SUPPORTED',
  'INVALID_ORIGIN',
  // T809: `GET /shares/{token}/meta` of a dashboard link (`404`): read `…/dashboard`.
  'DASHBOARD_LINK',
] as const;

/** Form submissions and form settings (CONTRACTS §6, §17). */
export const FORM_DETAIL_CODES = [
  'SUBMIT_TOKEN_INVALID',
  'SUBMITTED_TOO_FAST',
  'REQUIRES_LOGIN',
  'SUBMISSION_LIMIT_REACHED',
  'UNLOCK_REQUIRED',
  'UPLOAD_LIMIT_EXCEEDED',
] as const;

/** Table exports (`code = VALIDATION_FAILED`, CONTRACTS §18). */
export const EXPORT_DETAIL_CODES = ['EXPORT_TOO_LARGE'] as const;

/** Attachment uploads (`code = VALIDATION_FAILED`, CONTRACTS §20; BACKLOG T406). */
export const ATTACHMENT_DETAIL_CODES = [
  'FILE_TOO_LARGE',
  'MIME_NOT_ACCEPTED',
  'UPLOAD_INCOMPLETE',
  'SIZE_MISMATCH',
  'CONTENT_MISMATCH',
  'BLOCKED_FILE_TYPE',
] as const;

/**
 * Automations (`code = AUTOMATION_INVALID`, CONTRACTS §6, §21; BACKLOG T502):
 * the definition is checked against the base and the permissions of the
 * person saving it (ADR-25 §3). Filters in it also report the
 * `FILTER_DETAIL_CODES`; unreadable tables, fields and views answer
 * `UNKNOWN_TABLE` / `UNKNOWN_FIELD` / `UNKNOWN_VIEW` like missing ones.
 * Templates (`{ template }`, `digest.row_template`) report formula codes
 * (`FORMULA_DETAIL_CODES`) and the template codes below with
 * `params.position` (BACKLOG T504).
 */
export const AUTOMATION_DETAIL_CODES = [
  'PERMISSION_DENIED',
  'UNKNOWN_TABLE',
  'UNKNOWN_FIELD',
  'UNKNOWN_VIEW',
  'INVALID_FIELD_TYPE',
  'FIELD_READ_ONLY',
  'TOO_MANY_ACTIONS',
  'DUPLICATE_ACTION_ID',
  'UNKNOWN_STEP',
  'NO_TRIGGER_RECORD',
  'NOT_TRIGGER_TABLE',
  'UNSUPPORTED_VALUE_SOURCE',
  'NO_ACTIONS',
  // Templates and digests (T504): `params.position` in the template, plus the
  // `FORMULA_DETAIL_CODES` of each `{{ }}` expression.
  'UNSUPPORTED_FUNCTION',
  'CROSS_TABLE_NOT_SUPPORTED',
  'UNTERMINATED_PLACEHOLDER',
  'EMPTY_PLACEHOLDER',
  'TOO_MANY_PLACEHOLDERS',
  // `send_email` (T514): a literal recipient that is not an address, a Reply-To
  // that is neither a verified identity nor a Cellhive user. Identity and footer
  // refusals are `EMAIL_IDENTITY_DETAIL_CODES` / `EMAIL_SETTINGS_DETAIL_CODES`.
  'INVALID_EMAIL',
  'EMAIL_REPLY_TO_INVALID',
  // `send_email` attachments (T532): not an attachment field of the trigger
  // record (or twice, or no trigger record), files the saver may not download;
  // "Send a test to me" whose files would fail the step (`params.code`).
  'ATTACHMENT_FIELD_INVALID',
  'ATTACHMENT_FIELD_NOT_DOWNLOADABLE',
  'ATTACHMENTS_UNAVAILABLE',
  // `schedule` (T508): a cron that does not parse (`params.field`), fires more
  // often than every 5 minutes (`params.min_interval_minutes`), or an unknown
  // IANA time zone.
  'INVALID_CRON',
  'CRON_TOO_FREQUENT',
  'INVALID_TIME_ZONE',
  // `send_notification` (T515): a fixed recipient that is not an active member of
  // the organization, a recipient group that does not exist (no existence leak
  // across organizations: same codes).
  'USER_NOT_FOUND',
  'GROUP_NOT_FOUND',
  // `button.clicked` (T517): another automation (not deleted) is already attached
  // to the button (`params.automation_id`).
  'BUTTON_IN_USE',
  // `webhook.received` (T604): the hook is not a live incoming webhook of the base;
  // a `condition` on that trigger (it has no record).
  'UNKNOWN_WEBHOOK',
  'INVALID_CONDITION',
  // `http_request` (T606): a header the outbox sets, of the connection, `proxy-*`
  // or given twice (`params.name`, `params.reason`: `reserved` | `duplicate`); a
  // literal URL that can never be called (`params.reason` like `ssrf_blocked`).
  'HEADER_NOT_ALLOWED',
  'INVALID_URL',
] as const;

/**
 * Button clicks (T517, CONTRACTS §2, §21; `code = VALIDATION_FAILED`, path
 * `field_id`): the button cannot run now — `params.reason` is
 * `no_automation`, `automation_disabled` or `condition` (`BUTTON_DISABLED_REASONS`).
 */
export const BUTTON_DETAIL_CODES = ['BUTTON_DISABLED'] as const;

/**
 * Filters (`code = INVALID_FILTER`), produced by `@cellhive/filter-dsl`
 * (`FILTER_ISSUE_CODES` there must stay equal; its tests check it).
 */
export const FILTER_DETAIL_CODES = [
  'INVALID_STRUCTURE',
  'UNKNOWN_FIELD',
  'OPERATOR_NOT_ALLOWED',
  'VALUE_REQUIRED',
  'VALUE_NOT_ALLOWED',
  'INVALID_VALUE',
  'INVALID_SELECT_OPTION',
  'UNKNOWN_FIELD_REF',
  'MAX_DEPTH_EXCEEDED',
  'MAX_CONDITIONS_EXCEEDED',
  'EMPTY_FILTER',
] as const;

/**
 * Formulas and lookups (CONTRACTS §6, §13; BACKLOG T451/T452/T456):
 * `errors[].code` of `422 FORMULA_SYNTAX_ERROR` (parse and name
 * resolution), `FORMULA_TYPE_ERROR` (typecheck; lookups too),
 * `FORMULA_LIMIT_EXCEEDED` (SPEC §9.5, `params.limit`) and `FORMULA_CYCLE`
 * (`params.cycle`), each with `params.position` (`{ start, length }` in
 * the expression, UTF-16). The first three lists equal the issue codes of
 * `@cellhive/formula-engine` (its tests check it); `MAX_COMPUTED_FIELDS`
 * (200 computed fields per base), `MAX_COMPILED_SIZE` (the SQL compile
 * budget, `params.unit` = `bytes` | `parameters`) and `CIRCULAR_REFERENCE`
 * come from the server.
 */
export const FORMULA_SYNTAX_DETAIL_CODES = [
  'UNEXPECTED_TOKEN',
  'UNEXPECTED_END',
  'UNEXPECTED_CHARACTER',
  'UNTERMINATED_STRING',
  'UNTERMINATED_NAME',
  'EMPTY_NAME',
  'INVALID_REFERENCE',
  'UNKNOWN_NAME',
  'UNKNOWN_FUNCTION',
  'UNSUPPORTED_FUNCTION',
  'INVALID_LET',
  'RESERVED_NAME',
  'DUPLICATE_VARIABLE',
  'UNKNOWN_FIELD',
  'UNKNOWN_TABLE',
  'NOT_A_LINK',
  'INVALID_MEMBER',
  'INVALID_CURRENT_VALUE',
] as const;

export const FORMULA_TYPE_DETAIL_CODES = [
  'TYPE_MISMATCH',
  'LIST_AS_SCALAR',
  'NESTED_LIST',
  'TABLE_NEEDS_FIELD',
  'EXPECTED_LIST',
  'WRONG_ARGUMENT_COUNT',
  'NESTED_ITERATION',
  'CURRENT_VALUE_OUTSIDE_ITERATION',
  'MIXED_LIST',
  'INVALID_ARGUMENT',
  'INVALID_LOOKUP',
] as const;

export const FORMULA_LIMIT_DETAIL_CODES = [
  'MAX_LENGTH',
  'MAX_DEPTH',
  'MAX_LINK_CHAIN',
  'MAX_CROSS_TABLE_FILTERS',
  'MAX_ARGUMENTS',
  'MAX_LET_VARIABLES',
  'MAX_COMPUTED_FIELDS',
  'MAX_COMPILED_SIZE',
] as const;

export const FORMULA_CYCLE_DETAIL_CODES = ['CIRCULAR_REFERENCE'] as const;

export const FORMULA_DETAIL_CODES = [
  ...FORMULA_SYNTAX_DETAIL_CODES,
  ...FORMULA_TYPE_DETAIL_CODES,
  ...FORMULA_LIMIT_DETAIL_CODES,
  ...FORMULA_CYCLE_DETAIL_CODES,
] as const;

/** Setup and password flows (`code = VALIDATION_FAILED`, CONTRACTS §12.0). */
export const AUTH_DETAIL_CODES = [
  'TOO_SMALL',
  'PASSWORD_TOO_COMMON',
  'NO_PASSWORD',
  'INVALID_LOCALE',
  'INVALID_TIME_ZONE',
  'CURRENT_PASSWORD_INVALID',
] as const;

/**
 * Sender identities (CONTRACTS §23.3, T530): `VALIDATION_FAILED` on saves
 * (`EMAIL_TAKEN`, `INVALID_EMAIL`, `HOST_NOT_ALLOWED`, `HOST_UNRESOLVABLE`,
 * `INSECURE_NOT_CONFIRMED`, `SMTP_REQUIRED`, `SMTP_NOT_ALLOWED`,
 * `PASSWORD_REQUIRED`, `UNKNOWN_BASE`, `IDENTITY_LIMIT_REACHED`,
 * `TRANSPORT_NOT_SMTP`, `NOT_VERIFIABLE`, and `DISPLAY_NAME_NOT_ALLOWED` with
 * `params.reason` — T540), `EMAIL_VERIFICATION_INVALID`
 * (`TOKEN_INVALID`, `CODE_INVALID` with `params.attempts_left`,
 * `CODE_LOCKED`, `NO_PENDING_VERIFICATION`), and `EMAIL_IDENTITY_NOT_USABLE`
 * under `AUTOMATION_INVALID` (T514).
 */
export const EMAIL_IDENTITY_DETAIL_CODES = [
  'EMAIL_TAKEN',
  'HOST_NOT_ALLOWED',
  'HOST_UNRESOLVABLE',
  'INSECURE_NOT_CONFIRMED',
  'SMTP_REQUIRED',
  'SMTP_NOT_ALLOWED',
  'PASSWORD_REQUIRED',
  'UNKNOWN_BASE',
  'IDENTITY_LIMIT_REACHED',
  'TRANSPORT_NOT_SMTP',
  'NOT_VERIFIABLE',
  'DISPLAY_NAME_NOT_ALLOWED',
  'TOKEN_INVALID',
  'CODE_INVALID',
  'CODE_LOCKED',
  'NO_PENDING_VERIFICATION',
  'EMAIL_IDENTITY_NOT_USABLE',
] as const;

/**
 * Automation email settings (CONTRACTS §23.4, T531): `PLACEHOLDER_NOT_ALLOWED`
 * (`VALIDATION_FAILED`: a signature containing `{{`), and
 * `EMAIL_FOOTER_NOT_ALLOWED` under `AUTOMATION_INVALID` (`footer: none`
 * against the policy or with the system/`on_behalf` sender, T514).
 */
export const EMAIL_SETTINGS_DETAIL_CODES = [
  'PLACEHOLDER_NOT_ALLOWED',
  'EMAIL_FOOTER_NOT_ALLOWED',
] as const;

/**
 * Organization secrets (CONTRACTS §24, T516): `VALIDATION_FAILED` on saves
 * (`SECRET_NAME_TAKEN`, `INVALID_BOT_TOKEN`, `INVALID_SECRET_VALUE` — T606,
 * `SECRET_LIMIT_REACHED`, `UNKNOWN_BASE`, `BOT_IN_USE`), `SECRET_IN_USE` under `409 SECRET_IN_USE` (delete;
 * `params.usages`, `params.total`), and `SECRET_NOT_USABLE` under
 * `AUTOMATION_INVALID` (`send_telegram`, `http_request`, `run_n8n_workflow`).
 * Allowed hosts of HTTP secrets (T701, ADR-36 §4): `SECRET_HOSTS_REQUIRED`,
 * `TOO_MANY_ALLOWED_HOSTS` (path `allowed_hosts`; a bad entry is
 * `INVALID_ALLOWLIST_PATTERN`) on saves, `SECRET_HOST_NOT_ALLOWED` under
 * `AUTOMATION_INVALID` (a literal URL the secret may not be sent to).
 */
export const SECRET_DETAIL_CODES = [
  'SECRET_NAME_TAKEN',
  'INVALID_BOT_TOKEN',
  'INVALID_SECRET_VALUE',
  'SECRET_LIMIT_REACHED',
  'UNKNOWN_BASE',
  'SECRET_IN_USE',
  'SECRET_NOT_USABLE',
  'BOT_IN_USE',
  'SECRET_HOSTS_REQUIRED',
  'TOO_MANY_ALLOWED_HOSTS',
  'SECRET_HOST_NOT_ALLOWED',
] as const;

/**
 * Outbound HTTP allowlist (CONTRACTS §25.4, T600), under `VALIDATION_FAILED`
 * (path `pattern`): not an exact host or `*.suffix` with an optional port —
 * IP addresses and CIDR included (`INVALID_ALLOWLIST_PATTERN`), the canonical
 * pattern is already listed (`ALLOWLIST_ENTRY_EXISTS`), 100 entries already
 * (`TOO_MANY_ALLOWLIST_ENTRIES`).
 */
export const HTTP_ALLOWLIST_DETAIL_CODES = [
  'INVALID_ALLOWLIST_PATTERN',
  'ALLOWLIST_ENTRY_EXISTS',
  'TOO_MANY_ALLOWLIST_ENTRIES',
] as const;

/**
 * Incoming webhooks (CONTRACTS §25.1, T602): `VALIDATION_FAILED` on saves —
 * `WEBHOOK_NAME_TAKEN` (path `name`), `TOO_MANY_WEBHOOKS` (50 per base),
 * `RATE_LIMIT_TOO_HIGH` (path `rate_limit_per_sec`, above
 * `WEBHOOK_MAX_RATE_PER_SEC`), `CREDENTIAL_REQUIRED` (path `auth`, `PATCH`
 * adding a check) — and `WEBHOOK_IN_USE` under `409 WEBHOOK_IN_USE` (delete;
 * `params.usages`, `params.total`).
 */
export const INCOMING_WEBHOOK_DETAIL_CODES = [
  'WEBHOOK_NAME_TAKEN',
  'TOO_MANY_WEBHOOKS',
  'RATE_LIMIT_TOO_HIGH',
  'CREDENTIAL_REQUIRED',
  'WEBHOOK_IN_USE',
] as const;

/**
 * Notification channels (CONTRACTS §22.7, T549): `VALIDATION_FAILED` of
 * `PATCH /orgs/:orgId/notification-channels` — `UNKNOWN_SECRET` (not a
 * `telegram_bot` secret of the organization), `INVALID_BOT_TOKEN`
 * (Telegram `getMe` refused the token) and `BOT_IN_USE` (the bot is the
 * notification bot of another organization, QA S5b M3 — also on a new
 * token of the notification bot through `PATCH /secrets/:id`); T609 adds
 * `PUBLIC_URL_NOT_HTTPS` and `TELEGRAM_WEBHOOK_CONFLICT` (path
 * `telegram_delivery_mode`, webhook mode).
 */
export const NOTIFICATION_CHANNEL_DETAIL_CODES = [
  'UNKNOWN_SECRET',
  'INVALID_BOT_TOKEN',
  'BOT_IN_USE',
  'PUBLIC_URL_NOT_HTTPS',
  'TELEGRAM_WEBHOOK_CONFLICT',
] as const;

/**
 * Email images (CONTRACTS §23.5, T534), under `VALIDATION_FAILED` (signatures,
 * uploads, deleting an asset) and `AUTOMATION_INVALID` (`send_email` body):
 * image syntax with a URL/`data:`/`cid:` or a source not allowed there
 * (`IMAGE_SOURCE_NOT_ALLOWED`), an unknown asset (`EMAIL_IMAGE_NOT_FOUND`), too
 * many images (`TOO_MANY_IMAGES`), deleting an asset still shown
 * (`EMAIL_IMAGE_IN_USE`), an upload that is not a readable raster image
 * (`IMAGE_UNREADABLE`). Uploads also report `ATTACHMENT_DETAIL_CODES`.
 */
export const EMAIL_IMAGE_DETAIL_CODES = [
  'IMAGE_SOURCE_NOT_ALLOWED',
  'EMAIL_IMAGE_NOT_FOUND',
  'TOO_MANY_IMAGES',
  'EMAIL_IMAGE_IN_USE',
  'IMAGE_UNREADABLE',
] as const;

/**
 * Following records (CONTRACTS §22.5, T543), under `VALIDATION_FAILED`:
 * following one more record than `MAX_RECORD_FOLLOWS_PER_USER` by hand
 * (`TOO_MANY_FOLLOWS`, `params.maximum`).
 */
export const RECORD_FOLLOW_DETAIL_CODES = ['TOO_MANY_FOLLOWS'] as const;

/**
 * API tokens (CONTRACTS §26.4, T703), under `VALIDATION_FAILED`: the member
 * already has 50 tokens not revoked (`TOO_MANY_TOKENS`), `expires_at` is
 * `null` or beyond `max_lifetime_days` of the organization policy
 * (`TOKEN_LIFETIME_EXCEEDED`, path `expires_at`, `params.max_lifetime_days`).
 */
export const API_TOKEN_DETAIL_CODES = ['TOO_MANY_TOKENS', 'TOKEN_LIFETIME_EXCEEDED'] as const;

/**
 * API token scopes (CONTRACTS §26.3, T704), under `403 INSUFFICIENT_SCOPE`:
 * the scope the route needs (`INSUFFICIENT_SCOPE`, path `""`,
 * `params.required`: `["records:write"]` | `["session"]`).
 */
export const API_TOKEN_SCOPE_DETAIL_CODES = ['INSUFFICIENT_SCOPE'] as const;

/**
 * OIDC sign-in (CONTRACTS §27.2, T707): not problem documents — the callback
 * redirects to `/login?error=<CODE>` and the sign-in page translates the
 * code like a detail code. `OIDC_STATE_INVALID`: the state cookie is missing,
 * expired, already used or does not match; `OIDC_PROVIDER_ERROR`: the
 * provider refused or failed (its `error_description` is never shown), or
 * its response did not validate (ID token issuer, audience, expiry, nonce,
 * signature); `OIDC_ACCOUNT_EXISTS`: an account with this email exists and
 * is not linked (sign in with the password, then link it); the other three
 * refuse creating an account (sign-up off, email not verified, domain not
 * allowed).
 */
export const OIDC_LOGIN_DETAIL_CODES = [
  'OIDC_STATE_INVALID',
  'OIDC_PROVIDER_ERROR',
  'OIDC_ACCOUNT_EXISTS',
  'OIDC_SIGNUP_DISABLED',
  'OIDC_EMAIL_UNVERIFIED',
  'OIDC_DOMAIN_NOT_ALLOWED',
] as const;

/**
 * Connected accounts (CONTRACTS §27.3, T708). `IDENTITY_IN_USE`: not a
 * problem document — the link callback redirects to
 * `/account/connections?error=IDENTITY_IN_USE` when the provider account
 * belongs to another user, or the caller already has another account of
 * that provider. `LAST_LOGIN_METHOD`: under `422 VALIDATION_FAILED` of
 * `DELETE /me/identities/:id` (path `userIdentityId`) when the caller has no
 * password and this is their only identity.
 */
export const OIDC_LINK_DETAIL_CODES = ['IDENTITY_IN_USE', 'LAST_LOGIN_METHOD'] as const;

/** `/readyz` (`code = DEPENDENCY_UNAVAILABLE`). */
export const HEALTH_DETAIL_CODES = ['DEPENDENCY_DOWN'] as const;

/**
 * Generic request-validation codes that may appear on any endpoint: query
 * strings, strict objects, and the codes derived from zod issues by the
 * server (`EXPECTED_<type>`, `TOO_SMALL`, `INVALID_FORMAT`…).
 */
export const REQUEST_DETAIL_CODES = [
  'MALFORMED_JSON',
  'REQUIRED',
  'NOT_ALLOWED',
  'UNRECOGNIZED_KEY',
  'INVALID',
  'INVALID_TYPE',
  'INVALID_FORMAT',
  'INVALID_UNION',
  'INVALID_KEY',
  'INVALID_ELEMENT',
  'INVALID_VALUE',
  'NOT_MULTIPLE_OF',
  'TOO_SMALL',
  'TOO_BIG',
  'OUT_OF_RANGE',
  'EXPECTED_STRING',
  'EXPECTED_NUMBER',
  'EXPECTED_BOOLEAN',
  'EXPECTED_ARRAY',
  'EXPECTED_OBJECT',
] as const;

/**
 * The AI core (CONTRACTS §29.7, ADR-39; T905): `errors[0]` of
 * `502 AI_PROVIDER_ERROR` (`params.reason` ∈ {@link AI_PROVIDER_ERROR_REASONS},
 * plus `status` for `http_status`) and of `422 AI_INVALID_OUTPUT`
 * (`params.attempts`), both with path `""`; T906 adds `errors[0]` of
 * `429 AI_QUOTA_EXCEEDED` (`params.reset_at`, `params.daily_token_limit`).
 */
export const AI_DETAIL_CODES = [
  'AI_PROVIDER_ERROR',
  'AI_INVALID_OUTPUT',
  'AI_QUOTA_EXCEEDED',
] as const;

/**
 * AI settings of an organization (CONTRACTS §29.1, T906), under
 * `VALIDATION_FAILED`: turning `allow_record_data` on without `confirm: true`
 * (`RECORD_DATA_NOT_CONFIRMED`, path `confirm`); a provider URL the SSRF
 * core never calls (`INVALID_URL`, path `provider_base_url`); a key without
 * a provider URL (`REQUIRED`, path `provider_base_url`), of a shape that
 * cannot go in a header (`INVALID_SECRET_VALUE`, path `api_key.value`) or
 * for an IP address (`SECRET_HOST_NOT_ALLOWED`, path `api_key`); a
 * `secret_id` that is not an `ai_api_key` secret of the organization
 * (`UNKNOWN_SECRET`, path `api_key.secret_id`); a usage range that is
 * reversed or longer than 90 days (`OUT_OF_RANGE`, path `from`).
 */
export const AI_SETTINGS_DETAIL_CODES = [
  'RECORD_DATA_NOT_CONFIRMED',
  'INVALID_URL',
  'REQUIRED',
  'INVALID_SECRET_VALUE',
  'SECRET_HOST_NOT_ALLOWED',
  'UNKNOWN_SECRET',
  'OUT_OF_RANGE',
] as const;

/**
 * Why a call to the AI provider failed (`params.reason` of
 * `AI_PROVIDER_ERROR`): `http_status` (an error status, or a `3xx` — never
 * followed), `network`, `ssrf_blocked` (the base URL may not be called; no
 * connection opened), `secret_host_not_allowed` (the key may not go to this
 * host; not sent, not decrypted), `secret_unavailable` (the key is gone or
 * cannot be decrypted), `invalid_response` (not a Chat Completions answer),
 * `response_too_large` (> 1 MiB), `refused` (the model's `refusal`),
 * `truncated` (`finish_reason = length`).
 */
export const AI_PROVIDER_ERROR_REASONS = [
  'http_status',
  'network',
  'ssrf_blocked',
  'secret_host_not_allowed',
  'secret_unavailable',
  'invalid_response',
  'response_too_large',
  'refused',
  'truncated',
] as const;

export type AiProviderErrorReason = (typeof AI_PROVIDER_ERROR_REASONS)[number];

/** Every documented detail code, once. */
export const ERROR_DETAIL_CODES = [
  ...new Set([
    ...CELL_VALUE_DETAIL_CODES,
    ...RECORD_QUERY_DETAIL_CODES,
    ...RECORD_WRITE_DETAIL_CODES,
    ...ROLE_DETAIL_CODES,
    ...ADMIN_DETAIL_CODES,
    ...SCHEMA_DETAIL_CODES,
    ...FIELD_CONVERSION_DETAIL_CODES,
    ...VIEW_DETAIL_CODES,
    ...DASHBOARD_DETAIL_CODES,
    ...IMPORT_DETAIL_CODES,
    ...SHARE_LINK_DETAIL_CODES,
    ...FORM_DETAIL_CODES,
    ...EXPORT_DETAIL_CODES,
    ...ATTACHMENT_DETAIL_CODES,
    ...AUTOMATION_DETAIL_CODES,
    ...BUTTON_DETAIL_CODES,
    ...FILTER_DETAIL_CODES,
    ...FORMULA_DETAIL_CODES,
    ...AUTH_DETAIL_CODES,
    ...EMAIL_IDENTITY_DETAIL_CODES,
    ...EMAIL_SETTINGS_DETAIL_CODES,
    ...SECRET_DETAIL_CODES,
    ...HTTP_ALLOWLIST_DETAIL_CODES,
    ...INCOMING_WEBHOOK_DETAIL_CODES,
    ...NOTIFICATION_CHANNEL_DETAIL_CODES,
    ...EMAIL_IMAGE_DETAIL_CODES,
    ...RECORD_FOLLOW_DETAIL_CODES,
    ...API_TOKEN_DETAIL_CODES,
    ...API_TOKEN_SCOPE_DETAIL_CODES,
    ...OIDC_LOGIN_DETAIL_CODES,
    ...OIDC_LINK_DETAIL_CODES,
    ...HEALTH_DETAIL_CODES,
    ...REQUEST_DETAIL_CODES,
    ...AI_DETAIL_CODES,
    ...AI_SETTINGS_DETAIL_CODES,
  ]),
] as readonly ErrorDetailCode[];

export type ErrorDetailCode =
  | (typeof CELL_VALUE_DETAIL_CODES)[number]
  | (typeof RECORD_QUERY_DETAIL_CODES)[number]
  | (typeof IMPORT_DETAIL_CODES)[number]
  | (typeof RECORD_WRITE_DETAIL_CODES)[number]
  | (typeof ROLE_DETAIL_CODES)[number]
  | (typeof ADMIN_DETAIL_CODES)[number]
  | (typeof SCHEMA_DETAIL_CODES)[number]
  | (typeof FIELD_CONVERSION_DETAIL_CODES)[number]
  | (typeof VIEW_DETAIL_CODES)[number]
  | (typeof DASHBOARD_DETAIL_CODES)[number]
  | (typeof SHARE_LINK_DETAIL_CODES)[number]
  | (typeof FORM_DETAIL_CODES)[number]
  | (typeof EXPORT_DETAIL_CODES)[number]
  | (typeof ATTACHMENT_DETAIL_CODES)[number]
  | (typeof AUTOMATION_DETAIL_CODES)[number]
  | (typeof BUTTON_DETAIL_CODES)[number]
  | (typeof FILTER_DETAIL_CODES)[number]
  | (typeof FORMULA_DETAIL_CODES)[number]
  | (typeof AUTH_DETAIL_CODES)[number]
  | (typeof EMAIL_IDENTITY_DETAIL_CODES)[number]
  | (typeof EMAIL_SETTINGS_DETAIL_CODES)[number]
  | (typeof SECRET_DETAIL_CODES)[number]
  | (typeof HTTP_ALLOWLIST_DETAIL_CODES)[number]
  | (typeof INCOMING_WEBHOOK_DETAIL_CODES)[number]
  | (typeof NOTIFICATION_CHANNEL_DETAIL_CODES)[number]
  | (typeof EMAIL_IMAGE_DETAIL_CODES)[number]
  | (typeof RECORD_FOLLOW_DETAIL_CODES)[number]
  | (typeof API_TOKEN_DETAIL_CODES)[number]
  | (typeof API_TOKEN_SCOPE_DETAIL_CODES)[number]
  | (typeof OIDC_LOGIN_DETAIL_CODES)[number]
  | (typeof OIDC_LINK_DETAIL_CODES)[number]
  | (typeof HEALTH_DETAIL_CODES)[number]
  | (typeof REQUEST_DETAIL_CODES)[number]
  | (typeof AI_DETAIL_CODES)[number]
  | (typeof AI_SETTINGS_DETAIL_CODES)[number];
