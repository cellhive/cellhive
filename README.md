# Cellhive

> Read this in [Tiếng Việt](README.vi.md).

Cellhive is a self-hosted no-code database platform in the spirit of Airtable and Lark Base: tables with rich field types, views, dashboards, automations, a REST API, fine-grained permissions and optional AI.

It is **fully open source**. There is no enterprise edition, no license key and no feature gate. SSO, field and record permissions, audit log, automations and AI are all part of the core.

> **Status:** early development. Nothing is usable yet. The design lives in [`docs/`](docs/).

## Principles

- **Your data stays yours.** Every table is a real PostgreSQL table that BI tools can read directly, and a whole base can be exported at any time.
- **Easy to self-host.** One `docker compose up`, runs on a 2 GB machine for small teams, images for amd64 and arm64.
- **Works offline.** No mandatory external service and no telemetry by default. AI is optional and can run on a local model.
- **Built in the open.** AGPL-3.0, contributions under the [DCO](https://developercertificate.org/), no CLA.

## Documentation

| Document                                   | Content                                                |
| ------------------------------------------ | ------------------------------------------------------ |
| [`docs/SPEC.md`](docs/SPEC.md)             | Architecture, data model, feature semantics            |
| [`docs/CONTRACTS.md`](docs/CONTRACTS.md)   | API, record, filter, error, realtime and event formats |
| [`docs/FRONTEND.md`](docs/FRONTEND.md)     | Frontend architecture                                  |
| [`docs/integrations/`](docs/integrations/) | User and integrator guides                             |
| [`docs/adr/`](docs/adr/)                   | Architecture decision records                          |
| [`AGENTS.md`](AGENTS.md)                   | Working rules for contributors and coding agents       |

The specification is currently written in Vietnamese; code, comments, commits and API names are in English.

## Development

From a fresh clone to a signed-in demo user in about ten minutes (most of it is the first `pnpm install` and image downloads).

### Prerequisites

- **Node.js 24**: the version is pinned in [`.nvmrc`](.nvmrc), so `nvm use`, `fnm use` or `volta` picks it up.
- **pnpm**: run `corepack enable` once; Corepack then provides the pnpm version pinned in `package.json`.
- **Docker** with Docker Compose v2, running (Docker Desktop, OrbStack, Colima or Docker Engine).
- Free local ports: 3000 (API), 5173 (web), 5432 (PostgreSQL), 6379 (Valkey), 3900 and 3903 (Garage).

### Steps

```bash
# 1. Configuration: development defaults, all secrets are public dev-only values
cp .env.example .env

# 2. Dependencies
pnpm install

# 3. PostgreSQL 18, Valkey and Garage (S3) in Docker, bound to 127.0.0.1
pnpm dev:infra

# 4. Database schema
pnpm db:migrate

# 5. Demo organization "Cellhive Demo": six users, the base "Chăm sóc khách hàng" with
#    Customers, Tickets, Orders (7 200 records) and the Sales role; prints a summary
pnpm seed:demo

# 6. API (+ background worker) and the other apps, with reload on change
pnpm dev
```

- The API listens on <http://localhost:3000> (`/healthz`, `/api/v1/...`). The web app runs on <http://localhost:5173> once it exists in `apps/web`.
- Sign in with a demo user, for example `admin@demo.cellhive.local` / `Cellhive-demo-2026`. The other users are `editor@`, `reader@`, `sales1@`, `sales2@` and `out@demo.cellhive.local`, all with the same password; `pnpm seed:demo` prints what each one can access, and the URLs of a public support form and an organization-only view link (shown once, when the seed creates them). This password is for local development only: the seed refuses to run when `NODE_ENV=production` unless given `--force`, and then gives each user a random password.
- Without the web app, check the API with curl:

  ```bash
  curl -si -c /tmp/ob.jar -H 'content-type: application/json' \
    -d '{"email":"admin@demo.cellhive.local","password":"Cellhive-demo-2026"}' \
    http://localhost:3000/api/v1/auth/login          # 204 + session cookies
  curl -s -b /tmp/ob.jar http://localhost:3000/api/v1/me
  ```

- Stop and delete the local infrastructure **and its data** with `pnpm dev:infra:down`.

Before a pull request, run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:int` (see [CONTRIBUTING.md](CONTRIBUTING.md)).

### Troubleshooting

| Symptom                                                                    | Fix                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Cannot connect to the Docker daemon` / `pnpm dev:infra` fails immediately | Start Docker (Desktop, OrbStack, Colima…) and check `docker info`.                                                                                                                                                                                                                                                                                                                                       |
| `port is already allocated` / `address already in use`                     | Another PostgreSQL, Redis/Valkey or app uses the port: `lsof -i :5432` (or `:6379`, `:3000`, `:3900`) shows which one; stop it. For the API alone you can also change `PORT` in `.env`.                                                                                                                                                                                                                  |
| Two checkouts or worktrees need their own infrastructure                   | Give each one its own Compose project and host ports in its `.env` (see the `docker-compose.dev.yml only` section of `.env.example`): `COMPOSE_PROJECT_NAME`, `DEV_POSTGRES_PORT`, `DEV_VALKEY_PORT`, `DEV_GARAGE_S3_PORT`, `DEV_GARAGE_ADMIN_PORT`, and point `DATABASE_URL`, `CACHE_URL`, `S3_ENDPOINT` at those ports. `pnpm dev:infra:down` then only removes that project's containers and volumes. |
| `Invalid environment configuration` listing variables                      | `.env` is missing or outdated: compare it with `.env.example`.                                                                                                                                                                                                                                                                                                                                           |
| `NODE_ENV is production … refusing to create demo users`                   | `.env` is missing (`NODE_ENV` defaults to `production`): `cp .env.example .env`.                                                                                                                                                                                                                                                                                                                         |
| `The database is not migrated`                                             | Run `pnpm db:migrate`.                                                                                                                                                                                                                                                                                                                                                                                   |
| `Demo data already exists; nothing to do.`                                 | Expected on a second run: nothing is duplicated and the summary is printed again.                                                                                                                                                                                                                                                                                                                        |
| `Some demo data exists but not all of it`                                  | An earlier seed was interrupted. Reset the data (below).                                                                                                                                                                                                                                                                                                                                                 |
| Login answers `401`                                                        | Check the email and password from the seed summary; ten failures within 15 minutes lock the email for 15 minutes (`423 ACCOUNT_LOCKED`): wait, or reset the data.                                                                                                                                                                                                                                        |
| Start over with empty data                                                 | `pnpm dev:infra:down && pnpm dev:infra && pnpm db:migrate && pnpm seed:demo` (`dev:infra:down` removes the Docker volumes).                                                                                                                                                                                                                                                                              |

## License

- The project is licensed under the [GNU Affero General Public License v3.0 only](LICENSE).
- `packages/contracts` (API schemas) is licensed under the [Apache License 2.0](packages/contracts/LICENSE) so that clients and integrations are not bound by the AGPL.
