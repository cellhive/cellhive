# Third-party notices

Cellhive bundles the following third-party data. Source code dependencies are listed in `pnpm-lock.yaml` and checked against the license allowlist in `docs/SPEC.md` §1A.

## Common password list

`apps/api` ships a filtered list (entries of 10 characters or more) derived from `Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt` in [SecLists](https://github.com/danielmiessler/SecLists) (commit `1a7bb91`), licensed under the MIT License. SecLists attributes the underlying list to the UK National Cyber Security Centre (NCSC), which built it from breach data published by Have I Been Pwned.

## PostgreSQL unaccent rules

`packages/filter-dsl` contains a table generated from `unaccent.rules` of PostgreSQL 18, distributed under the PostgreSQL License.

## Fonts

`apps/web` bundles (self-hosted, never loaded from a CDN) the font files of [Be Vietnam Pro](https://github.com/bettergui/BeVietnamPro) (`@fontsource/be-vietnam-pro`) and [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) (`@fontsource/jetbrains-mono`), both licensed under the SIL Open Font License 1.1. The license texts ship in each package and are served by the web image under `/licenses/`; OFL-1.1 is allowed for these font packages only (`tools/ci/license-policy.json`).

## libvips (image thumbnails)

`apps/worker` renders attachment thumbnails with [sharp](https://github.com/lovell/sharp) (Apache-2.0), which loads the prebuilt [libvips](https://github.com/libvips/libvips) shared library of the `@img/sharp-libvips-*` packages, licensed under the GNU Lesser General Public License 3.0 or later. The library is dynamically linked and unmodified: it can be replaced by another build of the same version (see the sharp documentation on custom libvips). Its source and the licenses of the libraries it bundles are published by the [sharp-libvips](https://github.com/lovell/sharp-libvips) project; the package ships them in its `THIRD-PARTY-NOTICES.md`.

## PDF.js (PDF viewer)

`apps/web` bundles [PDF.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`, the library and its worker), licensed under the Apache License 2.0, loaded only when a PDF attachment is opened in the viewer.

## CodeMirror (formula editor)

`apps/web` bundles [CodeMirror 6](https://codemirror.net/) (`@codemirror/state`, `@codemirror/view`, `@codemirror/autocomplete`, `@codemirror/commands` and their dependencies `@codemirror/language`, `@lezer/*`, `style-mod`, `w3c-keyname`, `crelt`, `@marijn/find-cluster-break`), all licensed under the MIT License, loaded only when the formula editor is opened (BACKLOG S4b open question #9).
