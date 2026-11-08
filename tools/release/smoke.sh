#!/usr/bin/env bash
# Smoke test of a pair of release images on one architecture (docs/releasing.md).
#
#   tools/release/smoke.sh <cellhive-api image> <cellhive-web image> <expected version>
#
# On a throwaway Docker network, next to postgres:18 and valkey/valkey:8:
#   1. both images carry the OCI labels of the version;
#   2. MODE=migrate migrates an empty database, exits 0 and logs the version first;
#   3. MODE=all answers /healthz with that version and /readyz with every check up;
#   4. the worker renders WebP thumbnails with sharp (the native libvips binary of the
#      image's architecture, musl on Alpine) — tools/release/smoke-thumbnail.mjs;
#   5. the web image serves the SPA and proxies /api to the API.
# Everything it starts (containers, network) is removed on exit, also on failure.
# .github/workflows/release.yml runs it on each architecture before anything is published.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <api image> <web image> <expected version>" >&2
  exit 2
fi
API_IMAGE=$1
WEB_IMAGE=$2
VERSION=$3
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
POSTGRES_IMAGE=${SMOKE_POSTGRES_IMAGE:-postgres:18}
VALKEY_IMAGE=${SMOKE_VALKEY_IMAGE:-valkey/valkey:8}

RUN_ID="cellhive-smoke-$$-${RANDOM}"
NETWORK=$RUN_ID
PG="$RUN_ID-postgres"
VALKEY="$RUN_ID-valkey"
APP="$RUN_ID-app"
WEB="$RUN_ID-web"

cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    for name in "$APP" "$WEB"; do
      if docker container inspect "$name" > /dev/null 2>&1; then
        echo "--- last log lines of $name" >&2
        docker logs --tail 40 "$name" >&2 2>&1 || true
      fi
    done
  fi
  docker rm -f "$PG" "$VALKEY" "$APP" "$WEB" > /dev/null 2>&1 || true
  docker network rm "$NETWORK" > /dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

step() { echo "==> $*"; }
fail() {
  echo "smoke test failed: $*" >&2
  exit 1
}

# Retries `docker exec <container> <command…>` for up to 90 seconds, or until the
# container stops; prints the command's output.
wait_for() {
  local container=$1
  shift
  local output
  for _ in $(seq 1 90); do
    if output=$(docker exec "$container" "$@" 2> /dev/null); then
      printf '%s' "$output"
      return 0
    fi
    [ "$(docker container inspect --format '{{ .State.Running }}' "$container")" = true ] || return 1
    sleep 1
  done
  return 1
}

step "OCI labels of $API_IMAGE and $WEB_IMAGE"
for image in "$API_IMAGE" "$WEB_IMAGE"; do
  label=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' "$image")
  [ "$label" = "$VERSION" ] || fail "$image: org.opencontainers.image.version is '$label', not '$VERSION'"
  source=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.source" }}' "$image")
  [ "$source" = https://github.com/cellhive/cellhive ] || fail "$image: org.opencontainers.image.source is '$source'"
done

step "PostgreSQL and Valkey on network $NETWORK"
docker network create "$NETWORK" > /dev/null
docker run -d --name "$PG" --network "$NETWORK" --network-alias postgres \
  -e POSTGRES_USER=cellhive -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=cellhive \
  "$POSTGRES_IMAGE" > /dev/null
docker run -d --name "$VALKEY" --network "$NETWORK" --network-alias valkey "$VALKEY_IMAGE" > /dev/null
# Over TCP: the image's first start runs a temporary server on the Unix socket only.
wait_for "$PG" pg_isready -h 127.0.0.1 -U cellhive -d cellhive > /dev/null || fail 'PostgreSQL did not start'

SERVER_ENV=(
  -e NODE_ENV=production
  -e PUBLIC_URL=http://localhost:8080
  -e DATABASE_URL=postgres://cellhive:smoke@postgres:5432/cellhive
  -e CACHE_URL=redis://valkey:6379
  -e "APP_MASTER_KEY=$(head -c 32 /dev/urandom | base64)"
  -e "SESSION_SECRET=$(head -c 32 /dev/urandom | base64)"
  -e STORAGE_DRIVER=local
)

step 'MODE=migrate'
migrate_log=$(docker run --rm --network "$NETWORK" "${SERVER_ENV[@]}" -e MODE=migrate "$API_IMAGE") ||
  { printf '%s\n' "$migrate_log" >&2; fail 'MODE=migrate exited with an error'; }
first_line=$(printf '%s\n' "$migrate_log" | head -n 1)
case "$first_line" in
  *'"msg":"cellhive starting"'*) ;;
  *) fail "the first log line is not 'cellhive starting': $first_line" ;;
esac
case "$first_line" in
  *"\"version\":\"$VERSION\""*) ;;
  *) fail "the start-up log does not name version $VERSION: $first_line" ;;
esac
printf '%s\n' "$migrate_log" | grep -q '"msg":"database is up to date"' || fail 'no "database is up to date" log line'

step 'MODE=all: /healthz and /readyz'
docker run -d --name "$APP" --network "$NETWORK" --network-alias api \
  "${SERVER_ENV[@]}" -e MODE=all "$API_IMAGE" > /dev/null
health=$(wait_for "$APP" wget -q -O - http://127.0.0.1:3000/healthz) || fail '/healthz did not answer'
expected="{\"status\":\"ok\",\"version\":\"$VERSION\"}"
[ "$health" = "$expected" ] || fail "/healthz answered $health instead of $expected"
ready=$(wait_for "$APP" wget -q -O - http://127.0.0.1:3000/readyz) || fail '/readyz did not answer 200'
case "$ready" in
  *'"status":"ok"'*) ;;
  *) fail "/readyz answered $ready" ;;
esac
echo "$health"

step 'Thumbnail with sharp'
docker exec -i "$APP" node --input-type=module - < "$HERE/smoke-thumbnail.mjs"

step 'Web: SPA and /api proxy'
docker run -d --name "$WEB" --network "$NETWORK" -e API_UPSTREAM=api:3000 "$WEB_IMAGE" > /dev/null
index=$(wait_for "$WEB" wget -q -O - http://127.0.0.1/) || fail 'the web container did not serve /'
case "$index" in
  *'<div id="root"></div>'*) ;;
  *) fail 'the web container did not serve the SPA' ;;
esac
providers=$(wait_for "$WEB" wget -q -O - http://127.0.0.1/api/v1/auth/providers) ||
  fail 'the web container did not proxy /api/v1/auth/providers'
case "$providers" in
  '{'*) ;;
  *) fail "/api/v1/auth/providers through nginx answered $providers" ;;
esac

step "Smoke test passed: $VERSION on $(docker image inspect --format '{{ .Os }}/{{ .Architecture }}' "$API_IMAGE")"
