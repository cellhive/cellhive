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

## Lucian UX/UI Prompt (UI elements)

`apps/web` contains code adapted from [Lucian UX/UI Prompt](https://lucianlabs.dev/uxui-prompt/) by Seokwoooo, licensed under the MIT License. It is copied source, not a package, so the dependency license check does not see it: each adapted file starts with the line `/*! Lucian UX/UI Prompt #ID · MIT License (c) 2026 Seokwoooo · … */` (`apps/web/test/lucian-license.test.ts` checks it). The build may drop such comments, so the web image also serves the license text under `/licenses/lucian-uxui-prompt-MIT.txt` (from `apps/web/licenses/`). Elements were fetched with the `lucian-uxui` skill 1.2.0 (catalog `34c4b3e61d`) and adapted to Cellhive's design tokens (`docs/FRONTEND.md` §9.3).

| Element                           | Id   | Element hash | Adapted in                                                                                                                |
| --------------------------------- | ---- | ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Theme tokens and `.ux` base rules | —    | —            | `apps/web/src/styles/lucian.css`                                                                                          |
| CSV field mapper                  | #130 | `a0a6df398c` | `apps/web/src/features/import/components/FieldMapper.tsx`, `FieldMapper.css`                                              |
| Bulk selection dock               | #178 | `d65e7c7e70` | `apps/web/src/features/grid/bulk/SelectionDock.tsx`, `SelectionDock.css`                                                  |
| Condition branch builder          | #132 | `c010ef189c` | `apps/web/src/features/automation/builder/components/conditions/ConditionBranchBuilder.tsx`, `ConditionBranchBuilder.css` |
| Event replay tape                 | #191 | `1f44267b9d` | `apps/web/src/features/automation/runs/components/RunTape.tsx`, `RunTape.css`                                             |

```text
MIT License

Copyright (c) 2026 Seokwoooo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## CodeMirror (formula editor)

`apps/web` bundles [CodeMirror 6](https://codemirror.net/) (`@codemirror/state`, `@codemirror/view`, `@codemirror/autocomplete`, `@codemirror/commands` and their dependencies `@codemirror/language`, `@lezer/*`, `style-mod`, `w3c-keyname`, `crelt`, `@marijn/find-cluster-break`), all licensed under the MIT License, loaded only when the formula editor is opened (BACKLOG S4b open question #9).
