# Releasing Cellhive

For maintainers. A release is a git tag `v<version>` on `main`; the workflow [`.github/workflows/release.yml`](../.github/workflows/release.yml) does everything else. Versions follow [Semantic Versioning](https://semver.org/): `0.1.0`, and release candidates `0.1.0-rc.1`, `0.1.0-rc.2`, … before it (SPEC §1A "Phát hành").

## What a tag publishes

| What | Where |
| --- | --- |
| Server image (API, worker, migrations; `MODE=api\|worker\|all\|migrate`) | `ghcr.io/cellhive/cellhive-api:<version>` |
| Web image (nginx, the SPA, proxy of `/api` and `/ws`) | `ghcr.io/cellhive/cellhive-web:<version>` |
| Platforms | one manifest list per image: `linux/amd64` and `linux/arm64`, each built natively (runners `ubuntu-24.04` and `ubuntu-24.04-arm`) |
| Other tags | a stable version that is the newest stable one also moves `<major>.<minor>` and `latest`; a release candidate gets its own tag only, never `latest` |
| Signatures | cosign keyless (Sigstore, GitHub OIDC) on each manifest list and each platform image |
| SBOMs | SPDX JSON, in three places (see [Where the SBOMs are](#where-the-sboms-are)) |
| GitHub Release | notes from `CHANGELOG.md`; files `docker-compose.yml` (its images default to this version), `env.example` (the `.env.example` of the tag: GitHub renames files whose name starts with a dot), the SBOMs and `SHA256SUMS`; marked as a pre-release for a release candidate |

The images report their version: `GET /healthz` answers `{"status":"ok","version":"0.1.0"}`, the first log line of every server process (api, worker, migrate) is `cellhive starting` with `version`, and `.chbase` exports write it as `app_version`. It comes from the build argument `CELLHIVE_VERSION` (the tag without its `v`) through `CELLHIVE_BUILD_VERSION` (SPEC §20); an image built without it reports `dev`.

What the workflow runs, in order:

1. **Version and tags**: the tag must be `vX.Y.Z` or `vX.Y.Z-<pre-release>`, and `X.Y.Z` must be the `version` of `package.json`.
2. **Build and smoke test**, on each architecture: both images, then [`tools/release/smoke.sh`](../tools/release/smoke.sh) on them (OCI labels, `MODE=migrate` on an empty PostgreSQL 18, `/healthz` with the version, `/readyz`, WebP thumbnails with the image's own sharp binary — musl on Alpine —, the SPA and the `/api` proxy of the web image), SPDX SBOMs with syft, then the same images again with BuildKit SBOM and provenance (`mode=max`) attestations, checked to have exactly the smoke-tested layers ([`tools/release/check-image.sh`](../tools/release/check-image.sh)) and pushed by digest.
3. **Dependency audit**: `pnpm audit --prod --audit-level high`, a report in the run summary and the `pnpm-audit` artifact; it does not stop the release.
4. **Manifest lists, signatures, attestations**: `docker buildx imagetools create`, `cosign sign`, `cosign attest --type spdxjson`, then the verification commands below.
5. **GitHub Release**.

The tools (buildx, cosign, syft) run in the workflow only: they are not in the images nor in `pnpm-lock.yaml`. Every action is pinned by commit SHA; update a pin to the commit of a release tag, with the tag in the comment.

## Before tagging

1. `main` is green in CI on the commit you tag.
2. Every `package.json` has the version without its pre-release part (`0.1.0` for `v0.1.0-rc.1` and `v0.1.0`). `tools/ci/test/package-metadata.test.ts` keeps them equal; the workflow stops on a tag that does not match. To change it:

   ```bash
   perl -0pi -e 's/"version": "[^"]*"/"version": "0.2.0"/' package.json {apps,packages,tools}/*/package.json
   ```

3. `CHANGELOG.md`: the notes of a release are its section `## [X.Y.Z] - YYYY-MM-DD`. For a stable release, rename `## [Unreleased]` to that and start a new empty `## [Unreleased]` above it (Keep a Changelog). A release candidate uses `## [X.Y.Z]` when it exists and `## [Unreleased]` otherwise.
4. Dry run on `main` — it builds and smoke-tests both architectures, writes the notes and files, and publishes nothing (no registry login, no push, no signature, no release):

   ```bash
   gh workflow run release.yml --repo cellhive/cellhive --ref main -f version=0.1.0-rc.1
   ```

   A pull request that changes the workflow, `infra/docker/**`, `tools/release/**` or `.dockerignore` runs the same dry run.

## Cutting a release candidate

```bash
VERSION=0.1.0-rc.1
git switch main && git pull --ff-only
git tag -a "v$VERSION" -m "Cellhive $VERSION"
git push origin "v$VERSION"
gh run watch --repo cellhive/cellhive \
  "$(gh run list --repo cellhive/cellhive --workflow release.yml --branch "v$VERSION" --limit 1 --json databaseId --jq '.[0].databaseId')"
```

A new GHCR package is private by default, so after the first release of each image: open the package (`https://github.com/orgs/cellhive/packages/container/package/cellhive-api`, then `cellhive-web`) › Package settings › Change visibility › **Public**, so that `docker pull` and `cosign verify` work without logging in. Then run [Verifying a release](#verifying-a-release).

Each fix after a candidate gets a new candidate (`v0.1.0-rc.2`); never move or reuse a tag that was pushed.

## Cutting the release

The same commands with `VERSION=0.1.0`, once `## [0.1.0] - <date>` is in `CHANGELOG.md`. A stable version that is the newest stable one moves `0.1` and `latest` and becomes the latest GitHub Release; a patch of an older minor version (`0.1.5` after `0.2.0`) gets its own tag only.

## When a run fails

- **Before "Manifest lists, signatures, attestations"** nothing is tagged, signed or released: at most untagged platform images were pushed by digest. Fix it on `main` and cut the next candidate.
- **Later** (for example GHCR or Sigstore unavailable): re-run the failed jobs of that run, or start the publishing again on the tag — the manifest lists are recreated, signatures and attestations are added again, and an existing GitHub Release gets its notes and files replaced:

  ```bash
  gh workflow run release.yml --repo cellhive/cellhive --ref v0.1.0-rc.1 -f version=0.1.0-rc.1 -f publish=true
  ```

  `publish: true` only runs on the tag `v<version>` itself, in `cellhive/cellhive`.
- If the arm64 runners are ever unavailable, the arm64 leg can run on `ubuntu-24.04` under emulation (`docker/setup-qemu-action`, several times slower); that is a change to the workflow, through a pull request.

## Verifying a release

Requirements: Docker with buildx, [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) 3 or later, `jq`.

```bash
VERSION=0.1.0-rc.1
IDENTITY="https://github.com/cellhive/cellhive/.github/workflows/release.yml@refs/tags/v$VERSION"
ISSUER=https://token.actions.githubusercontent.com
```

Platforms: each image lists `linux/amd64` and `linux/arm64` (and one `unknown/unknown` entry per platform: its BuildKit attestations):

```bash
docker manifest inspect ghcr.io/cellhive/cellhive-api:$VERSION | jq -r '.manifests[] | "\(.platform.os)/\(.platform.architecture) \(.digest)"'
docker manifest inspect ghcr.io/cellhive/cellhive-web:$VERSION | jq -r '.manifests[] | "\(.platform.os)/\(.platform.architecture) \(.digest)"'
```

Signatures: made by the release workflow, run on that tag, in `cellhive/cellhive`:

```bash
cosign verify ghcr.io/cellhive/cellhive-api:$VERSION --certificate-identity "$IDENTITY" --certificate-oidc-issuer "$ISSUER"
cosign verify ghcr.io/cellhive/cellhive-web:$VERSION --certificate-identity "$IDENTITY" --certificate-oidc-issuer "$ISSUER"
```

Any release instead of one version: replace `--certificate-identity "$IDENTITY"` with `--certificate-identity-regexp '^https://github\.com/cellhive/cellhive/\.github/workflows/release\.yml@refs/tags/v[0-9]'`. A platform image verifies the same way by digest (`ghcr.io/cellhive/cellhive-api@sha256:…` from `docker manifest inspect`).

SBOM attestations (`cosign attest --type spdxjson`; the manifest list has one per platform, each platform image its own):

```bash
cosign verify-attestation ghcr.io/cellhive/cellhive-api:$VERSION --type spdxjson \
  --certificate-identity "$IDENTITY" --certificate-oidc-issuer "$ISSUER" |
  jq -r '.payload | @base64d | fromjson | "\(.predicate.name): \(.predicate.packages | length) packages"'
cosign verify-attestation ghcr.io/cellhive/cellhive-web:$VERSION --type spdxjson \
  --certificate-identity "$IDENTITY" --certificate-oidc-issuer "$ISSUER" |
  jq -r '.payload | @base64d | fromjson | "\(.predicate.name): \(.predicate.packages | length) packages"'
```

The version and the commit in the OCI labels, and the version the server reports:

```bash
docker buildx imagetools inspect ghcr.io/cellhive/cellhive-api:$VERSION --format '{{ json (index .Image "linux/amd64").Config.Labels }}'
docker buildx imagetools inspect ghcr.io/cellhive/cellhive-web:$VERSION --format '{{ json (index .Image "linux/arm64").Config.Labels }}'
docker run --rm --entrypoint printenv ghcr.io/cellhive/cellhive-api:$VERSION CELLHIVE_BUILD_VERSION
```

On a running instance, `/healthz` is answered by the server container on port 3000 (the web container proxies `/api` and `/ws` only): `docker compose exec app wget -q -O - http://127.0.0.1:3000/healthz` (profile `minimal`; `api` with `full`).

## Where the SBOMs are

1. **Release files**: `cellhive-api-<version>-linux-amd64.spdx.json`, `…-linux-arm64.spdx.json`, the same for `cellhive-web`, made by syft from the smoke-tested images; `SHA256SUMS` covers them with the other files:

   ```bash
   gh release download "v$VERSION" --repo cellhive/cellhive --pattern '*.spdx.json' --pattern SHA256SUMS
   sha256sum --check --ignore-missing SHA256SUMS
   jq '[.packages[].externalRefs[]? | select(.referenceType == "purl") | .referenceLocator | select(startswith("pkg:npm/"))] | length' "cellhive-api-$VERSION-linux-amd64.spdx.json"
   ```

2. **cosign attestations**: the same files, signed — `cosign verify-attestation` above.
3. **BuildKit attestations in the image index** (made during the build, with the SLSA provenance):

   ```bash
   docker buildx imagetools inspect ghcr.io/cellhive/cellhive-api:$VERSION --format '{{ json (index .SBOM "linux/arm64").SPDX }}' | jq '.packages | length'
   docker buildx imagetools inspect ghcr.io/cellhive/cellhive-api:$VERSION --format '{{ json (index .Provenance "linux/arm64").SLSA }}' | jq '.buildDefinition.externalParameters.request.args'
   ```
