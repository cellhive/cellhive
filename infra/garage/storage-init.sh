#!/bin/sh
# One-shot, idempotent initialisation of a single-node Garage cluster (ADR-0016).
#
# Steps (each one is safe to re-run):
#   1. assign a role to the single node and apply the layout (skipped if assigned)
#   2. create the bucket (skipped if it exists)
#   3. import the access key given by S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
#      (skipped if it exists; fails if it exists with a different secret)
#   4. grant the key read + write on the bucket
#   5. set the bucket CORS rules for the origin of PUBLIC_URL
#
# Talks to the Garage admin API v2 and the S3 API over HTTP only, so it runs in
# any image that has a POSIX shell and curl >= 7.75 (for --aws-sigv4).
# Secret values are never printed.
set -eu

GARAGE_ADMIN_URL="${GARAGE_ADMIN_URL:-http://garage:3903}"
GARAGE_S3_URL="${GARAGE_S3_URL:-http://garage:3900}"
GARAGE_ZONE="${GARAGE_ZONE:-dc1}"
# Capacity only weights data placement between nodes; it is not a quota.
GARAGE_NODE_CAPACITY="${GARAGE_NODE_CAPACITY:-100000000000}"
S3_BUCKET="${S3_BUCKET:-cellhive}"
S3_REGION="${S3_REGION:-garage}"

missing=""
[ -n "${GARAGE_ADMIN_TOKEN:-}" ] || missing="$missing GARAGE_ADMIN_TOKEN"
[ -n "${S3_ACCESS_KEY_ID:-}" ] || missing="$missing S3_ACCESS_KEY_ID"
[ -n "${S3_SECRET_ACCESS_KEY:-}" ] || missing="$missing S3_SECRET_ACCESS_KEY"
[ -n "${PUBLIC_URL:-}" ] || missing="$missing PUBLIC_URL"
if [ -n "$missing" ]; then
  echo "storage-init: missing required environment variables:$missing" >&2
  exit 1
fi

log() { echo "storage-init: $*"; }

# admin METHOD PATH [JSON_BODY]
# Calls the admin API; sets "status" (HTTP code) and "body" (response with all
# whitespace removed, which keeps the grep-based JSON matching below simple).
admin() {
  _out="$(mktemp)"
  if [ $# -ge 3 ]; then
    status="$(curl -sS -o "$_out" -w '%{http_code}' -X "$1" \
      -H "Authorization: Bearer $GARAGE_ADMIN_TOKEN" \
      -H 'Content-Type: application/json' \
      --data "$3" "$GARAGE_ADMIN_URL$2")"
  else
    status="$(curl -sS -o "$_out" -w '%{http_code}' -X "$1" \
      -H "Authorization: Bearer $GARAGE_ADMIN_TOKEN" \
      "$GARAGE_ADMIN_URL$2")"
  fi
  body="$(tr -d ' \n\r\t' <"$_out")"
  rm -f "$_out"
}

require_ok() {
  case "$status" in
    2??) ;;
    *)
      echo "storage-init: $1 failed with HTTP $status" >&2
      exit 1
      ;;
  esac
}

# First 64-hex "id" field of the current (whitespace-stripped) body.
first_id() {
  printf '%s' "$body" | grep -o '"id":"[0-9a-f]\{64\}"' | head -n 1 | cut -d '"' -f 4
}

# Wait for the admin API (the compose healthcheck normally covers this).
attempt=0
until admin GET /v2/GetClusterStatus && [ "$status" = "200" ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "storage-init: Garage admin API not reachable at $GARAGE_ADMIN_URL" >&2
    exit 1
  fi
  sleep 1
done

# 1. Layout ------------------------------------------------------------------
node_id="$(first_id)"
if [ -z "$node_id" ]; then
  echo "storage-init: could not determine Garage node id" >&2
  exit 1
fi
case "$body" in
  *'"role":null'*)
    log "assigning layout role to node $(printf '%.16s' "$node_id")"
    admin POST /v2/UpdateClusterLayout \
      "{\"roles\":[{\"id\":\"$node_id\",\"zone\":\"$GARAGE_ZONE\",\"capacity\":$GARAGE_NODE_CAPACITY,\"tags\":[]}]}"
    require_ok UpdateClusterLayout
    admin GET /v2/GetClusterLayout
    require_ok GetClusterLayout
    current_version="$(printf '%s' "$body" | grep -o '"version":[0-9]*' | head -n 1 | cut -d ':' -f 2)"
    admin POST /v2/ApplyClusterLayout "{\"version\":$((current_version + 1))}"
    require_ok ApplyClusterLayout
    log "layout applied (version $((current_version + 1)))"
    ;;
  *)
    log "layout already assigned"
    ;;
esac

# 2. Bucket ------------------------------------------------------------------
admin GET "/v2/GetBucketInfo?globalAlias=$S3_BUCKET"
if [ "$status" = "200" ]; then
  log "bucket '$S3_BUCKET' already exists"
else
  admin POST /v2/CreateBucket "{\"globalAlias\":\"$S3_BUCKET\"}"
  require_ok CreateBucket
  log "bucket '$S3_BUCKET' created"
fi
bucket_id="$(first_id)"
if [ -z "$bucket_id" ]; then
  echo "storage-init: could not determine bucket id" >&2
  exit 1
fi

# 3. Access key --------------------------------------------------------------
admin GET "/v2/GetKeyInfo?id=$S3_ACCESS_KEY_ID&showSecretKey=true"
if [ "$status" = "200" ]; then
  case "$body" in
    *"\"secretAccessKey\":\"$S3_SECRET_ACCESS_KEY\""*)
      log "access key already exists"
      ;;
    *)
      echo "storage-init: access key $S3_ACCESS_KEY_ID exists with a different secret; delete it in Garage or change S3_ACCESS_KEY_ID" >&2
      exit 1
      ;;
  esac
else
  admin POST /v2/ImportKey \
    "{\"accessKeyId\":\"$S3_ACCESS_KEY_ID\",\"secretAccessKey\":\"$S3_SECRET_ACCESS_KEY\",\"name\":\"cellhive\"}"
  require_ok ImportKey
  log "access key imported"
fi

# 4 + 5. Permissions and CORS --------------------------------------------------
# Setting CORS through the S3 API needs the "owner" permission. The key gets it
# only for the duration of the call; the application keeps read + write.
admin POST /v2/AllowBucketKey \
  "{\"bucketId\":\"$bucket_id\",\"accessKeyId\":\"$S3_ACCESS_KEY_ID\",\"permissions\":{\"read\":true,\"write\":true,\"owner\":true}}"
require_ok AllowBucketKey

origin="$(printf '%s' "$PUBLIC_URL" | sed -E 's#^(https?://[^/]+).*$#\1#')"
cors="<CORSConfiguration><CORSRule>\
<AllowedOrigin>$origin</AllowedOrigin>\
<AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedMethod>PUT</AllowedMethod>\
<AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader>\
<MaxAgeSeconds>3600</MaxAgeSeconds>\
</CORSRule></CORSConfiguration>"

cors_status="$(curl -sS -o /dev/null -w '%{http_code}' -X PUT \
  --aws-sigv4 "aws:amz:$S3_REGION:s3" \
  --user "$S3_ACCESS_KEY_ID:$S3_SECRET_ACCESS_KEY" \
  -H 'Content-Type: application/xml' \
  --data-binary "$cors" \
  "$GARAGE_S3_URL/$S3_BUCKET?cors")"

admin POST /v2/DenyBucketKey \
  "{\"bucketId\":\"$bucket_id\",\"accessKeyId\":\"$S3_ACCESS_KEY_ID\",\"permissions\":{\"read\":false,\"write\":false,\"owner\":true}}"
require_ok DenyBucketKey

case "$cors_status" in
  2??) log "CORS set for origin $origin" ;;
  *)
    echo "storage-init: PutBucketCors failed with HTTP $cors_status" >&2
    exit 1
    ;;
esac

log "done (bucket '$S3_BUCKET', key granted read + write)"
