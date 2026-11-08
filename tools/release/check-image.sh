#!/usr/bin/env bash
# Checks an image built with attestations against the image the smoke test ran
# (tools/release/smoke.sh), for one architecture (docs/releasing.md):
#
#   tools/release/check-image.sh <arch> <smoke-tested image> <OCI layout tar | repository@digest>
#
# The second build (`sbom: true`, `provenance: mode=max` in .github/workflows/release.yml)
# reuses the layers of the first one. This fails unless
#   1. its linux/<arch> image has the same layers (diff IDs) as the smoke-tested image;
#   2. its index has an attestation manifest with an SPDX SBOM and a SLSA provenance.
# Reads an OCI layout tarball (`outputs: type=oci`, nothing pushed) or a pushed
# `repository@sha256:…` (with `docker buildx imagetools`).
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <arch> <smoke-tested image> <OCI layout tar | repository@digest>" >&2
  exit 2
fi
ARCH=$1
LOCAL_IMAGE=$2
TARGET=$3

fail() {
  echo "image check failed: $*" >&2
  exit 1
}

# Prints the manifest or index with this digest.
manifest() {
  if [ -f "$TARGET" ]; then
    tar -xOf "$TARGET" "blobs/sha256/${1#sha256:}"
  else
    docker buildx imagetools inspect --raw "${TARGET%@*}@$1"
  fi
}

# Prints the image configuration of the image manifest with this digest.
config() {
  if [ -f "$TARGET" ]; then
    local blob
    blob=$(manifest "$1" | jq -r '.config.digest')
    tar -xOf "$TARGET" "blobs/sha256/${blob#sha256:}"
  else
    docker buildx imagetools inspect "${TARGET%@*}@$1" --format '{{ json .Image }}'
  fi
}

if [ -f "$TARGET" ]; then
  # index.json of an OCI layout names the image index the build produced.
  root=$(tar -xOf "$TARGET" index.json | jq -r '.manifests[0].digest')
else
  root=${TARGET#*@}
fi
index=$(manifest "$root")
[ "$(jq -r '.mediaType' <<< "$index")" = application/vnd.oci.image.index.v1+json ] ||
  fail "$root is not an image index (built without attestations?)"

image=$(jq -r --arg arch "$ARCH" \
  '[.manifests[] | select(.platform.os == "linux" and .platform.architecture == $arch)] | if length == 1 then .[0].digest else empty end' \
  <<< "$index")
[ -n "$image" ] || fail "no single linux/$ARCH image in $root"

expected=$(docker image inspect --format '{{ json .RootFS.Layers }}' "$LOCAL_IMAGE" | jq -c '.')
actual=$(config "$image" | jq -c '.rootfs.diff_ids')
[ "$expected" = "$actual" ] ||
  fail "the layers of linux/$ARCH $image differ from those of $LOCAL_IMAGE (the smoke-tested image)"

attestation=$(jq -r --arg image "$image" \
  '.manifests[] | select(.annotations["vnd.docker.reference.type"] == "attestation-manifest" and .annotations["vnd.docker.reference.digest"] == $image) | .digest' \
  <<< "$index")
[ -n "$attestation" ] || fail "no attestation manifest for $image"
predicates=$(manifest "$attestation" | jq -r '[.layers[].annotations["in-toto.io/predicate-type"]] | sort | join(" ")')
case " $predicates " in
  *' https://spdx.dev/Document '*) ;;
  *) fail "no SPDX SBOM attestation for $image (predicates: $predicates)" ;;
esac
case " $predicates " in
  *' https://slsa.dev/provenance/'*) ;;
  *) fail "no SLSA provenance attestation for $image (predicates: $predicates)" ;;
esac

echo "linux/$ARCH $image: same $(jq 'length' <<< "$actual") layers as $LOCAL_IMAGE; attestations: $predicates"
