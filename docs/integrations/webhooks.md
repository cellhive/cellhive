# Webhooks and outbound HTTP

This guide covers how Cellhive exchanges HTTP calls with other systems:

- **Incoming webhooks**: another system sends `POST` requests to a URL that Cellhive gives you, and an automation runs for each request.
- **Outbound HTTP**: an automation calls another system with the `http_request` action, or hands a record to an n8n workflow with the `run_n8n_workflow` action.
- **SSRF protection and the allowlist**: what outbound calls may reach, and how self-hosters open an internal service such as n8n.
- **Retention, capacity, the Telegram webhook mode and troubleshooting.**

Signatures in both directions follow [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks) v1, so the official `standardwebhooks` libraries can sign and verify them. The normative formats are in `docs/CONTRACTS.md` §10, §21, §24 and §25. The architecture is in ADR-22, ADR-27, ADR-35 and ADR-36 §4 (allowed hosts of secrets). To call the Cellhive API from another system, see [api.md](api.md). If this guide and those documents disagree, the contracts win. Please report the mismatch.

## Contents

1. [Incoming webhooks](#1-incoming-webhooks)
2. [Using the request in an automation](#2-using-the-request-in-an-automation)
3. [Outbound HTTP: `http_request`](#3-outbound-http-http_request)
4. [Receiving calls from Cellhive](#4-receiving-calls-from-cellhive)
5. [n8n](#5-n8n)
6. [Loops and the causation header](#6-loops-and-the-causation-header)
7. [SSRF protection and the HTTP allowlist (self-hosters)](#7-ssrf-protection-and-the-http-allowlist-self-hosters)
8. [Retention and capacity](#8-retention-and-capacity)
9. [Telegram webhook mode](#9-telegram-webhook-mode)
10. [Troubleshooting](#10-troubleshooting)
11. [Reference: limits](#11-reference-limits)

---

## 1. Incoming webhooks

### 1.1 Creating a hook

Only **base admins** manage incoming webhooks. Organization owners and admins are base admins of every base. Hooks are managed on the base's **Incoming webhooks** settings page. The same operations are available in the API (`docs/CONTRACTS.md` §25.1):

```http
GET    /api/v1/bases/:baseId/incoming-webhooks
POST   /api/v1/bases/:baseId/incoming-webhooks                  { "name", "auth", "rate_limit_per_sec"? }
PATCH  /api/v1/incoming-webhooks/:id                            { "name"?, "enabled"?, "rate_limit_per_sec"?, "auth"? }
DELETE /api/v1/incoming-webhooks/:id                            → 409 WEBHOOK_IN_USE while an automation uses it
POST   /api/v1/incoming-webhooks/:id/rotate-secret              → new signing secret (shown once)
POST   /api/v1/incoming-webhooks/:id/regenerate-token           → new URL; the old URL stops working at once
PUT    /api/v1/incoming-webhooks/:id/bearer                     → new Bearer token (shown once)
DELETE /api/v1/incoming-webhooks/:id/bearer
GET    /api/v1/incoming-webhooks/:id/requests?cursor=&limit=    → request log (metadata only)
```

Each hook has:

- **A URL**: `PUBLIC_URL/api/v1/hooks/<token>`, where the token is 43 base64url characters. Base admins can view the URL again later. Anyone who has the URL can reach the hook, so treat it as a credential. If it leaks, use **Get a new URL** (`regenerate-token`). The hook's rate limit is spent **before** the signature or Bearer token is checked, so someone who has only the URL can still make the real sender get `429`. That is another reason to regenerate a leaked URL right away.
- **An auth mode**, chosen explicitly when you create the hook:

  | `auth` | The sender must send |
  | --- | --- |
  | `signature` | Standard Webhooks headers signed with the hook's `whsec_…` secret |
  | `bearer` | `Authorization: Bearer <token>` |
  | `both` | Both of the above |
  | `none` | Nothing. Anyone with the URL can trigger the automation. |

  The signing secret and the Bearer token are shown **once**, in the response that creates them. No endpoint reads them back. To add a check later, call `rotate-secret` (adds the signature) or `PUT …/bearer` (adds the Bearer token). `PATCH { auth }` can only remove a check.

  **Prefer `signature` or `both`.** Replay protection works only on signed hooks (§1.5).

- **A rate limit**: `rate_limit_per_sec` defaults to 5 requests/s with a burst of 4×. A base admin can raise it up to the instance's `WEBHOOK_MAX_RATE_PER_SEC` (default 50; a higher value returns `422 VALIDATION_FAILED` with `errors[].code = RATE_LIMIT_TOO_HIGH` on `rate_limit_per_sec`). When the instance cap is below 5, the default is the cap.

A base can have up to 50 hooks. Disabling a hook, deleting it, or moving its base to the trash makes the URL return `404`.

### 1.2 Sending a request

```http
POST /api/v1/hooks/<token>?source=shop HTTP/1.1
Host: cellhive.example.com
Content-Type: application/json
webhook-id: msg_2Kq9a1
webhook-timestamp: 1760781600
webhook-signature: v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4=

{"order":{"id":"SO-1042","total":129.5,"customer":{"email":"lan@example.com"}}}
```

```http
HTTP/1.1 202 Accepted
Content-Type: application/json

{ "request_id": "whr_…" }
```

- Only `POST` is accepted.
- `Content-Type` must be one of the following:
  - `application/json` (no charset, or UTF-8). The body must be a JSON **object or array**.
  - `application/x-www-form-urlencoded`. The form becomes an object, and a repeated key becomes an array.
  - Any type with an empty body. The body is then `null`.
- The body can be at most **1 MiB**.
- The query string is kept: `?a=1&a=2` becomes `{ "a": ["1", "2"] }`.
- `202` means the request has been **stored**, and its `webhook.received` event was written in the same transaction. Automations run afterwards in the worker, never inside the request. A `202` therefore does not mean an automation succeeded. Check the automation's run history for that.
- A JSON array at the root is **one** request and starts **one** run. It is not one run per element.

### 1.3 Signing requests (Standard Webhooks)

The signature is `v1,` + base64(HMAC-SHA256(key, `"<webhook-id>.<webhook-timestamp>.<raw body>"`)), where `key` is the base64-decoded part of the secret after `whsec_`. The rules:

- `webhook-id` is unique per message. Reuse the **same** id when you retry the same message, so that Cellhive can drop the duplicate.
- `webhook-timestamp` is in Unix **seconds**. Cellhive rejects requests whose timestamp is more than **300 s** away from its clock, in either direction.
- Sign the **exact bytes** you send. Serializing the JSON again after signing (re-indenting, reordering keys) breaks the signature.
- Several signatures may be sent, separated by spaces. Only `v1,…` entries are checked, and one match is enough.
- After `rotate-secret`, the previous secret is still accepted for **24 h**. Rotating again within those 24 h drops the oldest secret.

**Node.js** ([`standardwebhooks`](https://www.npmjs.com/package/standardwebhooks) on npm):

```js
import { randomUUID } from 'node:crypto';
import { Webhook } from 'standardwebhooks';

const wh = new Webhook(process.env.CELLHIVE_HOOK_SECRET); // "whsec_…"; the prefix is handled

export async function sendOrder(order) {
  const body = JSON.stringify({ order });
  const id = `msg_${randomUUID()}`; // keep it when you retry this message
  const now = new Date();
  const res = await fetch(process.env.CELLHIVE_HOOK_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': String(Math.floor(now.getTime() / 1000)),
      'webhook-signature': wh.sign(id, now, body),
    },
    body,
  });
  if (res.status === 429 || res.status === 503) {
    // Retry the same id after the Retry-After header (seconds).
  }
  return res.status; // 202 on success
}
```

**Python** ([`standardwebhooks`](https://pypi.org/project/standardwebhooks/) on PyPI):

```python
import json
import os
import uuid
from datetime import datetime, timezone

import requests
from standardwebhooks.webhooks import Webhook

wh = Webhook(os.environ["CELLHIVE_HOOK_SECRET"])  # "whsec_…"


def send_order(order: dict) -> int:
    body = json.dumps({"order": order}, separators=(",", ":"))
    msg_id = f"msg_{uuid.uuid4().hex}"  # keep it when you retry this message
    now = datetime.now(tz=timezone.utc)
    res = requests.post(
        os.environ["CELLHIVE_HOOK_URL"],
        data=body.encode("utf-8"),
        headers={
            "content-type": "application/json",
            "webhook-id": msg_id,
            "webhook-timestamp": str(int(now.timestamp())),
            "webhook-signature": wh.sign(msg_id, now, body),
        },
        timeout=10,
    )
    return res.status_code  # 202 on success
```

**Go** (`github.com/standard-webhooks/standard-webhooks/libraries/go`):

```go
wh, err := standardwebhooks.NewWebhook(os.Getenv("CELLHIVE_HOOK_SECRET"))
if err != nil { return err }
body := []byte(`{"order":{"id":"SO-1042"}}`)
id, now := "msg_"+uuid.NewString(), time.Now()
sig, err := wh.Sign(id, now, body)
if err != nil { return err }
req, _ := http.NewRequest(http.MethodPost, os.Getenv("CELLHIVE_HOOK_URL"), bytes.NewReader(body))
req.Header.Set("Content-Type", "application/json")
req.Header.Set("webhook-id", id)
req.Header.Set("webhook-timestamp", strconv.FormatInt(now.Unix(), 10))
req.Header.Set("webhook-signature", sig)
```

**Bearer only** (for senders that cannot sign):

```sh
curl -X POST "$CELLHIVE_HOOK_URL" \
  -H "Authorization: Bearer $CELLHIVE_HOOK_BEARER" \
  -H "Content-Type: application/json" \
  -d '{"order":{"id":"SO-1042"}}'
```

### 1.4 Responses and error codes

Errors are `application/problem+json` (RFC 9457) with a `code` field. Checks run in this order, and each check is cheaper than the next one:

| Status | `code` | Cause | What the sender should do |
| --- | --- | --- | --- |
| `202` | — | Stored (or a duplicate, §1.5) | Done |
| `429` | `RATE_LIMITED` | More than 20 req/s from one client IP (checked before the token) | Retry after `Retry-After` seconds |
| `503` | `DEPENDENCY_UNAVAILABLE` | Valkey is unavailable (at either rate-limit step). Cellhive does not accept requests it cannot rate-limit. | Retry after `Retry-After: 1` |
| `404` | `NOT_FOUND` | The token is malformed or unknown, or the hook is disabled, deleted, regenerated, or its base is in the trash. The body is identical for all of these. | Fix the URL. Do not retry. |
| `429` | `RATE_LIMITED` | The hook's bucket, or the base cap of 50 req/s across all hooks of the base (checked after the token: an unknown token never gets this one) | Retry after `Retry-After` seconds |
| `413` | `PAYLOAD_TOO_LARGE` | The body is over 1 MiB. The connection is closed. | Send less |
| `415` | `UNSUPPORTED_MEDIA_TYPE` | Another `Content-Type`, or a charset other than UTF-8 | Fix the request |
| `400` | `MALFORMED_JSON` | Broken JSON, invalid UTF-8, a JSON value that is not an object or array (`"hello"`, `42`), objects or arrays nested more than 64 levels deep, or a NUL character or lone surrogate (PostgreSQL cannot store these) | Fix the request |
| `401` | `UNAUTHENTICATED` | The Bearer token or the signature is missing or wrong, or the timestamp is out of range. The body is the same for every reason. | Check the secret, the clock and the raw body (§10.1) |
| `503` | `DEPENDENCY_UNAVAILABLE` | The database failed while the request was checked or stored (at any step). Nothing was stored. | Retry after `Retry-After: 5` with the same `webhook-id` |

Retry `429`, `503` and network errors with backoff, using the **same** `webhook-id`. Do not retry `4xx` codes other than `429`.

### 1.5 Replays and duplicates

- On hooks that check the signature (`signature`, `both`), the `webhook-id` is the replay key. It is unique per hook for as long as the request row is kept (**7 days**). A repeated id gets `202` with the `request_id` of a "duplicate" log row. No new event is created and no automation runs.
- A `webhook-id` longer than 256 characters is stored as `sha256:<hex>`, so replay protection still applies.
- Hooks with `bearer` or `none` have **no** replay protection. Every request starts the automation again. Make those automations idempotent: look up the external id with `find_records` before you create a record.
- The `Idempotency-Key` header is ignored on this route.

### 1.6 Listening for a sample request

To build an automation against real data, choose the trigger **When a webhook request is received** in the automation builder, pick the hook and choose **Listen for a sample request**. The API is:

```http
POST   /api/v1/incoming-webhooks/:id/listen   → { "listen_until": "…" }   (180 s)
GET    /api/v1/incoming-webhooks/:id/sample   → { "sample": { body, headers, query, truncated, received_at } | null, "listen_until" }
DELETE /api/v1/incoming-webhooks/:id/listen
```

- The first **valid** request in the 180 s window (it passed auth and is not a replay) becomes the sample. Requests answered with `401` or another `4xx` never become the sample.
- The sample request **still runs the automation**, the same as any other request. There is no separate test URL. Point the sender at a test base, or keep the automation off while you listen.
- Bodies over 64 KB are kept as a truncated string (`truncated: true`). The builder then shows the raw text and does not suggest paths.
- Sensitive headers are never stored (§2.2).

### 1.7 Request log

`GET …/requests` returns metadata only: `{ id, received_at, size_bytes, duplicate, causation_accepted, event_id }`. It never returns the body, headers or query. The body is visible in the sample and to the automation run.

---

## 2. Using the request in an automation

### 2.1 The `webhook.received` trigger

```json
{ "trigger": { "type": "webhook.received", "incoming_webhook_id": "hok_…" } }
```

- Only base admins can create or edit these automations. The hook must belong to the same base (`UNKNOWN_WEBHOOK` otherwise).
- The trigger has no record, so `condition` must be `null` (`INVALID_CONDITION`). To filter requests, add an `if` step on the trigger data.
- The run's trigger input is `{ type: "webhook.received", event_id, event_created_at, incoming_webhook_id, request_id, table_id: null, record_id: null, bulk: false, batch: null }`.

### 2.2 Reading the body, headers and query

As a **value**:

```json
{ "trigger": "body", "path": "order.customer.email" }
{ "trigger": "query", "path": "source" }
{ "trigger": "headers", "path": "x-shop-domain" }
{ "trigger": "body", "path": "items[0].sku" }
```

Values keep their JSON type, so use them to write numbers into number fields. Omit `path` to get the whole part.

In a **template**:

```text
New order {{ [@body.order.id] }} from {{ [@query.source] }}
Raw: {{ [@body] }}
SKU: {{ [@body.items[0\].sku] }}        ← "]" inside a reference is written "\]"
```

Template references always produce **text**. Numbers and booleans are written as JSON, and objects and arrays as JSON text. Use `VALUE()` when you need a number in a formula.

Header names are lower-case. These headers are **never** stored and read as `null` (empty text in a template): `authorization`, `proxy-authorization`, `cookie`, `webhook-signature`, `x-cellhive-causation`, `x-telegram-bot-api-secret-token`. At most 50 headers are stored per request, and each value is cut at 8,192 characters. Any other header **is** stored for 7 days and shown to base admins in the sample, for example `x-api-key`, `x-hub-signature-256` or `stripe-signature`. If the sender authenticates with such a header, prefer `auth: bearer` or `signature` on the hook instead.

Keys that contain `.`, `[` or `]`, or empty keys, cannot be written as a path. Read the enclosing object instead.

The trigger data cannot be used as an email or notification **recipient** (`UNSUPPORTED_VALUE_SOURCE`). It can be used in the subject and body.

### 2.3 Run errors specific to webhooks

| Code | Meaning |
| --- | --- |
| `trigger_data_expired` (step) | The request row is gone: it was older than 7 days, typically when you re-run an old run. |
| `webhook_deleted` (run) | The hook was deleted before the run started, or while the run waited in a `delay`. |

### 2.4 Notifications from webhook writes

When a webhook run assigns people or changes followed records, notifications are grouped per (hook, table) over a **60 s** window. Each person gets one notification per window, for example "12 records changed via webhook", instead of one per request. Notifications from webhook writes can therefore arrive up to 60 s late.

---

## 3. Outbound HTTP: `http_request`

```json
{ "id": "act_http", "type": "http_request", "config": {
    "method": "POST",
    "url": { "template": "https://api.example.com/orders/{{ [fld_code] }}" },
    "query": [{ "name": "source", "value": { "literal": "cellhive" } }],
    "headers": [{ "name": "X-Order", "value": { "field": "fld_title" } }],
    "auth": { "header_name": "Authorization", "secret_id": "sec_…" },
    "body": { "type": "json", "value": { "template": "{\"title\": \"{{ [fld_title] }}\", \"amount\": {{ [fld_amount] }}}" } },
    "signing_secret_id": "sec_…",
    "fail_on_http_error": true } }
```

- **Method**: `GET`, `POST`, `PUT`, `PATCH` or `DELETE`. `GET` takes no body.
- **URL**: values inserted into a URL template are encoded like `encodeURIComponent`, so a record value cannot add a path, a query, or change the host. For a URL that comes entirely from a field, use a `{ "field" }` value instead of a template. Only `http` and `https` are allowed, with no user info and at most 2,048 characters after rendering.
- **Headers**: up to 20 headers and 20 query parameters. These names are reserved and rejected when you save (`HEADER_NOT_ALLOWED`): `webhook-id`, `webhook-timestamp`, `webhook-signature`, `idempotency-key`, `x-cellhive-causation`, `user-agent`, `host`, `content-length`, `connection`, `transfer-encoding`, `te`, `upgrade`, `expect`, `keep-alive`, `trailer`, `proxy-*`. Duplicate names are rejected too. Characters outside printable ASCII are sent `%XX`-encoded.
- **Auth**: the secret (kind `http_header`) holds the header **value**, for example `Bearer sk_live_…` or an API key. The header name is set in the action. Organization owners and admins manage secrets in the organization settings and choose which bases may use each one.

  > **Allowed hosts.** Every `http_header` and `webhook_signing` secret names the hosts it may be sent to (`allowed_hosts`, 1–20 entries, required when you create one). An entry is an exact host (`api.crm.example`) or `*.suffix` for its subdomains (`*.hooks.example` matches `eu.hooks.example`, never `hooks.example` itself nor `hooks.example.attacker.test`), with an optional `:port`. Without a port the entry covers 80 and 443 only. Hosts are compared after normalisation (lower case, punycode, no trailing dot). IP addresses and ranges are not accepted. A step whose literal URL names another host cannot be saved (`SECRET_HOST_NOT_ALLOWED`). A URL built from a field, a template or an earlier step is checked when the request is sent: another host fails the step with `secret_host_not_allowed` **before** the secret is decrypted and before any DNS lookup or connection, so a builder who points an `http_request` at their own server receives nothing. Allowed hosts do not open private addresses or other ports: the URL still has to pass the SSRF rules and the organization allowlist (§7). Set the list to the exact API host of each integration; use `*.` only for providers that spread over subdomains you trust. A "Send test" still shows the response of an allowed host to whoever sends it, so keep giving each secret only to the bases that need it.
  >
  > **Setting the hosts.** Organization owners and admins open the organization settings → **Integrations** → **HTTP secrets**, then add or change a secret and type each host under **Allowed hosts** (press Enter or a comma to add it, or paste several; the field shows how the entry will be stored). The card of each secret shows "Sent only to: …". Through the API: `POST /api/v1/orgs/:orgId/secrets` with `allowed_hosts` (C§24), and `PATCH /api/v1/secrets/:id { "allowed_hosts": [...] }`, which replaces the whole list (at least one entry). Invalid entries are refused with `INVALID_ALLOWLIST_PATTERN` (path `allowed_hosts[i]`), more than 20 with `TOO_MANY_ALLOWED_HOSTS`, an empty list with `SECRET_HOSTS_REQUIRED`. Base admins who are not organization admins pick secrets in the step editor but do not see their host lists yet: a step whose URL names another host shows the error at the secret when it is saved.
  >
  > **Secrets created before this check existed** have no list. They keep working with any host for **30 days** after the upgrade (`legacy_hosts_until` in the secrets list), then fail with `secret_host_not_allowed` (`reason: legacy_expired`). The Integrations page shows a banner and a "Set hosts before …" badge on each of them, and the step editor warns too. Set `allowed_hosts` (**Set hosts** on the page, or `PATCH /api/v1/secrets/:id`) before then; that ends the transition period.
- **Body**: `json` (template values are escaped as JSON string content, so write `"{{ [fld_title] }}"` with the quotes, and the result must parse), `form` (up to 50 fields), or `text`. At most 1 MiB after rendering (`http_request_too_large`).
- **Signing**: set `signing_secret_id` to a secret of kind `webhook_signing` to send Standard Webhooks signatures (§4.2). Create one with `{ "kind": "webhook_signing", "name": "…", "generate": true, "allowed_hosts": ["n8n.example.com"] }`. The value is shown once, so paste it into the receiver right away.
- **`fail_on_http_error`**: `true` (the default) fails the step on a final `3xx`, `4xx` or `5xx` (`http_status`). With `false`, a final HTTP status still ends the step as `succeeded` and you can branch on `status`. Network, SSRF and `rate_limited` errors always fail.
- **Output**: `{ delivery_id, status, headers: { content-type }, body, body_truncated }`. The body is parsed as JSON when the response `Content-Type` is `application/json` (or `application/*+json`), the body is at most 10 KB, and it parses. Otherwise it is text cut at 10 KB. Later steps read it with `{ "step": "act_http", "path": "body.id" }`.
- **Send test**: the builder's test button renders the request with **your** permissions and queues it like a real call. It is limited to 10 per minute per user, and the result is visible only to you for 24 h. It works for `run_n8n_workflow` steps too: the payload is built with your permissions from the sample record, with `automation.run_id = ""` and `event.id = null`. In an automation with the `webhook.received` trigger, the trigger data comes from the hook's **captured sample** (§1.6). If there is no sample, those values are empty and the answer carries `warnings: [{ "code": "no_sample" }]`. The test uses the **saved** trigger, so save the automation after changing its hook.

### 3.1 How calls are delivered

Calls never happen inside the automation step. The step writes an **outbox** row (`meta.http_deliveries`) and the run waits, like a `delay`. A worker job then makes the call without holding a database connection, records the result, and resumes the run. A worker crash between the call and the record therefore causes at most a repeat delivery with the **same** `webhook-id`.

**Retries**: up to **6 attempts**: immediately, then +10 s, +1 min, +5 min, +15 min and +30 min, each ±20 % jitter. The whole schedule spans roughly an hour.

| Result | Treatment |
| --- | --- |
| `2xx` | Success |
| Timeout (connect > 5 s or total > 10 s), network error, DNS that did not answer in 5 s or failed temporarily, `408`, `425`, `429`, `5xx` except `501` | Temporary: retried |
| `3xx` (redirects are **not** followed), `410` and any other `4xx`, `501`, response over 1 MiB, SSRF block | Permanent: the step fails at once |
| `429` / `503` with `Retry-After` ≤ 1 h | The next attempt waits at least that long, and **all** calls of the organization to that host pause until then |
| `Retry-After` > 1 h | The step fails with `rate_limited` |

When all attempts fail, the run ends `failed` with the last error and `params.attempts = 6`. The failed run is the dead-letter queue: fix the cause and use **Re-run**, which creates a new delivery.

**Pacing**: at most 10 calls/s (burst 20) per (organization, host), and at most 2 calls in flight per organization. A slow endpoint delays only that organization's calls. Each worker process also keeps one job slot free of HTTP calls: at most `WORKER_CONCURRENCY − 1` calls run at once in a process (at least 1), so other jobs never wait behind slow endpoints.

**Run history** shows, per HTTP step, the target host, attempts, last status or error, and the next attempt time. It never shows the full URL, request headers, request body or secrets. The response body is shown only to viewers who can read every value the step used. For `run_n8n_workflow` it is always hidden.

---

## 4. Receiving calls from Cellhive

### 4.1 Headers

| Header | Value |
| --- | --- |
| `webhook-id` | `hdl_…`, the id of the delivery. It is the **same on every retry** and different for every step, even when two steps share one trigger event. Use it to deduplicate. |
| `webhook-timestamp` | Unix seconds of this attempt |
| `webhook-signature` | `v1,<sig>` when the step has a signing secret. During the 24 h after the secret was changed it contains **two** signatures, new then old: `v1,<new> v1,<old>`. |
| `Idempotency-Key` | `<automation_id>:<event_id or run_id>:<action_id>`, stable per step of a run. A re-run uses the new run id. A test send ("Send a test") uses `test:<delivery id>`. |
| `X-Cellhive-Causation` | `v1.<opaque token>` (§6). Ignore it unless you call Cellhive back. It is absent on test sends. |
| `User-Agent` | `Cellhive/0.1` |
| `Content-Type` | Set from the body type, unless the action sets it |

### 4.2 Verifying the signature

**Node.js (Express)**: keep the raw body:

```js
import express from 'express';
import { Webhook } from 'standardwebhooks';

const wh = new Webhook(process.env.CELLHIVE_SIGNING_SECRET); // the webhook_signing secret
const seen = new Map(); // use a database or Valkey with a TTL of ≥ 24 h in production

const app = express();
app.post('/cellhive', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  let payload;
  try {
    payload = wh.verify(req.body, req.headers); // checks timestamp (±5 min) and any v1 signature
  } catch {
    return res.sendStatus(401);
  }
  const id = req.headers['webhook-id'];
  if (seen.has(id)) return res.sendStatus(200); // a retry of something already processed
  seen.set(id, Date.now());
  queueWork(payload); // answer within seconds; Cellhive gives up after 10 s
  res.sendStatus(202);
});
```

**Python (Flask)**:

```python
import os

from flask import Flask, request
from standardwebhooks.webhooks import Webhook, WebhookVerificationError

wh = Webhook(os.environ["CELLHIVE_SIGNING_SECRET"])
app = Flask(__name__)


@app.post("/cellhive")
def cellhive():
    try:
        payload = wh.verify(request.get_data(), dict(request.headers))
    except WebhookVerificationError:
        return "", 401
    if already_processed(request.headers["webhook-id"]):
        return "", 200
    queue_work(payload)
    return "", 202
```

The libraries' `verify()` also parses the body as JSON. For `form` or `text` bodies, or a `GET` (which is signed over an empty body), compute the HMAC yourself as in §1.3 and compare it in constant time.

### 4.3 Recommendations for receivers

- **Answer fast.** The total timeout is 10 s. Return `2xx` once the message is stored, and do the work asynchronously.
- **Deduplicate by `webhook-id`** for at least 24 h. A retry after a timeout, or after a worker crash, sends the same id.
- **Return `410 Gone`** to stop calls to an endpoint you removed. `410` is permanent, so the step fails at once and is not retried. It does **not** turn the automation off.
- **Use `429`/`503` with `Retry-After`** (at most one hour) to slow Cellhive down. Every delivery from that organization to your host waits.
- **Do not redirect.** A `3xx` is treated as a failure. Configure the final URL, for example the `https://` one.
- The response body (≤ 10 KB kept) becomes the step output. Return JSON with `Content-Type: application/json` when later steps need a value from it.

---

## 5. n8n

`run_n8n_workflow` is a preset of `http_request`. It sends a signed `POST` with a standard JSON payload to an n8n **Webhook** trigger.

```json
{ "id": "act_n8n", "type": "run_n8n_workflow", "config": {
    "url": { "literal": "https://n8n.example.com/webhook/cellhive-orders" },
    "signing_secret_id": "sec_…",
    "fields": null,
    "include_changes": true } }
```

- `signing_secret_id` is **required** (kind `webhook_signing`), and its `allowed_hosts` must include the n8n host (§3).
- `fields`: `null` sends every field the automation's `run_as` user can read. You can instead list up to 100 field ids. Field lists are not allowed with triggers that have no record (`schedule`, `webhook.received`).
- `include_changes`: adds the before and after values for `record.updated`.
- Retries, pacing, headers and the SSRF rules are the same as for `http_request`.

Payload:

```json
{
  "event": { "id": "evt_…", "type": "record.updated", "entity_id": "rec_…", "created_at": "2026-10-18T03:00:00.000Z" },
  "automation": { "id": "aut_…", "name": "Send orders to n8n", "run_id": "run_…" },
  "base": { "id": "bse_…", "name": "Sales" },
  "table": { "id": "tbl_…", "name": "Orders" },
  "record": {
    "id": "rec_…",
    "fields": { "title": "Order 1", "status": "Done", "customer": "" },
    "fields_by_id": { "fld_title": "Order 1", "fld_status": "Done",
                      "fld_customer": [{ "id": "rec_…", "title": null }] }
  },
  "changes": { "status": { "from": "New", "to": "Done" } }
}
```

The payload is built **when the step runs**, with the permissions `run_as` has at that moment. Fields it cannot read are left out, and linked records it cannot read have `title: null`. `table` is `null` for `schedule` and `webhook.received`. `record` is `null` when there is no record or `run_as` cannot read it, which includes `record.deleted`. `event.entity_id` is the trigger record's id whenever `run_as` can read that record, including a record just moved to the trash by `record.deleted`, so a workflow knows which record was deleted. `changes` is `null` unless `include_changes` is on and the trigger is `record.updated`. Use `fields_by_id` in workflows, because field names can be renamed.

### 5.1 Verifying the signature in n8n

1. In the **Webhook** node: HTTP Method `POST`. Under **Options**, turn on **Raw Body**, so that the exact bytes are available as binary property `data`. Use **Respond: Immediately**, or answer with **Respond to Webhook** within 10 s.
2. Make the secret available to the Code node, for example as `CELLHIVE_SIGNING_SECRET` in the n8n container environment. Recent n8n versions block `$env` in nodes unless `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` is set. The Code node also needs `NODE_FUNCTION_ALLOW_BUILTIN=crypto`.
3. Add a **Code** node ("Run Once for All Items") right after the Webhook node:

```js
const crypto = require('crypto');

const item = $input.first();
const h = item.json.headers;
const id = h['webhook-id'];
const ts = h['webhook-timestamp'];
const sigHeader = h['webhook-signature'] || '';
const raw = await this.helpers.getBinaryDataBuffer(0, 'data'); // exact bytes (Raw Body on)

if (!id || !ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) {
  throw new Error('Cellhive webhook: missing headers or stale timestamp');
}
const key = Buffer.from($env.CELLHIVE_SIGNING_SECRET.replace(/^whsec_/, ''), 'base64');
const expected = crypto
  .createHmac('sha256', key)
  .update(`${id}.${ts}.`)
  .update(raw)
  .digest('base64');
const ok = sigHeader.split(' ').some((entry) => {
  if (!entry.startsWith('v1,')) return false;
  const a = Buffer.from(entry.slice(3));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
});
if (!ok) throw new Error('Cellhive webhook: bad signature');

return [{ json: { ...JSON.parse(raw.toString('utf8')), _webhook_id: id, _causation: h['x-cellhive-causation'] ?? null } }];
```

A thrown error stops the execution. When the Webhook node is set to respond immediately, Cellhive has already received `200`, so check **Executions** in n8n for rejected calls. To return `401` to Cellhive instead, use **Respond: Using 'Respond to Webhook' node** and branch to two Respond nodes.

If you change the secret in Cellhive (organization settings, secrets), calls carry both the new and the old signature for 24 h. Update the n8n environment within that window.

### 5.2 Calling Cellhive back from n8n

Create an incoming webhook in Cellhive with `auth: bearer` (signing from n8n is possible but needs a Code node). Then add an **HTTP Request** node:

- Method `POST`, URL: the hook URL.
- Authentication: **Generic Credential Type → Header Auth**, name `Authorization`, value `Bearer <token>`.
- Send Headers:
  - `X-Cellhive-Causation` = `{{ $('Webhook').item.json.headers['x-cellhive-causation'] }}`
- Send Body: JSON.

Forward the causation header as shown: Cellhive then continues the automation chain, so a loop through n8n stops at the depth limit (§6). If the workflow was not started by Cellhive the expression is empty: Cellhive accepts the request as a new chain (depth 0) and counts it in `automation_causation_rejected_total{reason="malformed"}` — harmless, but expected on that metric.

To call Cellhive on the internal Docker network, see §7.3.

---

## 6. Loops and the causation header

Every outbound call (except test sends) carries `X-Cellhive-Causation: v1.<token>`. The token is encrypted with a key derived from `APP_MASTER_KEY`, so receivers learn nothing from it. It holds the automation chain (`root_event_id`, `depth`, `automation_chain`), expires after **1 h**, and is **bound to the instance that sent it**: the host of `PUBLIC_URL` plus the hook path prefix `/api/v1/hooks`, not the URL it was sent to.

When the token arrives with a request to `POST /api/v1/hooks/:token` of the same instance — sent there directly, or forwarded by n8n or any other system — Cellhive checks the binding against the host of `PUBLIC_URL`, or the `Host` header as forwarded by a trusted proxy (`TRUSTED_PROXIES`), and checks that the request path is under `/api/v1/hooks`. Any hook of the instance accepts it. If the token is valid, the `webhook.received` event continues the chain at `depth + 1`. The loop guard then stops automation A → `http_request` → hook B → B updates a record → A once `depth` reaches the organization's `automation_max_depth` (default 3, at most 5), or when A is already in the chain. This works when calling via `PUBLIC_URL` and when calling via an internal name such as `http://api:3000/api/v1/hooks/…`. An invalid token is ignored, never refused: the request counts as external (depth 0), `automation_causation_rejected_total{reason}` increments, and the request log shows `causation_accepted: false`.

**Through n8n or any other intermediary.** Forward the header unchanged when the workflow calls a Cellhive hook (§5.2): the chain continues and the loop A → n8n → hook B → A stops at the depth limit. A receiver that replays a token it got can only make a chain deeper, never reset it, and a token from another instance, a forged or a broken token, or one older than 1 h counts as no token (depth 0). If the intermediary drops the header, the request starts a new chain at depth 0. What remains in place then:

- the hook's rate limit (5 req/s by default) caps the loop's speed;
- each hook counts as at most one activation unit per second, so a fast but valid integration never trips the circuit breaker. The breaker still disables an automation after 50 consecutive failed activation units.

Nothing else stops such a loop in this version. At the default 5 req/s (burst 20) it can run about 430,000 times a day. Each pass stores a request row and creates an event, a run and, for each `http_request` step, a delivery, until someone disables the automation or the hook. Watch the request log of round-trip hooks after you set them up.

Design round-trips that may drop the header so that they cannot loop:

- Have the record-triggered automation watch only the fields that people edit (`watch_fields`), and have the webhook automation write other fields.
- Add an `if` step or a trigger condition that skips records the webhook has already processed, for example a "Synced at" field or a status.
- Keep the hook's rate limit low for round-trip integrations.

---

## 7. SSRF protection and the HTTP allowlist (self-hosters)

Cellhive usually runs inside your network. Every outbound call to a user-configured URL (`http_request`, `run_n8n_workflow`, test sends) goes through one guarded client:

- Only `http`/`https`, no user info, no IPv6 zone ids, at most 2,048 characters. IDN hosts are converted to punycode, and odd IPv4 spellings (`0x7f.1`, `2130706433`) are normalized before they are checked.
- **Ports 80 and 443 only**, unless an allowlist entry names the port (`port_not_allowed`).
- The host is resolved **once** (A and AAAA), and **every** address must be allowed. One private address in the answer blocks the whole host. The connection goes to the address that was checked (the IP is pinned), so DNS rebinding cannot switch it. TLS is verified against the original host name.
- **Private** addresses are blocked unless an allowlist entry opens them (`private_address`): loopback, RFC 1918, link-local, CGNAT (`100.64.0.0/10`), IPv6 ULA, link-local and the deprecated site-local `fec0::/10`, Teredo `2001::/32`, the documentation (including `3fff::/20`) and benchmarking (`198.18.0.0/15`) ranges, `192.0.0.0/24` and `100::/64`. IP literals and IPv6 forms that embed IPv4 (mapped, IPv4-translated, NAT64 `64:ff9b::/96` and `64:ff9b:1::/48`, 6to4) are checked by their IPv4 address.
- **Never reachable**, allowlist or not (`blocked_address`): `0.0.0.0/8`, `::`, multicast, `240.0.0.0/4` and broadcast, and the cloud metadata endpoints `169.254.169.254`, `169.254.170.2`, `100.100.100.200` and `fd00:ec2::254`.
- No redirects, no `HTTP(S)_PROXY`, a 10 s timeout, and responses capped at 1 MiB, including after decompression.
- Logs and errors contain only the host. They never contain the full URL, the resolved address, headers or bodies. Blocks are counted in `http_ssrf_blocked_total{reason}`.

### 7.1 The organization allowlist

Organization owners and admins manage the allowlist in the organization settings, or through the API:

```http
GET    /api/v1/orgs/:orgId/http-allowlist     → { "items": [...], "private_addresses": "org" | "off" }
POST   /api/v1/orgs/:orgId/http-allowlist     { "pattern": "n8n:5678", "note": "internal n8n" }
DELETE /api/v1/http-allowlist/:entryId
```

- A **pattern** is a host name, never an IP address or CIDR range. It can be an exact host (`n8n`, `n8n.internal`, `localhost`) or `*.suffix` with at least two labels (`*.corp.example` matches `a.corp.example` but not `corp.example` itself). An optional `:port` can follow. An organization can have up to 100 entries.
- An entry **without a port** allows ports 80/443 of that host. An entry **with a port** allows exactly that port.
- A matching entry also allows the host's **private** addresses, unless the instance sets `HTTP_PRIVATE_ALLOWLIST=off`.
- **Loopback** is opened only by an exact host **with** the matching port, never by a wildcard.
- A URL that contains an IP literal never matches an entry.
- Removing an entry does not interrupt calls already in flight. The next attempt is checked again.

### 7.2 `HTTP_PRIVATE_ALLOWLIST`

| Value | Effect | Use when |
| --- | --- | --- |
| `org` (default) | An organization's allowlist entries can open private addresses of the named hosts | One organization, or several organizations whose admins you trust with your internal network |
| `off` | Entries only allow a non-standard port on hosts that resolve to **public** addresses. No private, loopback or CGNAT address is ever reachable from automations. | **Organizations sharing the instance do not trust each other** (a hosting provider, a shared company instance with external tenants) |

With `org`, any organization admin can open any internal host name that the **worker** container can resolve, for example `postgres:5432`, `valkey:6379` or an internal admin panel, and point automations at it. Only plain HTTP requests can be sent, but some internal services accept them. Choose `off` unless you trust every organization admin on the instance. With `off`, reach an internal n8n through a public HTTPS address instead.

With `ALLOW_ORG_CREATION=true` any signed-in user can create an organization and become its admin. Combined with `org`, that lets any user open your internal network this way and read up to 10 KB of each response through "Send test". **Set `HTTP_PRIVATE_ALLOWLIST=off` whenever `ALLOW_ORG_CREATION=true`.**

The setting is read at start-up (`.env`, then restart `api` and `worker`).

### 7.3 Example: n8n next to Cellhive in Docker Compose

Outbound calls are made by the **`worker`** service, so n8n must be resolvable and reachable from the worker container. Typically you attach n8n to the same Compose network.

1. Run n8n as a service on the Cellhive Compose network, for example service name `n8n` on port `5678`.
2. Keep `HTTP_PRIVATE_ALLOWLIST=org`.
3. Add the allowlist entry `n8n:5678`, with a note such as "internal n8n".
4. Use `http://n8n:5678/webhook/cellhive-orders` as the URL of `run_n8n_workflow`.

For n8n to call Cellhive back internally, use `http://api:3000/api/v1/hooks/<token>` (the Compose `api` service), or simply the public URL. Both continue the causation chain, for direct calls and for a forwarded header (§6).

If an automation calls the **same** instance through `PUBLIC_URL` and that name resolves to a private address (split DNS, LAN install), add the `PUBLIC_URL` host to the allowlist, with its port if it is not 80/443.

### 7.4 Other self-hosting notes

- **`TRUSTED_PROXIES`** must list your reverse proxies. The default covers loopback and Docker's `172.16.0.0/12`. If a proxy in front of the Compose `web` service is missing from the list, every webhook appears to come from that proxy's IP and all senders share one 20 req/s limit.
- **`PUBLIC_URL`** determines the hook URLs that base admins copy. If you change it, existing integrations must be updated (the token stays the same, but the host changes).
- **`WORKER_CONCURRENCY`** (default 5) bounds outbound HTTP too: a worker process runs at most `WORKER_CONCURRENCY − 1` calls at once (at least 1), and each call may hold its slot for up to 10 s. If your automations call slow endpoints (n8n workflows that take seconds to answer, overloaded APIs), raise `WORKER_CONCURRENCY` (for example to 10–20, with `DATABASE_POOL_MAX` at least the same) or run a second worker container, so deliveries do not queue behind each other. With `WORKER_CONCURRENCY=1` the single slot is shared with every other job.
- **Valkey** is required for incoming webhooks: without it `/hooks/*` answers `503`. Outbound calls wait and do not count as attempts while Valkey is down.
- **Metrics**: the API's `/metrics` exposes `webhook_requests_total{result}`, `webhook_request_duration_seconds`, `automation_causation_rejected_total{reason}` and `http_delivery_oldest_pending_seconds`. Alert when the last one is above 600 s. Delivery counters and SSRF blocks inside the worker (`http_deliveries_total`, `http_ssrf_blocked_total` from jobs) are not exposed yet, because the worker has no `/metrics` endpoint.

---

## 8. Retention and capacity

| Data | Kept |
| --- | --- |
| Incoming request rows (body, headers, query, and the replay key) | **7 days**, then removed by the `maintenance.cleanup` cron. Re-running a run older than that fails with `trigger_data_expired`, and a `webhook-id` older than that is accepted again. |
| Hook sample | Until the next listen, or until the hook is deleted |
| Outbound delivery rows | Same as the run (`AUTOMATION_RUN_RETENTION_DAYS`, default 90). The encrypted request (URL, headers, body) is **deleted** as soon as the delivery succeeds, fails or is cancelled. Only the status, error code and ≤ 10 KB of the response remain. |
| Test deliveries | 24 h |

The 7-day window is fixed (it is not an env setting). Incoming bodies often contain personal data from other systems, so mention them in your privacy records.

**Disk for incoming requests.** Estimate rate × average stored size × 7 days. At about 2 KB per request (body plus kept headers):

| Sustained rate | Request rows on disk (7 days) |
| --- | --- |
| 1 req/s | ≈ 1.2 GB |
| 10 req/s | ≈ 12 GB |
| 50 req/s (one base at its cap) | ≈ 60 GB |

Add PostgreSQL indexes and the `meta.events` and job rows, which are small because events carry only ids. Large bodies scale linearly: 1 req/s of 50 KB bodies is about 30 GB per week. Use the hook's rate limit to bound a noisy sender.

There is no byte budget yet. The worst case is a sender at a base's cap (50 req/s) with bodies near 1 MiB that do not compress. Measured, such a body takes about 1.04 MiB on disk, so that is about 4.3 TiB per day per base, kept 7 days. Only authenticated requests are stored, so use `auth: signature`, `bearer` or `both` for every hook that faces the internet, and keep each hook's rate limit near what the sender really needs. Watch the size of `meta.incoming_webhook_requests`.

---

## 9. Telegram webhook mode

By default the Telegram notification bot **polls** Telegram. Polling needs no inbound connection. In this mode `/stop` is processed within 15 minutes. An organization owner or admin can switch the bot to **webhook mode** in the organization's notification channel settings, so that updates such as `/start` and `/stop` arrive immediately:

```http
PATCH /api/v1/orgs/:orgId/notification-channels   { "telegram_delivery_mode": "webhook" | "polling" }
```

- Requires `PUBLIC_URL` with **`https`** on port **443, 80, 88 or 8443** (the ports Telegram accepts). `GET …/notification-channels` returns `telegram.webhook_available` (a property of the instance), so the settings page disables the option up front when it cannot work. Otherwise the call returns `422 VALIDATION_FAILED` with `errors[].code = PUBLIC_URL_NOT_HTTPS` (path `telegram_delivery_mode`). Without a notification bot the code is `TELEGRAM_NOT_CONFIGURED`.
- Cellhive never overwrites an existing webhook. If the bot already has a webhook pointing elsewhere (another tool uses the same bot), the call returns `422 VALIDATION_FAILED` with `errors[].code = TELEGRAM_WEBHOOK_CONFLICT`. Remove that webhook in the other tool, or use a different bot.
- If Telegram cannot be reached, the call returns `503 DEPENDENCY_UNAVAILABLE`.
- Telegram calls `POST PUBLIC_URL/api/v1/telegram/webhook/<path token>` with a secret header. Your reverse proxy and firewall must let Telegram reach that path.
- An hourly check re-registers the webhook if `PUBLIC_URL` changed, and shows `webhook_status: error` when Telegram reports delivery errors.
- Switching back to polling, or changing or removing the bot, deletes the webhook.

All bot replies go through the bot's send limits (25 messages/s per bot, 1 per second per chat). An "invalid link" reply is sent at most 3 times per chat per hour.

---

## 10. Troubleshooting

### 10.1 Incoming webhooks

| Symptom | Likely cause and fix |
| --- | --- |
| `404` | Wrong or old URL (after **Get a new URL**), hook disabled or deleted, or base in the trash. Copy the URL again from the hook settings. |
| `401` on a signed hook | The sender's clock is more than 300 s off (sync NTP). The body was re-serialized after signing (sign and send the same bytes). The wrong secret is used, or the secret was rotated more than 24 h ago. `webhook-timestamp` is in milliseconds instead of seconds. A header was sent twice. |
| `401` with `auth: both` | Both the Bearer token **and** the signature are required. |
| `401` on a Bearer hook | Missing `Bearer ` prefix, or the token was replaced (`PUT …/bearer` has no grace period). |
| `415` | Wrong `Content-Type` (e.g. `text/plain`) or a non-UTF-8 charset |
| `400 MALFORMED_JSON` | Invalid JSON or UTF-8, a `\u0000` in a string, or a JSON scalar such as `"hello"` or `42` (wrap it in an object) |
| `413` | Body over 1 MiB. Send a reference (an id or URL) instead of the content. |
| `429` | Too fast for the hook's limit, the base's 50 req/s cap, or 20 req/s per client IP (check `TRUSTED_PROXIES` if every sender seems to share one IP). Honour `Retry-After`, or raise `rate_limit_per_sec`. |
| `503` | Valkey is down. The sender should retry. Check the `valkey` container. |
| `202` but nothing happened | The automation is off, uses another hook, failed (see run history), or the request was a replay (request log `duplicate: true`). The breaker may also have turned the automation off after 50 failed activations. |
| Values are empty in the run | Wrong `path` (paths are case-sensitive, e.g. `items[0].sku`), the value is under a sensitive header, or the request sent `form` data where you expected JSON. Listen for a sample to see the real shape. |
| `trigger_data_expired` | The run was re-run more than 7 days after the request |
| Sample never arrives | The request failed auth (`401` never becomes a sample), the 180 s window ended, or the sender did not send during it |

### 10.2 Outbound calls

| Step error | Meaning and fix |
| --- | --- |
| `ssrf_blocked` `private_address` | The host resolves to a private address. Add an allowlist entry for the host, or use its public address. With `HTTP_PRIVATE_ALLOWLIST=off` this cannot be opened. |
| `ssrf_blocked` `port_not_allowed` | The port is not 80/443. Add `host:port` to the allowlist. |
| `ssrf_blocked` `blocked_address` | Metadata, `0.0.0.0` or a reserved range. Never allowed. |
| `ssrf_blocked` `unresolvable` | DNS failed or timed out (5 s) **from the worker container**. Check that the worker can resolve the name (Docker network, internal DNS). A timeout or a temporary resolver failure (`params.cause`) is retried; a name that does not exist fails at once. A worker runs at most 2 DNS lookups for outbound calls at once, so a name server that never answers delays other lookups but cannot block the worker. |
| `ssrf_blocked` `invalid_url` | Not `http`/`https`, contains `user:pass@`, over 2,048 characters, or a rendered URL that does not parse. |
| `http_status` `3xx` | Redirects are not followed. Use the final URL. |
| `http_status` `4xx` | The receiver refused the request (`401`/`403`: check the auth secret; `410`: endpoint removed). |
| `http_timeout` / `http_network` | The receiver was slow (> 10 s) or unreachable on all 6 attempts |
| `rate_limited` | The receiver asked to wait more than 1 h |
| `http_response_too_large` | The response was over 1 MiB, including after decompression |
| `http_request_too_large` | The rendered body (or the n8n payload) was over 1 MiB. Limit `fields`. |
| `secret_unavailable` | The auth or signing secret was deleted, or its base scope no longer includes this base. Fix it in the organization's secrets settings, then re-run. |
| `secret_host_not_allowed` `not_listed` | The host of the URL (as sent, after rendering) is not in the secret's `allowed_hosts`. Add the host to the secret in the organization's secrets settings if it is the real receiver, then re-run. Nothing was sent. |
| `secret_host_not_allowed` `legacy_expired` | The secret was created before allowed hosts existed and its 30-day transition period is over. Set its `allowed_hosts`, then re-run. |
| The receiver says the signature is invalid | It verifies a re-parsed body instead of the raw bytes, uses the wrong secret, or checks only the first of two signatures during a rotation. |
| The receiver gets duplicates | Expected after timeouts: deduplicate by `webhook-id` |
| A loop through n8n | Forward `X-Cellhive-Causation` from the n8n Webhook node to the HTTP Request node (§5.2, §6). Without it, use `watch_fields` and conditions. |
| A step waits for a long time | Retries are scheduled, or the host is paused by a `Retry-After`. Run history shows the next attempt. |

---

## 11. Reference: limits

| Item | Value |
| --- | --- |
| Hooks per base | 50 |
| Hook rate limit | default 5 req/s, burst 4×, max `WEBHOOK_MAX_RATE_PER_SEC` (env, default 50, 1–1000) |
| Base cap (all hooks) | 50 req/s, burst 50 |
| Per client IP on `/hooks/*` | 20 req/s |
| Incoming body | ≤ 1 MiB; JSON object/array (≤ 64 levels deep) or form |
| Stored headers | 50 per request; values ≤ 8,192 characters |
| Signature timestamp tolerance | ±300 s |
| Previous signing secret accepted | 24 h after rotation (one previous secret) |
| `webhook-id` stored as is | ≤ 256 characters (longer → `sha256:<hex>`) |
| Sample window / sample body | 180 s / 64 KB |
| Incoming request retention | 7 days |
| Outbound URL | ≤ 2,048 characters; ports 80/443 unless allowlisted |
| Allowed hosts of an HTTP secret | 1–20 entries; legacy secrets: 30 days after the upgrade |
| DNS / connect / total timeout | 5 s / 5 s / 10 s |
| System DNS lookups in progress per worker process | 2 (a queued lookup gives up after 5 s and is retried later) |
| Outbound request body / response | ≤ 1 MiB / ≤ 1 MiB (10 KB kept) |
| Attempts | 6 (0, +10 s, +1 min, +5 min, +15 min, +30 min; ±20 %) |
| `Retry-After` honoured | ≤ 1 h |
| Per (organization, host) | 10 calls/s, burst 20; 2 in flight per organization |
| Calls in flight per worker process | `WORKER_CONCURRENCY − 1` (at least 1) |
| `http_request` headers / query / form fields | ≤ 20 / ≤ 20 / ≤ 50 |
| Test sends | 10 per minute per user, kept 24 h |
| Allowlist | 100 entries per organization |
| Causation token lifetime | 1 h |
