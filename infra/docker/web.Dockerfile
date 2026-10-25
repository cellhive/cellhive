# syntax=docker/dockerfile:1
#
# Cellhive web image (`cellhive-web`): nginx serving the static SPA build and
# reverse-proxying /api and /ws to the API (docker-compose.yml, SPEC §20).
#
#   docker build -f infra/docker/web.Dockerfile -t cellhive-web .
#
# Stages: `build` installs only the web app and its workspace dependencies
# and runs `vite build`; `runtime` is nginx with the files in dist/ and the
# config from infra/docker/web/. Nothing is fetched at run time (no CDN).

ARG NODE_IMAGE=node:24-alpine
ARG NGINX_IMAGE=nginx:1.29-alpine

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# pnpm version comes from `packageManager` in package.json.
RUN corepack enable
WORKDIR /repo
# Manifests first, so the dependency layer is reused when only sources change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/field-types/package.json packages/field-types/
COPY packages/filter-dsl/package.json packages/filter-dsl/
COPY packages/formula-engine/package.json packages/formula-engine/
COPY packages/markdown/package.json packages/markdown/
COPY packages/ui/package.json packages/ui/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@cellhive/web..."
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY packages/field-types packages/field-types
COPY packages/filter-dsl packages/filter-dsl
COPY packages/formula-engine packages/formula-engine
COPY packages/markdown packages/markdown
COPY packages/ui packages/ui
COPY apps/web apps/web
# Topological order: the workspace packages (tsc) first, then the web app (vite).
# The OFL-1.1 texts travel with the self-hosted font files (THIRD_PARTY_NOTICES.md).
RUN pnpm --filter "@cellhive/web..." run build \
 && rm -rf apps/web/dist/.vite \
 && mkdir -p apps/web/dist/licenses \
 && cp apps/web/node_modules/@fontsource/be-vietnam-pro/LICENSE apps/web/dist/licenses/be-vietnam-pro-OFL-1.1.txt \
 && cp apps/web/node_modules/@fontsource/jetbrains-mono/LICENSE apps/web/dist/licenses/jetbrains-mono-OFL-1.1.txt

FROM ${NGINX_IMAGE} AS runtime
# STORAGE_PUBLIC_ORIGIN: origin of S3_PUBLIC_ENDPOINT (object storage the browser
# uploads to and loads files from, T418); empty for STORAGE_DRIVER=local.
ENV API_UPSTREAM=api:3000 \
    NGINX_RESOLVER=127.0.0.11 \
    STORAGE_PUBLIC_ORIGIN=""
# The image renders /etc/nginx/templates/**/*.template with envsubst at start-up
# into /etc/nginx/conf.d (sub-directories kept: snippets/ is not auto-included).
COPY infra/docker/web/default.conf.template /etc/nginx/templates/default.conf.template
COPY infra/docker/web/security-headers.conf.template /etc/nginx/templates/snippets/security-headers.conf.template
COPY infra/docker/web/share-page-headers.conf.template /etc/nginx/templates/snippets/share-page-headers.conf.template
COPY infra/docker/web/share-embed-headers.conf.template /etc/nginx/templates/snippets/share-embed-headers.conf.template
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
