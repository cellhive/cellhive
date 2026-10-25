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

### Upgrade notes

#### Migration 0052 (`audit_logs_actor_action_idx`): audit writes wait while two indexes build

Migration 0052 (T709) builds `audit_logs_actor_idx (organization_id, actor_id, created_at DESC, id DESC)` and `audit_logs_action_idx (organization_id, action, created_at DESC, id DESC)` on the partitioned `meta.audit_logs`, so on **every monthly partition** (and on partitions created later). They serve the audit log viewer's "who" and "what" filters (CONTRACTS §11.4).

- **Locking**: `CREATE INDEX CONCURRENTLY` is not possible on a partitioned table; a plain `CREATE INDEX` takes a `SHARE` lock on each partition while it builds. Reads continue, **writes to `meta.audit_logs` wait** — and every audited change (record writes, schema changes, sign-ins) writes there, so those requests stall for the duration.
- **Measured**: 1,000,000 entries over 13 partitions (about 0.5 KB each): **3.2 s** for both indexes on an idle machine, 5.4 s under heavy load (10-core macOS machine, PostgreSQL 18 in Docker); together about 190 MiB (≈ 100 bytes per entry per index). Writing entries afterwards costs about 4.5 µs more per entry (100,000 entries: 2.1 s → 2.6 s). Bench: `AUDIT_BENCH=1 pnpm --filter @cellhive/server-core test:int test/audit/audit-viewer.bench`.
- **What to do**: below a few million entries, nothing (a few seconds of waiting writes). With tens of millions, run `cellhive migrate` in a maintenance window (stop the API and the worker, migrate, start them again); scale the numbers above linearly to estimate.
- Forward-only: no down migration. Indexes only (no data changes).

#### Migration 0037 (`events_entity_index`): plan a maintenance window on large installs

Migration 0037 builds the index `meta.events (organization_id, entity_id, created_at)` on **every partition** of `meta.events` (and on partitions created later). It makes `EventsRepository.laterRecordChanges` (automation `record.matches`) cost a few rows instead of every event of the organization since the last dispatched one (p95 0.34 ms instead of 7.5 ms on 2,000,000 events; see `docs/reviews/S5-review.md` §5.2).

- **Locking**: a plain `CREATE INDEX` takes a `SHARE` lock on each partition while it builds. Reads continue, but **writes to that partition wait**, and every record write inserts a `meta.events` row, so record writes (API, imports, automations, workers) stall on the partition being indexed. Partitions are indexed one after another, so the stall moves from month to month.
- **Who is affected**: instances with many events (long-lived installs, large imports, a big dispatch backlog). A fresh install or a small one builds the index in well under a second per partition and needs no special care.
- **What to do on a large install**: run `cellhive migrate` (or the first start that runs migrations) inside a maintenance window: stop the API and the worker (or put the instance in read-only use), run the migration, then start them again. The build time grows with the number of events per partition; it was not measured for large installs, so time it on a restored copy of your database first.
- **Ongoing cost**: about 6 microseconds more per event written (100,000 events inserted in bulk: 803 ms without the index, 1,393 ms with it).
- Forward-only: no down migration. The index is only an index (no data changes).

(To be copied into the self-host deployment documentation.)
