# The Cellhive API with personal API tokens

This guide is for scripts, back-end services and integrations (n8n, CI jobs, cron scripts, data pipelines) that call the Cellhive REST API or the realtime WebSocket **as a person**, without a browser session.

- **API tokens**: how to create one, what it looks like, what it may do (scopes and bases), and when it stops working.
- **Calling the API**: the errors to expect (`401`, `403 INSUFFICIENT_SCOPE`, `404`), rate limits, `Idempotency-Key`, and examples in `curl`, JavaScript and Python.
- **Realtime with a token**: opening `/ws` from Node.js.
- **Dashboards**: reading dashboards and the numbers of their widgets (§11).
- **What others see**: how changes made with a token appear in record history and the audit log.

The normative formats are in `docs/CONTRACTS.md` §1.1, §6, §7, §26 and §28. The architecture is in ADR-36 (and ADR-38 for dashboards). Building, reading and sharing dashboards in the app is described in [dashboards.md](dashboards.md). If this guide and those documents disagree, the contracts win. Please report the mismatch.

## Contents

1. [API tokens](#1-api-tokens)
2. [Scopes and bases](#2-scopes-and-bases)
3. [Calling the API](#3-calling-the-api)
4. [Errors: `401`, `403` and `404`](#4-errors-401-403-and-404)
5. [Rate limits](#5-rate-limits)
6. [Retries and `Idempotency-Key`](#6-retries-and-idempotency-key)
7. [Examples](#7-examples)
8. [Realtime (WebSocket) with a token](#8-realtime-websocket-with-a-token)
9. [History and audit: "via an API token"](#9-history-and-audit-via-an-api-token)
10. [Files, exports, imports and jobs](#10-files-exports-imports-and-jobs)
11. [Dashboards](#11-dashboards)
12. [Organization policy (owners and admins)](#12-organization-policy-owners-and-admins)
13. [Troubleshooting](#13-troubleshooting)
14. [Reference: limits](#14-reference-limits)

---

## 1. API tokens

A token belongs to **one member of one organization**. It acts as that member: it can never do more than the member can do in the app right now, and only what its scopes and bases allow (§2). If the member's role changes, the token's access changes with it on the next request.

### 1.1 Creating a token

1. Open the user menu (bottom left) → **API tokens**, or go to `/o/<organization>/settings/api-tokens`. The page is for the organization on screen; a token of one organization never works in another.
2. Click **New token**, then:
   - **Name**: what uses it, for example "CI export" (1–100 characters). The name appears in history and in the organization's token list (§9, §12).
   - **Access**: start from a preset, then adjust the scopes (§2):

     | Preset | Scopes |
     | --- | --- |
     | Read data | `records:read`, `schema:read` |
     | Read and write data | `records:read`, `records:write`, `schema:read` |
     | Manage structure | `records:read`, `schema:read`, `schema:write` |
     | Automation | `records:read`, `schema:read`, `automations:read`, `automations:write` |

   - **Bases**: all bases you can open, or only the bases you pick (up to 50).
   - **Expiration**: 7, 30, **90 (default)** or 365 days, a custom date (at most 3,650 days away), or "No expiration" when the organization allows it (§12).
3. Click **Create token** and **copy the token now**. It is shown once. Cellhive stores only its SHA-256 hash, so a lost token cannot be shown again: revoke it and create a new one.

Creating, renaming and revoking tokens needs a signed-in session. A token cannot create or manage tokens (those routes answer `403 INSUFFICIENT_SCOPE` with `required: ["session"]`). The routes are `GET|POST /api/v1/orgs/:orgId/me/api-tokens`, `PATCH|DELETE /api/v1/api-tokens/:id` (C§26.4).

A member can hold at most **50** tokens that are not revoked in an organization, expired ones included (`422 VALIDATION_FAILED` / `TOO_MANY_TOKENS`). Revoke the ones you no longer use.

### 1.2 Token format and secret scanners

```text
cht_4fZ0qLm1pX8sKd2Rw7Yt3NvB9cHj5G2qSK0L
└┬─┘└───────── 30 random ────────┘└─┬──┘
 prefix   base62 (0-9A-Za-z), CSPRNG   CRC32 of the 30, base62
```

- A token is always `cht_` followed by 36 base62 characters (40 characters in all). It matches `cht_[0-9A-Za-z]{36}`.
- The last 6 characters are the CRC32 of the 30 random characters, written in base62 with the alphabet `0-9A-Za-z` and padded with `0` on the left (the GitHub token scheme). A mistyped or made-up token is refused **without a database lookup**, and secret scanners can tell a real token from a random string. Python check:

  ```python
  import re, zlib

  ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

  def looks_like_cellhive_token(value: str) -> bool:
      if not re.fullmatch(r"cht_[0-9A-Za-z]{36}", value):
          return False
      random_part, checksum = value[4:34], value[34:]
      n, digits = zlib.crc32(random_part.encode()), ""
      while n:
          n, r = divmod(n, 62)
          digits = ALPHABET[r] + digits
      return digits.rjust(6, "0") == checksum
  ```

- The token list shows `cht_` + the first 8 random characters (`cht_4fZ0qLm1…`) so you can tell tokens apart. The value itself never appears in a response other than the creation response, nor in logs, audit, events or errors.
- Keep tokens out of code repositories, CI logs and URLs. Put them in your CI's secret store or an environment variable. If a token leaks, **revoke it**: the next request with it fails, and WebSocket connections using it are closed (§8).

### 1.3 When a token stops working

A token authenticates only while **all** of these hold:

| Condition | Otherwise |
| --- | --- |
| Not revoked (by you, or by an organization owner/admin) | `401 TOKEN_REVOKED` |
| Not expired (`expires_at` in the future) | `401 TOKEN_EXPIRED` |
| The organization has API tokens turned on (§12) | `401 UNAUTHENTICATED` |
| Your account is active and still a member of the organization | `401 UNAUTHENTICATED` |

**Resetting your password revokes your tokens** in every organization, by default: the reset screen has "Revoke all my API tokens" ticked (untick it to keep them), `POST /api/v1/auth/password-reset/:token` revokes unless the body says `"revoke_tokens": false`, an admin's reset link revokes them when the link is created unless the admin sends `{ "revoke_tokens": false }`, and the server command `cellhive user reset-password` revokes them unless run with `--keep-tokens`. A reset usually means the account may have been taken over, and a token created by someone else would keep working otherwise. After a reset, create new tokens and update your integrations. The audit log of each organization shows one `api_token.revoked` entry with `reason: "password_reset"` and the number of tokens.

Leaving the organization (or being removed) **deletes** your tokens there. Revoked and expired tokens stay in the list for 90 days, then they are deleted. The list shows a warning on tokens that expire within 7 days. `last_used_at` is updated at most once every 5 minutes.

---

## 2. Scopes and bases

What a request may do is the **intersection** of four things:

> your current permissions in the app ∩ the token's scopes ∩ the token's bases ∩ the token's organization

### 2.1 Scopes

The list is closed. A write scope **never** includes the matching read scope: a token that creates records and reads them back needs both `records:write` and `records:read`.

| Scope | Allows |
| --- | --- |
| `records:read` | Read records (list, get, query, group counts, summaries, tree, history, trash), link candidates, export, download files and thumbnails, read jobs you started, list base members, form submission status; dashboard **numbers**: widget data, filter values, the records behind a widget and widget CSV (§11) |
| `records:write` | Create, update, delete, restore, purge and revert records; upload files; imports into a table; click buttons; submit a form of a view |
| `schema:read` | Read workspaces, bases, tables, fields and views; dashboards (list, one dashboard with its widgets, dashboard trash); `GET /me`, `GET /orgs` |
| `schema:write` | Create, change and delete tables, fields and views; convert field types; import that creates a table (with `records:write`); create, change, delete, restore and duplicate dashboards, their layout and their widgets |
| `automations:read` | Read automations, runs and run history, HTTP test results, incoming webhook requests and samples |
| `automations:write` | Create, change, enable, disable, duplicate, take over, test and re-run automations; manage incoming webhooks, including **reading** a hook (its response contains the URL that triggers it) |

**Record values never flow through an automation scope.** Previewing or test-sending an email and test-sending an HTTP step with a `record_id` also need `records:read` (`403 INSUFFICIENT_SCOPE`, `required: ["records:read"]`), and the run detail read with a token that lacks `records:read` hides every record value of the steps. An automation created, changed or enabled with a token runs as the token's owner, so `automations:write` lets the integration build automations that read and write records **within the owner's permissions** — grant it only to integrations meant to do that. The "Automation" preset of the token dialog includes `records:read` for this reason, and its description says so ("read record values (previews, test sends, run details)"); untick it for an integration that only manages automations and never needs record values (C§26.2).

**Session only.** Some routes never accept a token, whatever its scopes: API token management, roles and role assignments, members, groups, workspaces (create/change/members), invitations, secrets, the HTTP allowlist, share link management (of views, forms and dashboards, embedding included), the audit log, organization settings, creating/changing/deleting bases, sender identities, password reset links, your notifications and channels, following records, and connected accounts (`/me/identities`). A token gets `403 INSUFFICIENT_SCOPE` with `required: ["session"]` on them.

**Route by route.** Every operation in the OpenAPI document (`GET /api/v1/openapi.json`) carries `x-api-token-scope`: a scope, `session` or `public`. Operations that accept a token also list `{ "apiToken": ["<scope>"] }` under `security`. The source of the table is `packages/contracts/src/api-token-scopes.ts`, and C§26.3 describes it. A route missing from the table is treated as `session` (deny by default).

**Public routes** (`/shares/*`, `/hooks/*`, sign-in, `/setup`, invitations, health, `/openapi.json`) ignore the `Authorization` header entirely. A token sent there is neither checked nor counted.

### 2.2 Bases

A token limited to some bases sees **only** those bases: `GET /orgs` and `GET /me` show only the token's organization, workspace and base lists contain only those bases (and the workspaces that hold them), and anything in another base (a table, field, view, record, automation, run or hook) answers `404`, as if it did not exist.

The bases are checked when you create the token (each must be one you can open). After that, your access is checked on every request. If you lose access to a base, the token loses it too.

---

## 3. Calling the API

Send the token in the `Authorization` header with the `Bearer` scheme:

```http
GET /api/v1/tables/tbl_8fK2mQ1xZp0aB7cD/records?limit=50 HTTP/1.1
Host: cellhive.example.com
Authorization: Bearer cht_4fZ0qLm1pX8sKd2Rw7Yt3NvB9cHj5G2qSK0L
```

- The base path is `<PUBLIC_URL>/api/v1`. JSON keys are `snake_case`, times are ISO 8601 UTC. Record bodies and responses are described in C§1.4. Field names (`field_key_type=name`, the default) or ids (`field_key_type=id`) can be used as keys. Prefer ids in long-lived integrations: a renamed field breaks name-based scripts.
- **The header decides.** A request with an `Authorization` header (on a route that is not public) is authenticated by the header **only**. Cellhive never falls back to a session cookie, even if the request also has a valid one. If the token is wrong, the request fails with `401`.
- **No CSRF token.** Token requests do not need `X-CSRF-Token`; browsers never add this header by themselves.
- **Browsers.** CORS allows only the origins in `CORS_ORIGINS` (default: the origin of `PUBLIC_URL`), so a web page on another origin cannot call the API with a token. Call the API from a server, a script or an automation tool. Never put a token in front-end code.
- Errors are `application/problem+json` (C§6): `code` is stable and machine-readable, `detail` is English text for people, `errors[]` points at the faulty part (`path`, `code`, `params`). Every response has `X-Request-Id` (`req_…`); include it when you report a problem.

---

## 4. Errors: `401`, `403` and `404`

The three statuses mean different things, and your integration should treat them differently:

| Status | Meaning | What to do |
| --- | --- | --- |
| `401 UNAUTHENTICATED` | The header is not `Bearer <token>`, the token is malformed, unknown, or no longer valid (organization turned tokens off, user disabled or no longer a member) | Stop and alert a person. Do not retry in a loop: failed attempts count against a per-IP limit (§5). |
| `401 TOKEN_EXPIRED` | The token passed its `expires_at` | Create a new token and update the integration |
| `401 TOKEN_REVOKED` | Someone revoked it, or its owner reset their password (§1.3) | Find out why before creating a new one |
| `403 INSUFFICIENT_SCOPE` | The token is valid and may reach the resource, but lacks the scope this route (or this request) needs | Add the scope: create a new token with the scopes listed in `errors[0].params.required` |
| `403 PERMISSION_DENIED` (and other `403`s) | The scope is fine, but **your** permissions in the app do not allow it (for example a read-only role, or a field you cannot change) | Ask a base admin for access. The same request in the app would fail too. |
| `404 NOT_FOUND` | The resource does not exist, **or** it is outside what the token may reach: another organization, a base outside the token's bases, or something you cannot read | Check the id and the token's bases. Cellhive never says which. |

Every `401` on a token request carries

```http
WWW-Authenticate: Bearer error="invalid_token"
```

(RFC 6750). Tools that understand the header can use it to tell an authentication problem apart from an access problem.

`INSUFFICIENT_SCOPE` looks like this:

```json
{
  "type": "https://cellhive.io/errors/INSUFFICIENT_SCOPE",
  "title": "Insufficient scope",
  "status": 403,
  "code": "INSUFFICIENT_SCOPE",
  "detail": "This API token lacks the records:write scope.",
  "errors": [{ "path": "", "code": "INSUFFICIENT_SCOPE", "message": "The API token does not allow this route", "params": { "required": ["records:write"] } }],
  "request_id": "req_…"
}
```

- The scope is checked **before** the body is validated, so a token without the scope gets `403` even for an invalid body.
- On a route that names a resource the token cannot reach (another organization, a base outside its bases), you get `404` instead of `403`: the scope error never reveals that something exists outside the token's reach.
- One request can need more than its route's scope: an import with `mode = create_table` needs `records:write` **and** `schema:write` (`required: ["schema:write"]` when the second is missing).

---

## 5. Rate limits

| Limit | Value | Counted per |
| --- | --- | --- |
| Requests per token | **60 per second** | token (`tok_…`) |
| Requests per token and base | **20 per second** | token and base, for routes on a base or something in it (table, field, view, dashboard, widget, automation…), except `records/query`, `records/tree` and widget data (`POST /widgets/:id/data`) |
| Failed token authentications | **300 per minute** | client IP address |

- A request over a limit answers `429 RATE_LIMITED` with `Retry-After` (whole seconds, at least 1). Wait at least that long before the next request. A simple client sleeps for `Retry-After` and retries; a busy one also spreads its requests (for example a fixed pace below 20 requests/s per base).
- Each token has its own counters. Two tokens of the same person do not share a limit, and your browser session has its own counters too.
- **Failed authentications** (any `401` on the token path) are counted per client IP for one minute. After 300 failures, token requests from that IP get `429` until the minute ends, except for a token that authenticated successfully in the last 10 minutes (from any IP): integrations already running behind a shared IP (CI runners, NAT gateways) keep working while a broken job retries with a revoked token. A token that has not been used yet waits for the minute to end. Stop on `401`, never retry it.
- The client IP is taken after `TRUSTED_PROXIES` (self-hosters: list your reverse proxies, otherwise every client appears to come from the proxy and shares one failure counter).
- If Valkey is unavailable, limited requests answer `503 DEPENDENCY_UNAVAILABLE`. Retry later.
- Some routes have extra limits of their own, for example one running export per user (§10).

---

## 6. Retries and `Idempotency-Key`

Network errors and timeouts leave you unsure whether a write happened. Send an `Idempotency-Key` header (any unique string, for example a UUID) on write `POST` requests, and reuse the **same** key when you retry the same request:

```http
POST /api/v1/tables/tbl_…/records
Authorization: Bearer cht_…
Idempotency-Key: 8b0d6c4e-1f7a-4c8e-9d43-0a5e2b7f6c11
Content-Type: application/json
```

- A repeat with the same key and the same body returns the stored response (same status and body) with `Idempotent-Replayed: true`. Nothing is written twice.
- The same key with a different body, or while the first request is still running, answers `409 IDEMPOTENCY_KEY_REUSED`.
- Keys are kept for 24 hours, **per token**: two tokens (or a token and a session) never share a key.
- Read-like `POST`s (`records/query`, `records/group-counts`), uploads and a few others ignore the header (the full list is in C§1.1).
- `PATCH` and `DELETE` are not covered. Make them safe with `version` (optimistic check, `409 VERSION_CONFLICT`) where it matters.

**When to retry**: `429` and `503` (after `Retry-After`), network errors and `5xx` (with backoff and the same key). **Do not retry** `401`, `403`, `404`, `409 VERSION_CONFLICT` or `422`: the same request will fail again.

---

## 7. Examples

The examples read records of a table, create one record, then query with a filter. Replace the host, the table id and the field names with yours. Find ids with `GET /api/v1/orgs` → `GET /api/v1/orgs/:orgId/workspaces` → `GET /api/v1/workspaces/:workspaceId/bases` → `GET /api/v1/bases/:baseId/tables` (scope `schema:read`), or copy them from the app's URL (`/b/<baseId>/t/<tableId>`).

### 7.1 curl

```bash
export CELLHIVE_URL=https://cellhive.example.com
export CELLHIVE_TOKEN=cht_…   # from your secret store, never in the script

# Read the first 50 records (records:read)
curl -sS "$CELLHIVE_URL/api/v1/tables/tbl_8fK2mQ1xZp0aB7cD/records?limit=50" \
  -H "Authorization: Bearer $CELLHIVE_TOKEN"

# Create a record (records:write); safe to retry with the same key
curl -sS -X POST "$CELLHIVE_URL/api/v1/tables/tbl_8fK2mQ1xZp0aB7cD/records?typecast=true" \
  -H "Authorization: Bearer $CELLHIVE_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "records": [ { "fields": { "Title": "Printer offline", "Status": "New" } } ] }'

# Query with a filter (records:read)
curl -sS -X POST "$CELLHIVE_URL/api/v1/tables/tbl_8fK2mQ1xZp0aB7cD/records/query" \
  -H "Authorization: Bearer $CELLHIVE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "filter": { "logic": "and", "conditions": [["Status", "==", "New"]] }, "limit": 100 }'
```

Add `-i` to see `Retry-After`, `WWW-Authenticate` and `X-Request-Id`.

### 7.2 JavaScript (Node.js 18+, `fetch`)

```js
const BASE = process.env.CELLHIVE_URL; // https://cellhive.example.com
const TOKEN = process.env.CELLHIVE_TOKEN;

async function cellhive(method, path, body, { idempotencyKey, attempts = 5 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(`${BASE}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.ok) return response.status === 204 ? null : response.json();
    const retryable = response.status === 429 || response.status === 503 || response.status >= 500;
    if (retryable && attempt < attempts) {
      const seconds = Number(response.headers.get('retry-after')) || 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      continue;
    }
    const problem = await response.json().catch(() => ({}));
    throw new Error(
      `${method} ${path}: ${response.status} ${problem.code ?? ''} ${problem.detail ?? ''} ` +
        `(request ${response.headers.get('x-request-id')})`,
    );
  }
}

const table = 'tbl_8fK2mQ1xZp0aB7cD';
const { records } = await cellhive('GET', `/tables/${table}/records?limit=50`);
await cellhive(
  'POST',
  `/tables/${table}/records?typecast=true`,
  { records: [{ fields: { Title: 'Printer offline', Status: 'New' } }] },
  { idempotencyKey: crypto.randomUUID() }, // same key on every retry of this write
);
const open = await cellhive('POST', `/tables/${table}/records/query`, {
  filter: { logic: 'and', conditions: [['Status', '==', 'New']] },
  limit: 100,
});
console.log(records.length, open.records.length);
```

The helper never retries `401`/`403`/`404`/`409`/`422`, and it reuses the idempotency key on every attempt of a write.

### 7.3 Python (`requests`)

```python
import os, time, uuid
import requests

BASE = os.environ["CELLHIVE_URL"]
session = requests.Session()
session.headers["Authorization"] = f"Bearer {os.environ['CELLHIVE_TOKEN']}"

def cellhive(method, path, json=None, idempotency_key=None, attempts=5):
    headers = {"Idempotency-Key": idempotency_key} if idempotency_key else {}
    for attempt in range(1, attempts + 1):
        r = session.request(method, f"{BASE}/api/v1{path}", json=json, headers=headers, timeout=30)
        if r.ok:
            return None if r.status_code == 204 else r.json()
        if r.status_code in (429, 503) or r.status_code >= 500:
            if attempt < attempts:
                time.sleep(int(r.headers.get("Retry-After", 2 ** attempt)))
                continue
        problem = r.json() if r.headers.get("Content-Type", "").startswith("application/problem+json") else {}
        raise RuntimeError(f"{method} {path}: {r.status_code} {problem.get('code')} "
                           f"{problem.get('detail')} (request {r.headers.get('X-Request-Id')})")

table = "tbl_8fK2mQ1xZp0aB7cD"
page = cellhive("GET", f"/tables/{table}/records?limit=50")
cellhive("POST", f"/tables/{table}/records?typecast=true",
         json={"records": [{"fields": {"Title": "Printer offline", "Status": "New"}}]},
         idempotency_key=str(uuid.uuid4()))
new = cellhive("POST", f"/tables/{table}/records/query",
               json={"filter": {"logic": "and", "conditions": [["Status", "==", "New"]]}, "limit": 100})
print(len(page["records"]), len(new["records"]))
```

With only the standard library, use `urllib.request.Request(url, data=…, headers={"Authorization": "Bearer …", "Content-Type": "application/json"}, method="POST")`. `urllib` raises `HTTPError` for `4xx`/`5xx`; read `err.code`, `err.headers["Retry-After"]` and `err.read()` for the problem document.

---

## 8. Realtime (WebSocket) with a token

A server-side client can follow changes live: open `wss://<host>/ws` with the token in the `Authorization` header of the handshake. After the handshake the protocol is the same as the app's (C§7): `subscribe` to `table:<tbl_…>`, `base:<bse_…>` or `dashboard:<dsh_…>` (§11.5), receive `record.created`, `record.updated`, `record.deleted`, `schema.changed`, `permission.changed` and the other messages of C§7.

**Browsers cannot do this.** The browser WebSocket API cannot set an `Authorization` header. Browser apps use the session cookie (and the `Origin` check that comes with it). The token is never accepted in the URL or in a first message, so it does not end up in access logs.

### 8.1 Node.js (`ws`)

```js
import WebSocket from 'ws'; // npm install ws

function connect() {
  const socket = new WebSocket('wss://cellhive.example.com/ws', {
    headers: { Authorization: `Bearer ${process.env.CELLHIVE_TOKEN}` },
  });

  socket.on('open', () => {
    socket.send(JSON.stringify({ type: 'subscribe', channel: 'table:tbl_8fK2mQ1xZp0aB7cD', req_id: '1' }));
  });

  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === 'error') console.error('subscription error', message.code, message.channel);
    else if (message.type.startsWith('record.')) console.log(message.type, message.record_id ?? message.record_ids);
  });

  // The handshake was refused: 401 (bad token), 429 (limits) or 503.
  socket.on('unexpected-response', (_request, response) => {
    console.error('handshake refused', response.statusCode, response.headers['retry-after']);
    socket.terminate();
    // 429 and 503 say how long to wait in Retry-After (seconds).
    const wait = Number(response.headers['retry-after']) || 5;
    if (response.statusCode !== 401) setTimeout(connect, wait * 1000);
  });

  socket.on('close', (code) => {
    if (code === 4401) {
      console.error('token no longer valid: stop and alert a person');
      return; // do not reconnect with the same token
    }
    // 1001 (server restart) or a network drop: reconnect, then re-read what you display.
    setTimeout(connect, 2000 + Math.random() * 3000);
  });
}

connect();
```

### 8.2 What differs from a browser connection

| | With a token |
| --- | --- |
| Handshake | Authenticated like an HTTP request (same `401` codes and `WWW-Authenticate`, same per-IP failure limit). No `Origin` check, cookies ignored. At most **10** connections per token per API instance: one more is refused with `429 RATE_LIMITED` and `Retry-After: 30`; a slot frees up when one of your connections closes. |
| `table:` / `base:` / `dashboard:` | Needs `records:read`. A base outside the token's bases, another organization or something you cannot read → `error` `NOT_FOUND`. Readable but no `records:read` → `error` `INSUFFICIENT_SCOPE` (`params.required: ["records:read"]`). |
| `user:` | Always `error` `NOT_FOUND`, even your own: notifications and job progress belong to signed-in sessions. |
| Data | Filtered per message by your **current** permissions ∩ the token's bases, exactly like the app (hidden fields never appear, records outside your read rules never arrive). |
| Re-checks | The token is checked again every **60 s**, on every `permission.changed`, and immediately when it is revoked, the organization turns tokens off or you leave the organization (on every API instance). |
| Token no longer valid | The server closes the connection with code **`4401`**. Do **not** reconnect with the same token. |
| Database briefly unavailable during a re-check | The connection stays open; the check runs again later. |

Realtime is best effort: messages sent while a connection is down are lost. After every reconnect, re-read the data you keep (for example with `records/query`).

---

## 9. History and audit: "via an API token"

A change made with a token is made **by you**: the record history, the audit log and the events show you as the actor (`actor.type = user`), and `updated_by` is you. The entry also records the token: `via.api_token_id` (combined with other sources, for example `import_job_id` for an import started with a token, or `reverted_from` for a revert).

Who sees which token:

| Viewer | Sees |
| --- | --- |
| Organization owners and admins | "Via an API token" with the token's id and **current** name (`via.api_token_name`; `null` once the token was deleted) |
| The token's owner | The same, for their own tokens |
| Everyone else (including base admins, for other people's tokens) | "Via an API token" only: `api_token_id` and `api_token_name` are `null` |

So colleagues can tell that a change came from an integration without learning which integrations you run. Filtering the audit log by actor still finds every change made with your tokens, and the audit filter `via=api_token` lists every change made with any token. Organization owners and admins see every token's metadata (never its value) and can revoke any token in **API tokens → All tokens** (§12).

Creating and revoking a token are audited (`api_token.created`, `api_token.revoked`, `api_token.updated` for a rename).

---

## 10. Files, exports, imports and jobs

- **Upload a file** (`records:write`): `POST /api/v1/files/uploads` with `{ table_id, field_id, filename, size, mime }` → `PUT` the bytes to the returned `upload.url` with the returned headers (no `Authorization` header there: the URL is signed) → `POST /api/v1/files/uploads/:id/complete` → write `[{ "id": "att_…" }]` into the attachment cell with a record update (C§20).
- **Download a file** (`records:read`): `GET /api/v1/files/:id` answers `302` to a signed URL valid for 60 s. Follow the redirect **without** forwarding your `Authorization` header to the storage host (`curl -L` drops it on a host change; check your HTTP library). Your role must allow downloading that field, otherwise `403`.
- **Export** (`records:read`): `GET /api/v1/tables/:id/export?format=csv|xlsx&view_id=` streams the file directly (no job). Your role needs the download right of the base (`403` otherwise). One export runs at a time per **user**, tokens and sessions together (`429` with `Retry-After`). The export is audited with the token in `via`.
- **Import** (`records:write`; `schema:write` too for `mode = create_table`): `POST /api/v1/bases/:id/imports` returns `202 { "job_id" }`. Rows written by the import carry `via = { import_job_id, api_token_id }`.
- **Jobs** (`records:read`): `GET /api/v1/jobs/:id` with a token shows only jobs **you** started, in a base the token can reach. A job outside the token's bases, an audit export, or (for a token limited to bases) a job that belongs to no base answers `404`. Job progress over WebSocket (`user:` channel) is not available to tokens (§8): poll `GET /jobs/:id`.

---

## 11. Dashboards

A token reads dashboards and their numbers **as its owner**: the numbers of a widget are computed with your current table, field and record permissions (∩ the token's bases), exactly as you see them in the app. Tokens of two different people can get different numbers from the same widget. How dashboards, widgets and filters work is described in [dashboards.md](dashboards.md); the formats are in C§28.

### 11.1 Routes and scopes

| Route | Scope |
| --- | --- |
| `GET /api/v1/bases/:baseId/dashboards` (the dashboards you can see, by position) | `schema:read` |
| `GET /api/v1/bases/:baseId/dashboards/trash` (base admins) | `schema:read` |
| `GET /api/v1/dashboards/:id` (the dashboard and its `widgets[]`, in reading order) | `schema:read` |
| `POST /api/v1/widgets/:id/data` (the numbers of a widget) | `records:read` |
| `POST /api/v1/widgets/:id/options` (the values of a filter widget) | `records:read` |
| `POST /api/v1/widgets/:id/records` (the records behind a widget or one of its groups) | `records:read` |
| `GET /api/v1/widgets/:id/export?format=csv&filters=&timezone=` (a widget's numbers as CSV) | `records:read` |
| `POST /api/v1/bases/:baseId/dashboards`, `PATCH`/`DELETE /api/v1/dashboards/:id`, `POST /api/v1/dashboards/:id/restore`, `POST /api/v1/dashboards/:id/duplicate`, `PUT /api/v1/dashboards/:id/layout` | `schema:write` |
| `POST /api/v1/dashboards/:id/widgets`, `PATCH`/`DELETE /api/v1/widgets/:id`, `POST /api/v1/widgets/:id/duplicate` | `schema:write` |
| `GET`/`POST /api/v1/dashboards/:id/share-links`, and changing any share link (embedding included) | session only |

Who may do what is the same as in the app: reading needs a dashboard you can see (base owners and admins, the system roles Editor and Reader, or a custom role with **View** on that dashboard); every write needs a base owner or admin. A dashboard you cannot see answers `404` on every route, **before** the scope is checked; one you can see but not change answers `403 PERMISSION_DENIED` on writes.

### 11.2 Reading the numbers of a widget

```bash
export CELLHIVE_URL=https://cellhive.example.com
export CELLHIVE_TOKEN=cht_…   # records:read + schema:read

# The dashboards of a base, then one dashboard with its widgets (schema:read)
curl -sS "$CELLHIVE_URL/api/v1/bases/bse_3Lp9xQ2mVr7kTn4w/dashboards" \
  -H "Authorization: Bearer $CELLHIVE_TOKEN"
curl -sS "$CELLHIVE_URL/api/v1/dashboards/dsh_8Hq2nZ5tWc1xRb6p" \
  -H "Authorization: Bearer $CELLHIVE_TOKEN"

# The numbers of one widget (records:read); the body is optional
curl -sS -X POST "$CELLHIVE_URL/api/v1/widgets/wgt_5Rk7pD2sQm9vLc3y/data" \
  -H "Authorization: Bearer $CELLHIVE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "timezone": "Asia/Ho_Chi_Minh" }'
```

A bar chart "Orders by status" (one `count` metric) answers:

```json
{
  "status": "ok",
  "columns": [
    { "key": "dimension", "role": "dimension", "field_id": "fld_2Wt6yH1kPz8qMs4d", "field_type": "select",
      "aggregation": null, "date_bucket": null, "bucket_width": null },
    { "key": "m1", "role": "metric", "field_id": null, "field_type": null,
      "aggregation": "count", "date_bucket": null, "bucket_width": null }
  ],
  "rows": [
    [{ "value": "opt_new", "label": "New" }, 12],
    [{ "value": "opt_urgent", "label": "Urgent" }, 5],
    [{ "value": null, "label": null }, 1]
  ],
  "total": [18],
  "computed_at": "2026-10-26T08:15:02.114Z",
  "cache": "miss",
  "ignored_filters": []
}
```

- `rows` follow `columns`: group cells are `{ value, label }` (option id and name, user id and name, `YYYY-MM-DD` for the first day of a date bucket, the lower bound of a number range, a linked record id and title, `true`/`false`; a `null` value is the empty group), then one number per metric (`null` when there is nothing to aggregate). A KPI answers `rows: [[value]]` and, with a comparison, `compare = { previous, change, current_period, previous_period }`. A records table answers `[record_id, …cells]` as `records/query` with `field_key_type=id`.
- `other` (with "Other" on and more groups than the limit) holds the folded groups; `total` holds each metric over every matching record.
- **`status` is not an HTTP error**: `ok`, `empty` (nothing matches), `no_permission` (the widget uses a table or field you cannot read; no number at all is returned) or `broken` (a table or field it uses was deleted). All four answer `200`.
- `timezone` (IANA) sets the date buckets and the KPI periods; without it, the organization's time zone is used.
- `cache: "hit"` means the result came from the cache; `computed_at` is when it was computed. A cached result is never older than the last change to the tables it reads (C§28.5).

**With live filters.** A script can apply the dashboard's own filters, never a free filter: a global filter by its `id`, a filter widget by its widget id, or a cross-filter by the id of a grouped widget and one of its group values.

```bash
curl -sS -X POST "$CELLHIVE_URL/api/v1/widgets/wgt_5Rk7pD2sQm9vLc3y/data" \
  -H "Authorization: Bearer $CELLHIVE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "filters": [
        { "source": "global",  "id": "period", "value": { "relative": "this_month" } },
        { "source": "control", "widget_id": "wgt_9Fz3cB6nTq2wKe8r", "value": { "values": ["opt_north"] } },
        { "source": "cross",   "widget_id": "wgt_1Ym4vS7dLp5xJa2h", "value": "opt_urgent" } ] }'
```

Values: `{ "values": [...] }` for options (ids), people (user ids) and text; `{ "range": { "from", "to" } }` for numbers and dates (`YYYY-MM-DD`, both ends included, `null` = open); `{ "relative": "…" }` for dates (`today`, `last_7_days`, `this_month`…, C§28.4). A filter that does not apply to this widget is listed in `ignored_filters` with a reason (`other_table`, `not_bound`, `self`, `no_permission`, `broken`) and changes nothing. A filter on a field you cannot read is ignored this way rather than refused, so the numbers never reveal hidden values. An unknown global filter or widget answers `422` (`UNKNOWN_FILTER`, `UNKNOWN_WIDGET`), a value of the wrong shape `422 INVALID_FILTER_VALUE`.

**As CSV** (the aggregate table you see, never raw records; your role needs the base's **download** right):

```bash
curl -sS -G "$CELLHIVE_URL/api/v1/widgets/wgt_5Rk7pD2sQm9vLc3y/export" \
  -H "Authorization: Bearer $CELLHIVE_TOKEN" \
  --data-urlencode "format=csv" \
  --data-urlencode 'filters=[{"source":"global","id":"period","value":{"relative":"this_month"}}]' \
  --data-urlencode "timezone=Asia/Ho_Chi_Minh" \
  -o orders-by-status.csv
```

### 11.3 Errors and limits of widget queries

| Answer | Meaning | What to do |
| --- | --- | --- |
| `404 NOT_FOUND` | The dashboard or widget does not exist, is in the trash, is in a base outside the token's bases, or you cannot see the dashboard | Check the id, the token's bases and your role's dashboard access |
| `422 VALIDATION_FAILED` / `UNKNOWN_WIDGET` | `data` on a text or filter widget; `options` on a widget that is not an options, people or text filter | Read the widget's `type` first |
| `422 VALIDATION_FAILED` / `WIDGET_TOO_LARGE` | More than 1,000 groups | Change the widget (coarser bucket, filter) |
| `422 VALIDATION_FAILED` / `WIDGET_NOT_EXPORTABLE` | CSV of a text, filter or records-table widget | – |
| `403 PERMISSION_DENIED` | CSV without the download right, or of a `no_permission` widget | – |
| `429 RATE_LIMITED` | A CSV while another export of yours runs (tokens and sessions share one slot), or the token's request limits (§5) | Wait `Retry-After` |
| `504 QUERY_TIMEOUT` | The query ran more than 10 s, or waited more than 10 s for a slot | Wait `Retry-After` (5 s), then retry once |

- Widget queries run at most **4 at a time per person** (your tokens and sessions together) and 20 per API instance; others wait in line. Reading all 30 widgets of a dashboard with more parallel requests only makes them wait.
- `data`, `options` and `records` are reads: they ignore `Idempotency-Key`, and `data` counts only against the 60 requests/s of the token, not the 20 requests/s per base.
- The records behind a widget (`POST /widgets/:id/records { "segment": { "dimension": "opt_urgent" }, "limit": 200 }`) return only records and fields you can read: 50 by default, at most 200 per page, `offset` up to 100,000.

### 11.4 Changing dashboards

Writes need `schema:write` and a base owner or admin. Every change bumps the dashboard's `version` (widget and layout changes too). Send the version you read as `If-Match: "3"` (or `"version": 3` in the body) to avoid overwriting someone else's change: a mismatch answers `409 VERSION_CONFLICT` with the current version in `errors[0].params`. Without it, the last write wins.

```bash
# Add a bar chart: count of orders by status, only orders above 100 (schema:write)
curl -sS -X POST "$CELLHIVE_URL/api/v1/dashboards/dsh_8Hq2nZ5tWc1xRb6p/widgets" \
  -H "Authorization: Bearer $CELLHIVE_TOKEN" \
  -H "Content-Type: application/json" \
  -H 'If-Match: "3"' \
  -d '{ "type": "bar", "title": "Orders by status",
        "config": { "table_id": "tbl_8fK2mQ1xZp0aB7cD",
                    "dimension": { "field": "fld_2Wt6yH1kPz8qMs4d" },
                    "metrics": [{ "id": "m1", "aggregation": "count" }],
                    "filter": { "logic": "and", "conditions": [["fld_7Nc1rJ4vXa9eGu2b", ">", 100]] } } }'
```

The config is checked against the base when it is saved (fields of the right table and kind; `422` with the path of the faulty setting). A widget filter takes **field ids** in the tuple form (C§3). The saved filter of a widget is returned only to base admins; everyone else reads `"filter": null`, although it always applies.

### 11.5 Realtime: the `dashboard:` channel

Over the WebSocket (§8), `subscribe` to `dashboard:<dsh_…>` (needs `records:read` and a dashboard you can see; otherwise `error` `NOT_FOUND` or `INSUFFICIENT_SCOPE`). You receive:

- `dashboard.changed { dashboard_id, version }`: the dashboard, its layout or a widget changed. Read `GET /dashboards/:id` again.
- `dashboard.data_changed { dashboard_id, table_ids }`: records of these tables changed, gathered over 5 s per dashboard. It carries no value, number or record id: read the numbers of the widgets on those tables again with `POST /widgets/:id/data`.

If you lose access to the dashboard, the subscription ends with an `error` `NOT_FOUND`.

### 11.6 Share links and embedding

Creating and changing share links of dashboards (and of views and forms), embedding included, needs a signed-in session. The public routes a share link uses (`/api/v1/shares/<token>/…`) ignore the `Authorization` header: a script that reads a shared dashboard through its link is an anonymous visitor and sees the link creator's numbers ([dashboards.md](dashboards.md) §9, [embedding.md](embedding.md)).

---

## 12. Organization policy (owners and admins)

Organization owners and admins find the **All tokens** and **Policy** tabs on the API tokens page.

- **All tokens**: every member's tokens (name, prefix, scopes, bases, expiry, last use, owner), filterable by member and status. Revoking one stops it at once, including its open WebSocket connections. Admins cannot rename other people's tokens.
- **Policy** (`organizations.settings.api_tokens`, changed in the page or with `PATCH /api/v1/orgs/:orgId { "settings": { "api_tokens": { … } } }` from a session):
  - `enabled` (default `true`). `false` blocks creating tokens (`403 API_TOKENS_DISABLED`) and makes **every** token of the organization fail with `401 UNAUTHENTICATED` and close its WebSocket connections. Tokens are not revoked: turning the policy back on makes them work again.
  - `max_lifetime_days` (default `null` = no limit, 1–3,650). New tokens must then have an expiry within that many days (`422 VALIDATION_FAILED` / `TOKEN_LIFETIME_EXCEEDED`, `params.max_lifetime_days`), and "No expiration" is not offered. Existing tokens keep their expiry.

Recommended for most organizations: keep tokens on, set `max_lifetime_days` (for example 365), and review **All tokens** for unused tokens (`last_used_at`).

---

## 13. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `401 UNAUTHENTICATED` on every request | The header is not exactly `Authorization: Bearer cht_…` (one token, no quotes, no line break), the token was copied incompletely (it is 40 characters), it belongs to another Cellhive instance, the organization turned tokens off, or your account left the organization. |
| `401` although the browser works | A request with `Authorization` never uses the cookie. Remove the header to use the session, or fix the token. |
| `403 INSUFFICIENT_SCOPE` with `required: ["session"]` | The route cannot be used with a token (§2.1). Do it in the app. |
| `403 INSUFFICIENT_SCOPE` with a scope | Create a token with that scope. Remember that writing does not include reading. |
| `403 PERMISSION_DENIED` | Your role does not allow it. A token never has more access than you. |
| `404` for something you can see in the app | The token is limited to other bases, or belongs to another organization. Check the token's **Bases** in the token list. |
| `429` right away for a new token, behind a shared IP | Too many failed authentications from that IP in the last minute (300); tokens that worked in the last 10 minutes are not blocked. Find the job that uses a revoked or expired token and stop it; the block lifts when the minute ends. |
| `429` under load | You exceed 60 requests/s per token or 20 requests/s per base. Pace your requests and honour `Retry-After`. Use bulk endpoints (up to 1,000 records per write) instead of one request per record. |
| WebSocket closes with `4401` | The token was revoked, expired, the organization turned tokens off, or you left the organization. Do not reconnect with it. |
| WebSocket `subscribe` answers `NOT_FOUND` for `user:…` | Expected: token connections have no `user:` channel. |
| Duplicate records after a timeout | Send `Idempotency-Key` on writes and reuse it on retries (§6). |

---

## 14. Reference: limits

| Item | Value |
| --- | --- |
| Token format | `cht_` + 30 base62 + 6 base62 CRC32 = 40 characters; prefix shown: 8 characters |
| Token name | 1–100 characters |
| Tokens not revoked per member and organization | 50 |
| Bases per token | 1–50, or all bases |
| Expiry | default 90 days in the UI; at most 3,650 days; "never" only when the organization sets no `max_lifetime_days` |
| Revoked/expired tokens kept | 90 days, then deleted |
| `last_used_at` precision | updated at most once every 5 minutes |
| Rate limits | 60 requests/s per token; 20 requests/s per token and base |
| Failed token authentications | 300 per minute per client IP, then `429` for the rest of the minute |
| `Idempotency-Key` retention | 24 hours, per token |
| WebSocket connections | 10 per token per API instance (`429` with `Retry-After: 30`) |
| WebSocket token re-check | every 60 s, on `permission.changed`, on revocation |
| WebSocket close when the token ends | `4401` |
| Widget queries (`POST /widgets/:id/data`, `options`, `records`) | 4 at a time per person, 20 per API instance; 10 s each (`504 QUERY_TIMEOUT`, `Retry-After: 5`) |
| Groups of one widget query | 1,000 (`422 WIDGET_TOO_LARGE`) |
| Records behind a widget | 50 per page by default, at most 200; `offset` up to 100,000 |
| Live filters per widget request | 50 |
