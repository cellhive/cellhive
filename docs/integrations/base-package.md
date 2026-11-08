# Moving a whole base with `.chbase` packages

A `.chbase` package is one file holding a whole base: its tables, fields, records, links, files, shared views and forms, dashboards, custom roles and automations. Export it from one workspace and import it into another workspace, organization or Cellhive instance to get the same base back, under new IDs, owned by the person who imported it.

- **Exporting and importing**: in the app, through the API or with the command line for packages too large for a browser upload (§1, §2, §5).
- **What is and is not in a package**, and the file format (§3).
- **Limits**: package size, compression ratios, one export and one import per organization at a time (§4).
- **Security when importing someone else's package** (§6).
- **How it compares with `pg_dump`** (§7) and **troubleshooting** (§8).

The normative formats are in `docs/CONTRACTS.md` §12.2 (package, jobs, report, errors) and §26.3 (API token scopes); the architecture is in ADR-24 and its 2026-11 amendment. If this guide and those documents disagree, the contracts win. Please report the mismatch.

## Contents

1. [Exporting a base](#1-exporting-a-base)
2. [Importing a base](#2-importing-a-base)
3. [What a package holds](#3-what-a-package-holds)
4. [Limits](#4-limits)
5. [The command line for large packages](#5-the-command-line-for-large-packages)
6. [Security when importing someone else's package](#6-security-when-importing-someone-elses-package)
7. [Compared with `pg_dump`](#7-compared-with-pg_dump)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. Exporting a base

**Who**: the owner or an admin of the base, an admin of its workspace, or an owner or admin of the organization. A package holds **every field of the base, including fields that roles hide from other members** — the same reason only base admins see the export.

**In the app**: open the base → **Base settings** → **Data** → **Export base**. The page lists what the package holds and leaves out; **Export base** opens a dialog that says it again, then **Start export** runs the export in the background:

1. the dialog shows its phases — tables and fields, records, links, files, saving the package — and you may close it: the export goes on and its status stays on the page;
2. once it is done, **Download** saves `<base name>.chbase`. The link works for **one hour**; after that the package is deleted and you export again.

**Through the API** (`records:read`, plus `schema:read` and `automations:read` for a token — the package holds the schema and the automations too):

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  https://cellhive.example.com/api/v1/bases/bse_…/export
# → 202 { "job_id": "job_…" }
curl -H "Authorization: Bearer $TOKEN" https://cellhive.example.com/api/v1/jobs/job_…
# → { "status": "succeeded", "progress": 1, "result": { "download_url": "/api/v1/files/exports/job_…",
#      "expires_at": "…", "size": 48213992, "counts": { "tables": 3, "records": 7200, … },
#      "skipped_personal_views": 2 } }
curl -L -o base.chbase -H "Authorization: Bearer $TOKEN" \
  https://cellhive.example.com/api/v1/files/exports/job_…
```

A base you cannot reach (another organization, outside the token's bases) answers `404`; a member who is not a base admin gets `403 PERMISSION_DENIED`; a token missing a scope gets `403 INSUFFICIENT_SCOPE` listing every missing scope. Only the person who started the export — while they are still a base admin — and the organization's owners and admins can read the job and download the package. Each export is recorded in the audit log (`base.exported`, with counts, never values).

## 2. Importing a base

**Who**: whoever may create a base in the target workspace — a workspace admin or an organization owner or admin. The new base is owned by the person who imports it and **nobody else has access** until they add members: no role of the package is assigned to anyone.

**In the app**: open the workspace → **Import base · From a .chbase file** (beside **New base**) → drop the file or choose it → **Import**. The dialog uploads the file, then follows the import phases: checking the package, tables and fields, files, records, links and sub-records, formulas/views/dashboards/automations, finishing. You may close it once the upload is done; the base appears in the workspace when the import ends.

The **report** lists what was created, then only what needs you:

| Section | What to do |
| --- | --- |
| **Automations are off** | Every imported automation is off and runs as you. Turn each on once what it uses is set up again. |
| **Set up again** | Secrets (Telegram bots, HTTP secrets), sending identities, notification groups and incoming webhooks are never exported — only their names, with the automations that used them. Create or choose them in this organization, pick them in each automation (the field shows "not chosen"), then turn the automation on. Turning it on before that answers `422 AUTOMATION_INVALID`. |
| **People not found** | Users are matched by **email**, only with members of this organization. Cells, creators and reminders of the others are left empty; a filter or recipient naming them keeps its condition (it matches nobody). Invite them and set the values again if needed. |
| **AI fields** | Their values were imported; nothing is generated until AI is set up in this organization. |
| **Personal views left out** | Personal views stay with their owner and are never exported. |
| **Files left out** | A file of a blocked type, larger than `ATTACHMENT_MAX_FILE_BYTES` of this instance, or whose content is not its type; the cell keeps its other files. |

**Open base** takes you there. A package that cannot be imported fails as a whole with `INVALID_PACKAGE`: the dialog lists each problem with what it means and where it is in the package (an entry, a JSON pointer, a line of an NDJSON file) — and **nothing** is left behind: no base, table, file or row.

**Through the API** (`schema:write`, plus `records:write` and `automations:write` for a token; a token limited to some bases cannot import, since the new base is outside them):

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -F "file=@base.chbase" \
  https://cellhive.example.com/api/v1/workspaces/wsp_…/bases/import
# → 202 { "job_id": "job_…" }
curl -H "Authorization: Bearer $TOKEN" https://cellhive.example.com/api/v1/jobs/job_…
# → { "status": "succeeded", "result": { "base_id": "bse_…", "report": { "tables": 3, …,
#      "unmatched_user_emails": [...], "automations_disabled": 2, "secrets_to_reconnect": [...],
#      "webhooks_to_recreate": [...], "ai_fields": [...], "skipped_personal_views": 2,
#      "files_skipped": [...] } } }
```

The body is `multipart/form-data` with one part `file` whose name ends in `.chbase` (else `415`). The upload streams to disk, never into memory; `Idempotency-Key` is ignored (sending the file again is another import). While the import runs the new base is hidden — `404` everywhere, for you too — and an import that fails, is cancelled or is interrupted removes everything it built. The audit log records `base.created` and `base.imported` (counts only) when it ends.

## 3. What a package holds

| In the package | Not in the package |
| --- | --- |
| Base name, description, icon, time zone, locale, collation, strict computed permissions | Members, groups, role assignments |
| Tables and every field (formula and lookup definitions are recomputed on import, not copied) | Records, tables and fields in the trash |
| Records with their creation and change times and creators (by email), auto numbers | Record history, the audit log, events, automation runs, notifications, follows |
| Links (with their order) and sub-records | Share links, API tokens, sessions |
| Attached files, form cover images, images of automation emails | Secret values, bots, sending identities, incoming webhooks (only their names, in `detached`) |
| Shared views and forms, dashboards and widgets | Personal views |
| Custom roles (assigned to nobody) | System roles (every base has its own) |
| Automations (imported **off**) | Values of formula and lookup fields (recomputed); password hashes, IP addresses |

Values of AI fields are exported like any text or select value (generating them again would spend quota).

**Format** (`format_version` 1): a zip file (ZIP64 when needed), UTF-8, holding **only** these entries:

```text
manifest.json                format, format_version, app_version, exported_at, exported_by_email,
                             base { id, name }, counts, checksums { "<entry>": "<SHA-256 hex>" }, limits
schema/base.json             the base and its settings; missing_ids (things the base referred to that
                             were in the trash or deleted)
schema/tables.json           tables and fields as stored (options by ID, formulas as [fld_…])
schema/views.json            shared views
schema/dashboards.json       dashboards and widgets
schema/automations.json      automations, each with detached: [{ path, kind, name }]
schema/roles.json            custom roles
data/<tbl_…>.ndjson          one record per line: id, times, creator emails, auto, parent_id, fields
links/<fld_…>.ndjson         one row per link: a, b, position
files/attachments.json       every file: id, kind, filename, mime, size, sha256, where it belongs
files/<att_…>                the content of each file
```

JSON and NDJSON entries are deflated; files that are already compressed (JPEG, PNG, WebP, PDF, zip, Office documents, video…) are stored as they are. `manifest.json` is written last and lists the SHA-256 of every other entry. The IDs in a package are those of the source base; **an import gives every table, field, option, view, dashboard, widget, automation, role, record and file a new ID** and rewrites every reference — formulas, filters, view settings, widgets, roles, automations, links, cells — by its structure, never by replacing text. Users appear only as emails, never as IDs.

## 4. Limits

| Limit | Value | Applies to |
| --- | --- | --- |
| Package size | `BASE_PACKAGE_MAX_BYTES`, **2 GiB** by default (1 MiB … 5 GiB − 1, below one S3 `PUT`) | Export (`PACKAGE_TOO_LARGE`) and import upload (`413`) |
| Uncompressed size of all entries | 4 × `BASE_PACKAGE_MAX_BYTES` | Import, and export (a package import would refuse is never written) |
| Compression ratio of one **NDJSON** entry (`data/*`, `links/*`) | ≤ 200 × its compressed size | Same |
| Compression ratio of one **JSON** entry or **file** | ≤ 20 × its compressed size | Same |
| Entries | ≤ 100,000 | Same |
| One JSON entry, uncompressed | ≤ 64 MiB | Same |
| One NDJSON line | ≤ 16 MiB | Same |
| Nesting of a JSON value | ≤ 64 levels | Same |
| Files | `ATTACHMENT_MAX_FILE_BYTES` of the target (100 MB by default) and its block list | Import (a file over it is left out and reported) |
| Fields, computed fields, views, dashboards, widgets | The usual limits of the target instance | Import (`INVALID_DEFINITION`) |
| Jobs | One export and one import per organization at a time; the next waits | Both |
| Download | One hour after the export ends | Export |

The **ratio rules** stop "zip bombs": a small package that would inflate to gigabytes. They are checked for every entry from the zip's directory before anything is read, and again while inflating. A real base compresses far less than the caps — the sample data of `pnpm seed:demo` compresses 9.6 × as a whole and 13.4 × for its largest data entry. When exporting, an entry that would compress more than 20 × (a JSON entry, or a file such as a repetitive log or CSV) is stored uncompressed instead, so the export does not fail.

**Remaining risk**: an NDJSON entry is never stored uncompressed (for a large table the package would outgrow its size cap), so **a table whose data compresses more than 200 × still fails the export** with `INVALID_PACKAGE` `ARCHIVE_LIMIT_EXCEEDED` (`params.reason = entry_ratio`). This happens only with extremely repetitive data — for example when every record carries the same long text (a pasted template of several kilobytes in a field of every row). Trim or vary the repeated value (or move it to a single record that the others link to), then export again.

**Temporary disk**: the worker writes the whole package to its temporary directory before storing it (export), and copies an uploaded package there before reading it (import): it needs free space of at least the package size. The directory is the operating system's (`TMPDIR`), cleaned after every job, even a failed one. For large bases, point `TMPDIR` of the worker at a volume with room.

**Time and memory** (`S9_BENCH=1 pnpm --filter @cellhive/api test:int test/int/s9-package.bench`, details in `docs/CONTRACTS.md` §9): records are read and written in pages and batches of 5,000 and files as streams, so memory does not grow with the base; time grows with records and file bytes. Measured on a laptop (Apple M3, 8 cores) with 200,000 records × 30 fields and 1 GB of files: a 1.06 GB package, the export job in about 25 s and the import job in about 55 s, temporary disk about the size of the package, and at most about 320 MB of memory in use after garbage collection for the API and the worker together.

## 5. The command line for large packages

A package larger than the upload limit — or one moved between instances without a browser — goes through the `cellhive` command line in the API container. It uses the same job code as the app (a worker must be running) and the same `BASE_PACKAGE_MAX_BYTES`, but no HTTP upload or download:

```bash
# Export: writes a new file (never overwrites), 0600.
docker compose exec api cellhive base export --base bse_… --out /tmp/sales.chbase
docker compose cp api:/tmp/sales.chbase ./sales.chbase

# Import into another instance: --as is the member who will own the base.
docker compose cp ./sales.chbase api:/tmp/sales.chbase
docker compose exec api cellhive base import --workspace wsp_… --file /tmp/sales.chbase --as owner@example.com
```

With the `minimal` profile the service is `app` instead of `api`. Both commands print the job ID, then its result as JSON (the export's file path, size and counts; the import's `base_id` and report); they exit with `1` when the job fails (with its error code) and `2` on wrong arguments. The export deletes its stored copy once the file is written; the import deletes the uploaded copy when the job ends. To export larger packages, raise `BASE_PACKAGE_MAX_BYTES` (up to 5 GiB − 1) and give the worker temporary disk; the web server accepts uploads up to 2 GB on the import route (`client_max_body_size 2g` in the bundled nginx), so packages above that go through the command line.

## 6. Security when importing someone else's package

A package is a file anyone can edit. Cellhive treats every package as untrusted:

- **Nothing is extracted by name.** Only the entries listed in §3 are read, and each one streams straight into a parser or into storage under a new key — a name with `..`, an absolute path, a backslash, a link, a folder, an encrypted entry or an unknown compression fails the import (`UNSAFE_ENTRY`); an unknown or duplicate name too (`UNKNOWN_ENTRY`, `DUPLICATE_ENTRY`).
- **Zip bombs** are refused by the limits of §4 before anything is read; sizes are counted while inflating, so a package that lies about them fails.
- **Checksums show changes, not origin.** Every entry's SHA-256 is recomputed and compared with the manifest (`CHECKSUM_MISMATCH`), which catches damage and careless edits — but whoever edits a package can rewrite the manifest too. A package is **not signed**: trust it as much as you trust the person who gave it to you.
- **Everything is validated like a manual change.** Field definitions, formulas (parsed and type-checked), filters, view settings, widgets, roles and automations go through the same checks as when a member saves them; SQL names come from the new base, never from the package. Anything the target refuses fails the import (`INVALID_DEFINITION`) and nothing is created.
- **Automations cannot run on arrival.** They are all off, run as you, and their secrets, sending identities, groups and webhooks are removed. Before turning one on, read what it does: where an **HTTP request** sends data, who an **email** or **Telegram** message goes to, what records it **updates**. Once on, the usual network protections of your organization apply (the HTTP allowlist and the private-address block).
- **Files are checked again.** Their type is detected from their content, the default block list (`.exe`, `.msi`, `.sh`, `.jar`, …) always applies whatever the package's field options say, and a file larger than your instance allows is left out. Imported files are served like any upload: to readers of their record only, as attachments with `nosniff`, never as a page of the app.
- **No access is granted.** You are the only owner; no member, group or role assignment comes from the package. Users are matched by email **only with members of your organization** — a package cannot learn who exists elsewhere on the instance, and the report never names an email that was not in the package.
- **Nothing half-built is visible.** The base stays hidden until the import ends; a failure removes it with its tables, data and files.

Recommended: import packages only from people you trust, into a workspace only admins can see; review the roles, automations and dashboards of the new base before adding members; turn automations on one at a time.

## 7. Compared with `pg_dump`

| | `.chbase` package | `pg_dump` (plus a copy of the file storage) |
| --- | --- | --- |
| Scope | One base | The whole instance: every organization, user, base, history, setting |
| Who | A base admin, in the app or through the API | The server's operator, with database access |
| Target | Any workspace, organization or instance of a compatible version | The same or a newer Cellhive version, as a whole |
| IDs | New IDs; references rewritten | Kept |
| Users | Matched by email in the target organization | Kept with their accounts and passwords |
| History, audit log, runs, trash | Not included | Included |
| Secrets, members, share links, tokens | Not included | Included (encrypted with `APP_MASTER_KEY`) |
| Consistency | Each page of records is a snapshot; changes during the export may or may not be in it | One transactional snapshot |
| Use it to | Move or copy a base, share a base as a template, keep a copy of one base | Back up and restore the instance (disaster recovery), move a whole instance |

A `.chbase` package is **not a backup of your instance**: keep regular `pg_dump` (or volume) backups of PostgreSQL and of the file storage, with `APP_MASTER_KEY` stored apart.

## 8. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| **Export base** is not in Base settings | Only base admins (and workspace/organization admins) see Base settings. |
| Export fails: "The base is too large for one package" (`PACKAGE_TOO_LARGE`) | The package would exceed `BASE_PACKAGE_MAX_BYTES`. Raise it (up to 5 GiB − 1) and use the command line (§5). |
| Export fails: "A part of the package compresses more than 200×" (`ARCHIVE_LIMIT_EXCEEDED`, `entry_ratio`) | A table's data is extremely repetitive (§4, remaining risk). Vary or remove the repeated value. |
| The download link answers `404` | It expired (one hour), you are no longer a base admin, or a token does not reach the base. Export again. |
| Upload refused: `413` | The package is larger than the instance accepts (the dialog names the limit), or than the web server's `client_max_body_size`. Use the command line. |
| Upload refused: `415` | The file name does not end in `.chbase`, or the request is not `multipart/form-data`. |
| Import stays "Waiting for another import" | One import per organization runs at a time; it starts when the other ends. |
| Import fails: `INVALID_PACKAGE` | The dialog (or `error.errors[]` of the job) lists up to 100 problems with their `path` in the package: `INVALID_ARCHIVE` (not a readable zip, cut short), `UNSAFE_ENTRY`, `UNKNOWN_ENTRY`, `DUPLICATE_ENTRY`, `MISSING_ENTRY`, `INVALID_ENTRY` (not the expected JSON, a value that does not fit its field), `CHECKSUM_MISMATCH` (changed after export), `UNSUPPORTED_FORMAT_VERSION`, `DANGLING_REFERENCE`, `INVALID_DEFINITION` (the instance refuses a formula, filter, view, widget, role or automation — `params.code` says why, e.g. a name already taken or a field limit), `ARCHIVE_LIMIT_EXCEEDED`. Nothing was created. |
| Import fails: `PERMISSION_DENIED` or `NOT_FOUND` | You can no longer create bases in the workspace, or it was deleted while the import waited. |
| An automation cannot be turned on: `422 AUTOMATION_INVALID` | A secret, identity, group or webhook it needs is not chosen yet (see **Set up again** in the report). |
| Cells of some people are empty | They are not members of this organization (**People not found**). |
