# syntax=docker/dockerfile:1
#
# Cellhive server image (`cellhive-api`). One image serves every server role,
# selected with MODE (api | worker | all | migrate, SPEC §20).
#
#   docker build -f infra/docker/api.Dockerfile -t cellhive-api .
#
# Stages: `build` installs the workspace and compiles the api with its
# workspace dependencies (including `@cellhive/worker`, which MODE=worker and
# MODE=all start in the api process); `pnpm deploy` then copies the api with production
# dependencies only into /out; `runtime` runs it as the unprivileged `node` user.

ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# pnpm version comes from `packageManager` in package.json.
RUN corepack enable
WORKDIR /repo

FROM base AS build
# Manifests first, so the dependency layer is reused when only sources change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/contracts/package.json packages/contracts/
COPY packages/field-types/package.json packages/field-types/
COPY packages/filter-dsl/package.json packages/filter-dsl/
COPY packages/formula-engine/package.json packages/formula-engine/
COPY packages/markdown/package.json packages/markdown/
COPY packages/permissions/package.json packages/permissions/
COPY packages/server-core/package.json packages/server-core/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@cellhive/api..."
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY packages/field-types packages/field-types
COPY packages/filter-dsl packages/filter-dsl
COPY packages/formula-engine packages/formula-engine
COPY packages/markdown packages/markdown
COPY packages/permissions packages/permissions
COPY packages/server-core packages/server-core
COPY apps/worker apps/worker
COPY apps/api apps/api
RUN pnpm --filter "@cellhive/api..." run build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @cellhive/api deploy --prod --legacy /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_LOCAL_PATH=/data/files
WORKDIR /app
# Directory for STORAGE_DRIVER=local; a named volume mounted here inherits
# the ownership. `cellhive <command>` runs the CLI (SPEC §14.1A, §14.2), e.g.
# `docker compose exec api cellhive user reset-password --email …`.
RUN mkdir -p /data/files && chown node:node /data/files \
 && printf '#!/bin/sh\nexec node /app/dist/cli.js "$@"\n' > /usr/local/bin/cellhive \
 && chmod 0755 /usr/local/bin/cellhive
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3000
# Node handles SIGTERM itself (graceful shutdown in src/main.ts).
CMD ["node", "dist/main.js"]
