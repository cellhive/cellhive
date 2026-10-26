# AGENTS.md — Cellhive

Working rules for contributors and coding agents. Read this file before every change; open the other documents only when the task needs them.

## Documents

| File                 | Use it for                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `docs/SPEC.md`       | Architecture, data model, feature semantics                                                       |
| `docs/CONTRACTS.md`  | API/record/filter/error/WS/event formats, type-conversion whitelist, permission test matrix, seed |
| `docs/adr/`          | Architecture decisions that changed the SPEC                                                      |
| `docs/FRONTEND.md`   | Frontend architecture, grid data layer, realtime client, UX conventions, bundle/perf budgets      |
| `docs/integrations/` | User and integrator guides (API, webhooks, dashboards, embedding, …)                              |

Precedence when documents disagree: newest ADR > CONTRACTS (formats) / SPEC (architecture) > FRONTEND > existing code. If a conflict cannot be resolved, stop and raise it in the pull request or an issue instead of guessing.

Task IDs (`T509`, …) and references to `BACKLOG.md`, `docs/reviews/` or `docs/qa/` in documents and code comments point to the maintainers' planning notes, which live in a separate private repository. They only record where a decision came from; the decision itself is in SPEC, CONTRACTS or an ADR.

## Environment

- Node 24 LTS, pnpm 9+, TypeScript strict, Docker.
- PostgreSQL 18 (image with ICU; volume mounted at `/var/lib/postgresql`), Valkey 8, Garage (S3 API) or `STORAGE_DRIVER=local`. No Redis or MinIO (ADR-16, ADR-17, ADR-19).

```bash
pnpm install
pnpm dev:infra          # docker compose -f docker-compose.dev.yml up -d (postgres, valkey, garage)
pnpm db:migrate         # meta + fx migrations
pnpm seed:demo          # sample data (CONTRACTS §9)
pnpm dev                # api + worker + web (turbo)
```

Local checks, the same as CI (`.github/workflows/ci.yml`; each script sets what CI sets):

```bash
pnpm lint               # ESLint, --max-warnings 0
pnpm format:check       # Prettier
pnpm typecheck
pnpm test               # unit + coverage ≥ 90 % for pure packages
pnpm test:int           # integration with Testcontainers (real Postgres)
pnpm build && pnpm size # bundle budgets (FRONTEND §11.1)
pnpm test:e2e           # Playwright, 2 workers
pnpm gen:openapi        # regenerates openapi.json from zod; CI fails on drift
pnpm test:e2e:perf      # @perf, 200,000 rows; nightly in CI (perf.yml), not a PR gate
```

## Layout

```text
apps/api/src/modules/<module>/
  <module>.module.ts
  <module>.controller.ts     # parse/validate and call the service only, no logic
  <module>.service.ts        # business logic, permission checks, transactions
  <module>.repository.ts     # Kysely; every function takes organizationId (except GlobalRepository, SPEC §5.10)
  __tests__/
apps/worker/src/tasks/<task-name>.ts
apps/api/src/cli/            # `cellhive` CLI (migrate, setup, org create, user reset-password)
packages/<pkg>/src/**, packages/<pkg>/test/**
```

- Request/response schemas live in `packages/contracts` (zod). Controllers use `ZodValidationPipe`. No duplicate DTOs in apps.
- Errors: `throw new AppError('CODE', { detail, errors, params })` with a code from CONTRACTS §6. A global filter turns it into problem+json. No `throw new Error` in services or controllers.
- Logging: `pino` through the injected `Logger`. No `console.*`. Never log record values, secrets, tokens or passwords.
- Transactions: `db.withTx(async (tx) => …)`, passing `tx` down to repositories. Events, audit entries and `add_job` use the same `tx`.

## Golden rules (breaking one means the change is not done)

1. All DDL on `data.*` goes through `SchemaService` only. All record reads/writes go through `RecordQueryService` / `RecordMutationService` only.
2. Never build SQL strings from input. SQL identifiers come from meta only, through `sql.id()`. Literals are always parameters. ESLint forbids `sql.raw`/`sql.lit`/`CompiledQuery.raw` outside migrations, `schema/physical.ts`, `schema/schema.service.ts` and `db/create-db.ts`.
3. No `eval`, `new Function` or `vm`.
4. Check permissions on the server for every endpoint, WS subscription, export, dashboard, AI call and share link. No read permission → `404`, not `403`.
5. Every repository takes `organizationId`; every new repository gets a tenant-isolation test. The only exception is `GlobalRepository` for the closed list of global tables in SPEC §5.10 (`organizations`, `users`, `user_identities`, `sessions`, `password_resets`).
6. No feature gates, license checks, enterprise flags, default-on telemetry or required calls to external services.
7. New dependencies must have an AGPL-3.0-compatible license, with the reason stated in the pull request. No new infrastructure services.
8. No silent contract changes: change zod + `CONTRACTS.md` + OpenAPI in the same change.
9. Meta migrations are forward-only; never edit a merged migration.
10. Code, comments, commits and API names are in English. UI strings go through i18n with both `en` and `vi`.

## Workflow

1. Keep each change to one task or issue; don't widen the scope.
2. Pure packages: write the tests first (table-driven). Services: integration tests for the main flow, permissions and tenant isolation.
3. Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:int` — all green. When you change shared UI (`packages/ui`, layout, `Dialog`, app shell) run the full `pnpm test:e2e`. When you change web, ui or contracts code run `pnpm build && pnpm size`. When you change auth, session or WebSocket semantics run the full `pnpm test:e2e`.
4. Commits follow Conventional Commits and carry a DCO sign-off: `git commit -s -m "feat(records): add bulk update"`.

## Definition of done

Acceptance criteria met; CI green; permissions checked; input validated with zod; correct error codes; audit/events considered; realtime considered (when data changes); OpenAPI updated; i18n complete in en/vi (when there is UI); runs with a clean `docker compose up`.

Security issues: report privately as described in [`SECURITY.md`](SECURITY.md), never in a public issue, pull request or document.
