# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Project specification, API contracts, backlog, frontend guide and ADR-16 to ADR-24.
- Monorepo foundation: pnpm workspace, Turborepo, strict TypeScript, ESLint, Prettier, shared Vitest config.
- Community files: license (AGPL-3.0-only, Apache-2.0 for `packages/contracts`), contributing guide with DCO, code of conduct, security policy, governance, issue and pull request templates.

### Changed

- The product is renamed from its working name OpenBase to **Cellhive** (ADR-37): npm scope `@cellhive/*`, CLI `cellhive`, headers `X-Cellhive-Causation` / `X-Cellhive-Automation`, problem `type` URLs `https://cellhive.io/errors/<CODE>`, env `CELLHIVE_VERSION`, images `ghcr.io/cellhive/cellhive-api` and `cellhive-web`, Compose project, database user and bucket `cellhive`. API tokens start with `cht_` (no token was ever issued, so no other prefix is accepted). Internal identifiers no longer carry a brand (`app.audit_redact`, HKDF labels `<purpose>:v1`, migrator tables `app_migration`). Development databases must be recreated: remove the old stack with `docker compose -p openbase-dev -f docker-compose.dev.yml --profile init down -v`, then `pnpm dev:infra && pnpm db:migrate && pnpm seed:demo`.
- AI field configuration is visible to table managers only (CONTRACTS §29.5): the field API returns the whole `options.ai` (prompt with field names, instructions, `auto_update`, `max_output_tokens`) and `ai_state` only to people with schema rights on the table who can read every field flowing into the prompt; everyone else gets `options.ai = { "task": … }` and no `ai_state`, also in realtime `schema.changed` messages. The `202` answer of `PUT /fields/:id`, reverts and restores return the prompt with field names like every other field answer. Upgrade the API and the worker together: the `schema.changed` messages of an older worker reach every subscriber without `ai_state` (clients still refetch the fields).

### Upgrade notes

#### Migration 0058 (`time_zone_offsets`): time zones are IANA names, never UTC offsets

- **Refused, never converted**: every time zone Cellhive takes — setup (also `cellhive setup --timezone`), invitations, the profile, organization create and settings, `options.timezone` of date fields, `schedule` triggers, widget data and exports, share link exports, Ask AI and the MCP tool `aggregate_records` — is an IANA time zone name. A UTC offset such as `+07:00`, `-0530`, `UTC+7` or `GMT+07:00` answers `422` with the detail code `INVALID_TIME_ZONE` and a `params.hint` (MCP: `isError` with `VALIDATION_FAILED`, path `timezone`). `UTC`, `Etc/UTC` and the fixed zones `Etc/GMT-14` … `Etc/GMT+12` are accepted; their names use the POSIX sign, so UTC+7 is `Etc/GMT-7`. `DEFAULT_TIMEZONE` set to an offset stops the server at start. Update API clients and scripts that send offsets.
- **Legacy names**: `CST6CDT`, `EST5EDT`, `MST7MDT`, `PST8PDT`, `EST`, `MST`, `HST` (links of the tzdata `backward` file) and the 13 `SystemV/*` names are stored by their IANA primary name (`EST5EDT` → `America/New_York`, `SystemV/AST4` → `Etc/GMT+4`; the full table is in CONTRACTS §1.1).
- **Migration 0058** rewrites stored values in users, organization and base settings, date field options and `schedule` triggers, deleted rows included: legacy names become primary names, whole-hour offsets become `Etc/GMT∓N` (`+07:00` → `Etc/GMT-7`), and any other offset (`+05:30`) is reset — a user gets no zone of their own (the organization's applies), everything else `UTC`. The PostgreSQL log gets one `WARNING` with the number of reset values, never a value; if you see it, choose those zones again (an owner or admin now sets the organization's under Organization settings › General). Cell values do not change and nothing is recomputed. Small tables only: no maintenance window. Forward-only: no down migration.

#### AI and MCP (migrations 0054 and 0056): off by default, a second worker job runner, token caps of reasoning models

- **Migrations**: 0054 (`ai_settings`, T906) adds `meta.ai_settings`, `meta.ai_usage_daily` and the `ai_api_key` secret kind (it replaces two `CHECK` constraints of `meta.secrets`); 0056 (`ai_generation_queue`, T910) adds `meta.ai_generation_queue`. New tables only, no rewrite of existing data: no maintenance window. Forward-only: no down migration.
- **Nothing is turned on**: AI stays off for every organization until an owner or admin sets a provider under Organization settings › AI (`docs/integrations/ai.md`), and record values reach a provider only after they also turn on "Let AI see record values". The MCP endpoint answers `403 MCP_DISABLED` until an owner or admin allows MCP clients on the API tokens page (`settings.mcp`, `docs/integrations/mcp.md`). No request leaves the server before that.
- **Worker connections**: each worker process now starts a second job runner for `ai.*` jobs, sized by the new `AI_CONCURRENCY` (default 2, 1–100). It opens its own PostgreSQL connections: `AI_CONCURRENCY + 2` for its queue plus one for its liveness lock, so **5 more per worker process** by default. Count them in `max_connections` or in your PgBouncer pool.
- **Reverse proxy**: an interactive AI request (formula, automation draft, Ask AI, AI field preview) may take up to 90 seconds. The bundled nginx allows 120 s on `/api/`; a proxy or load balancer in front of it needs a read timeout above 90 s (nginx's default is 60 s), or users get its `504` before Cellhive answers.
- **Reasoning models use more tokens**: a model that reasons before it answers (for example `deepseek-flash`, or Ollama models with thinking on) counts its reasoning against the output cap of each call. A call cut off while the model was reasoning is now sent again once with **2,048 more output tokens**, and later calls to that model (per organization, base URL and model, per process) start with them. Both calls count towards the daily token quota of the organization: expect more usage per request with such models and size `daily_token_limit` for it.
- **AI fields that read a link or parent field**: the prompt of an AI field (and of an AI automation step) may no longer name a `link` or `parent` field, whose cells show other records (`422 CROSS_TABLE_NOT_SUPPORTED` when saving). An AI field saved earlier with such a source keeps its values, but every cell queued from now on fails with `render_error` and the provider is not called. Edit the prompt to remove that source, then generate the field again with "All cells (overwrite)" (the field header's AI menu) — or clear the field — so that no value made from the linked records stays.
- **Disk for `count_distinct` widgets**: counting distinct values of a multi-value field (multiple select, several users, links) now goes through `unnest` instead of gathering whole lists in memory (T904). Memory use dropped (peak backend memory 151–632 MB → 33–47 MB at 1,000,000 records × 3 values), but large widgets spill to temporary files instead (up to about 650 MB in that measurement): keep that much free disk for PostgreSQL's temporary files, or a `temp_file_limit` above it.

#### Migration 0055 (`canonical_time_zones`): stored time zones become IANA primary names

Migration 0055 (T901) rewrites time zones stored before T819 by an old or alias name (`Asia/Saigon`, `US/Eastern`, …) to the IANA primary name the `postgres:18` image knows (`Asia/Ho_Chi_Minh`, `America/New_York`) in users, organization and base settings, date field options and `schedule` triggers; cell values do not change and nothing is recomputed, and names it does not know stay as they are, counted (never listed) in a `WARNING` of the PostgreSQL log. Forward-only: no down migration.

#### Migration 0052 (`audit_logs_actor_action_idx`): audit writes wait while two indexes build

Migration 0052 (T709) builds `audit_logs_actor_idx (organization_id, actor_id, created_at DESC, id DESC)` and `audit_logs_action_idx (organization_id, action, created_at DESC, id DESC)` on the partitioned `meta.audit_logs`, so on **every monthly partition** (and on partitions created later). They serve the audit log viewer's "who" and "what" filters (CONTRACTS §11.4).

- **Locking**: `CREATE INDEX CONCURRENTLY` is not possible on a partitioned table; a plain `CREATE INDEX` takes a `SHARE` lock on each partition while it builds. Reads continue, **writes to `meta.audit_logs` wait** — and every audited change (record writes, schema changes, sign-ins) writes there, so those requests stall for the duration.
- **Measured**: 1,000,000 entries over 13 partitions (about 0.5 KB each): **3.2 s** for both indexes on an idle machine, 5.4 s under heavy load (10-core macOS machine, PostgreSQL 18 in Docker); together about 190 MiB (≈ 100 bytes per entry per index). Writing entries afterwards costs about 4.5 µs more per entry (100,000 entries: 2.1 s → 2.6 s). Bench: `AUDIT_BENCH=1 pnpm --filter @cellhive/server-core test:int test/audit/audit-viewer.bench`.
- **What to do**: below a few million entries, nothing (a few seconds of waiting writes). With tens of millions, run `cellhive migrate` in a maintenance window (stop the API and the worker, migrate, start them again); scale the numbers above linearly to estimate.
- Forward-only: no down migration. Indexes only (no data changes).

#### Migration 0037 (`events_entity_index`): plan a maintenance window on large installs

Migration 0037 builds the index `meta.events (organization_id, entity_id, created_at)` on **every partition** of `meta.events` (and on partitions created later). It makes `EventsRepository.laterRecordChanges` (automation `record.matches`) cost a few rows instead of every event of the organization since the last dispatched one (p95 0.34 ms instead of 7.5 ms on 2,000,000 events).

- **Locking**: a plain `CREATE INDEX` takes a `SHARE` lock on each partition while it builds. Reads continue, but **writes to that partition wait**, and every record write inserts a `meta.events` row, so record writes (API, imports, automations, workers) stall on the partition being indexed. Partitions are indexed one after another, so the stall moves from month to month.
- **Who is affected**: instances with many events (long-lived installs, large imports, a big dispatch backlog). A fresh install or a small one builds the index in well under a second per partition and needs no special care.
- **What to do on a large install**: run `cellhive migrate` (or the first start that runs migrations) inside a maintenance window: stop the API and the worker (or put the instance in read-only use), run the migration, then start them again. The build time grows with the number of events per partition; it was not measured for large installs, so time it on a restored copy of your database first.
- **Ongoing cost**: about 6 microseconds more per event written (100,000 events inserted in bulk: 803 ms without the index, 1,393 ms with it).
- Forward-only: no down migration. The index is only an index (no data changes).

(To be copied into the self-host deployment documentation.)
