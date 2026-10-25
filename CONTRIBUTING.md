# Contributing to Cellhive

Thank you for helping. This project is fully open source: every feature is free, and it will stay that way because nobody, including the maintainers, can relicense your contribution.

## Before you start

1. Read [`AGENTS.md`](AGENTS.md). Its golden rules apply to every change, whether written by a person or a coding agent.
2. Pick an open issue, or open an issue first to discuss anything new. One pull request covers one issue.
3. Architecture changes need a new ADR in [`docs/adr/`](docs/adr/). Contract changes update the zod schema, `docs/CONTRACTS.md` and the OpenAPI output in the same pull request.

## Developer Certificate of Origin (DCO)

We do not use a Contributor License Agreement. Instead, every commit must be signed off under the [Developer Certificate of Origin 1.1](https://developercertificate.org/), which states that you have the right to submit the code under the project license.

Sign off each commit with `-s`:

```bash
git commit -s -m "feat(records): add bulk update"
```

This adds a line such as `Signed-off-by: Your Name <you@example.com>` using your git `user.name` and `user.email`. CI rejects pull requests with unsigned commits. To fix the last commit, run `git commit --amend -s --no-edit`.

Copyright stays with each contributor. The project is licensed under AGPL-3.0-only, and `packages/contracts` under Apache-2.0.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `build`, `perf`, with an optional scope such as `feat(records): …`. Write commit messages, code, comments and API names in English.

## Development setup

Requirements: Node.js 24 (see `.nvmrc`), pnpm via `corepack enable` (the version is pinned in `package.json`), Docker. The step-by-step first run, with troubleshooting, is in the [README](README.md#development).

```bash
cp .env.example .env    # development configuration (dev-only secrets)
pnpm install
pnpm dev:infra          # PostgreSQL 18, Valkey, Garage in Docker
pnpm db:migrate         # apply the database migrations
pnpm seed:demo          # demo org, users, base, tables, Sales role (CONTRACTS §9)
pnpm dev                # API on :3000 (+ worker), other apps, with reload
```

| Command                                  | What it does                                                                                                                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev:infra` / `pnpm dev:infra:down` | Start the local infrastructure / stop it and **delete its volumes**                                                                                                                                                                               |
| `pnpm db:migrate`                        | Apply database migrations (same as `MODE=migrate`)                                                                                                                                                                                                |
| `pnpm seed:demo`                         | Create the demo data; a second run changes nothing; refuses `NODE_ENV=production` without `--force`; `--org <name> --email-tag <tag>` seeds another copy (E2E workers)                                                                            |
| `pnpm seed:bench [--rows N]`             | Bench organization with a 200 000-record table (SPEC §21)                                                                                                                                                                                         |
| `pnpm dev`                               | Run the apps in watch mode                                                                                                                                                                                                                        |
| `pnpm cellhive <command>`                | Server CLI (`setup`, `org create`, `user reset-password`, `jobs unlock-stale`, …)                                                                                                                                                                 |
| `pnpm lint`, `pnpm typecheck`            | ESLint (no warnings allowed), TypeScript                                                                                                                                                                                                          |
| `pnpm test`                              | Unit tests (no Docker), including the coverage check of the pure packages like CI                                                                                                                                                                 |
| `pnpm test:coverage`                     | Unit tests of the pure packages with coverage; fails below 90% (SPEC §25, run in CI)                                                                                                                                                              |
| `pnpm test:int`                          | Integration tests with Testcontainers (needs Docker)                                                                                                                                                                                              |
| `pnpm test:matrix`                       | The permission matrix of CONTRACTS §5 (P01–P20, P22–P64) over HTTP, with the test count per row                                                                                                                                                   |
| `pnpm test:e2e`                          | Playwright end-to-end suite on its own Testcontainers stack (builds first; 2 workers, `E2E_WORKERS=n` to change; CI: 2 shards × 2 workers; FRONTEND §11.2)                                                                                        |
| `pnpm test:e2e:perf`                     | Grid performance budgets (`@perf`, 200 000 rows, FRONTEND §11.1), numbers in `apps/web/perf-results.json`; not on pull requests: the `Perf` workflow runs it nightly on `ubuntu-latest` and on demand (`gh workflow run perf.yml --ref <branch>`) |
| `pnpm size`                              | JS bundle budgets with `size-limit` after `pnpm build` (FRONTEND §11.1, run in CI)                                                                                                                                                                |
| `pnpm build`                             | Build every package and app                                                                                                                                                                                                                       |
| `pnpm format` / `pnpm format:check`      | Prettier                                                                                                                                                                                                                                          |
| `pnpm gen:openapi`                       | Regenerate `openapi.json` from the zod schemas (CI checks it has no diff)                                                                                                                                                                         |
| `pnpm licenses:check`                    | Check dependency licenses against the allowlist                                                                                                                                                                                                   |

Working in several checkouts or worktrees at once? Give each its own `COMPOSE_PROJECT_NAME` and `DEV_*_PORT` values in its `.env` so the stacks neither collide nor delete each other's volumes (see `.env.example` and the [README troubleshooting](README.md#troubleshooting)).

## Pull requests

- Keep the change inside the task's scope; do not refactor unrelated code.
- Tests: table-driven unit tests for pure packages, integration tests (real PostgreSQL through Testcontainers) for services, covering the main flow, permissions and tenant isolation.
- Tenant tables and repositories (`docs/SPEC.md` §5.10): every new `meta.*` tenant table has `organization_id`; a foreign key to another tenant table must include `organization_id` (composite, to the parent's `UNIQUE (organization_id, id)`), never a single-column key to its `id` — `packages/server-core/test/db/tenant-fks.int.test.ts` fails otherwise; every new repository takes `organizationId` and has a tenant isolation test.
- `pnpm lint && pnpm typecheck && pnpm test && pnpm test:int` must pass.
- New dependencies must use a license from the allowlist in `docs/SPEC.md` §1A. Explain why you need them in the pull request.
- UI strings go through i18n with both `en` and `vi`.
- Fill in the pull request template, including security and permission impact.

## Reporting security issues

Do not open a public issue. Follow [SECURITY.md](SECURITY.md).
