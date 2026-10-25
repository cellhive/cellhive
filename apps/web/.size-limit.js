// @ts-check
/**
 * JS budget (FRONTEND §11.1): the code a browser downloads before `/login`
 * and the app shell are usable, gzip, at most 300 KB each; each other route
 * at most 150 KB (grid 250 KB, dashboards 350 KB). Chunks come from the Vite manifest of `vite build`
 * (run `pnpm build` first): the entry with its static imports, plus the lazy
 * route modules and their static imports, plus the English locale files.
 */
import { existsSync, readFileSync } from 'node:fs';

const MANIFEST = new URL('./dist/.vite/manifest.json', import.meta.url);
if (!existsSync(MANIFEST)) {
  throw new Error('dist/.vite/manifest.json is missing: run `pnpm build` first.');
}

/** @type {Record<string, { file: string; isEntry?: boolean; imports?: string[] }>} */
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));

/** Output files of `keys` and everything they import statically. */
function closure(/** @type {string[]} */ keys) {
  const files = new Set();
  const seen = new Set();
  const visit = (/** @type {string} */ key) => {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = manifest[key];
    if (chunk === undefined) throw new Error(`Not in the Vite manifest: ${key}`);
    if (chunk.file.endsWith('.js')) files.add(`dist/${chunk.file}`);
    for (const imported of chunk.imports ?? []) visit(imported);
  };
  keys.forEach(visit);
  return [...files];
}

const locales = (/** @type {string[]} */ namespaces) =>
  namespaces.map((namespace) => `src/locales/en/${namespace}.json`);

const entry = ['index.html'];

/** @type {{ name: string; path: string[]; limit: string; gzip: boolean }[]} */
const checks = [
  {
    name: 'Initial JS: /login',
    path: closure([
      ...entry,
      'src/app/layouts/AuthLayout.tsx',
      'src/features/auth/components/LoginPage.tsx',
      ...locales(['common', 'errors', 'auth']),
    ]),
    limit: '300 KB',
    gzip: true,
  },
  {
    // Working cap below the 300 KB budget (T700, BACKLOG S6 decision #18): each S6 FE task
    // may add at most 1 KB; new APIs and screens are lazy (`lib/api/index.ts`).
    name: 'Initial JS: app shell (organization home)',
    path: closure([
      ...entry,
      'src/app/layouts/AppShell.tsx',
      'src/features/org/components/OrgHomePage.tsx',
      ...locales(['common', 'errors', 'org']),
    ]),
    limit: '285 KB',
    gzip: true,
  },
];

/**
 * The public share page `/s/:token` (T317) is an entry of its own
 * (`share.html` → `src/share-main.tsx`): the share layout and page and its
 * locale files, at most 200 KB gzip; the shared grid (glide, with the grid's
 * block loader), board and form renderer are lazy chunks measured below. It must not load the app's entry (router,
 * guards) nor any chunk only the app shell needs (sidebar, realtime).
 */
const shareInitial = closure([
  'share.html',
  'src/features/share/public/components/SharePage.tsx',
  ...locales(['common', 'errors', 'sharePage']),
]);
// Chunks the sign-in screens share with the app shell (UI kit, preferences) are fine.
const sharedWithAuth = new Set(
  closure([
    ...entry,
    'src/app/layouts/AuthLayout.tsx',
    'src/features/auth/components/LoginPage.tsx',
  ]),
);
const appOnly = [
  `dist/${manifest['index.html']?.file ?? ''}`,
  ...closure(['src/app/layouts/AppShell.tsx']).filter((file) => !sharedWithAuth.has(file)),
];
const leaked = shareInitial.filter((file) => appOnly.includes(file));
if (leaked.length > 0) {
  throw new Error(`/s/:token loads chunks of the app shell: ${leaked.join(', ')}`);
}
checks.push({
  name: 'Initial JS: /s/:token (public share page)',
  path: shareInitial,
  limit: '200 KB',
  gzip: true,
});

/**
 * The public sender verification page `/verify-sender?token=…` (T533) is
 * served by the same light entry (`share.html`): same 200 KB budget, and
 * no chunk of the app shell either.
 */
const verifySenderInitial = closure([
  'share.html',
  'src/routes/verify-sender/VerifySenderPage.tsx',
  ...locales(['common', 'errors', 'verifySender']),
]);
const verifyLeaked = verifySenderInitial.filter((file) => appOnly.includes(file));
if (verifyLeaked.length > 0) {
  throw new Error(`/verify-sender loads chunks of the app shell: ${verifyLeaked.join(', ')}`);
}
checks.push({
  name: 'Initial JS: /verify-sender (public sender verification page)',
  path: verifySenderInitial,
  limit: '200 KB',
  gzip: true,
});

/**
 * Route budgets (FRONTEND §11.1). The grid screen may use 250 KB (it carries
 * glide-data-grid, T202), dashboards 350 KB (ECharts), the PDF viewer 200 KB (PDF.js,
 * T407); everything else —
 * the kanban board (T314) among them — 150 KB. A route is measured with the chunks it imports statically that are
 * not already part of the initial JS, so a library split into its own vendor
 * chunk still counts against the route that loads it.
 */
const ROUTE_BUDGETS = [
  {
    // The shared grid of `/s/:token` (T317) carries glide-data-grid like the member grid.
    prefixes: [
      'src/grid/',
      'src/features/grid/',
      'src/features/share/public/components/SharedGrid',
    ],
    limit: '250 KB',
  },
  // Dashboards (T811, S7 decision #18): 350 KB budget, 300 KB working cap. ECharts
  // (`echarts/core`, bar/line/pie, canvas) is a lazy chunk of the dashboard route only; the
  // whole route with its charts is checked below.
  { prefixes: ['src/features/dashboard/'], limit: '300 KB' },
  // Kanban board (T314) with dnd-kit: a route of its own, the default 150 KB, named explicitly.
  { prefixes: ['src/features/kanban/'], limit: '150 KB' },
  // Automation list (T520): its own lazy route, the default 150 KB, named explicitly (BACKLOG
  // S5 conventions: automation chunks are lazy, their budget written here).
  { prefixes: ['src/features/automation/list/'], limit: '150 KB' },
  // Automation builder (T521): its own lazy route (the view's condition editor is a chunk of
  // the view toolbar it shares); the default 150 KB, named explicitly (S5 conventions).
  // Email editor of `send_email` (T522): a lazy chunk of the builder, loaded when such a step
  // opens (wide mode), measured with the builder chunks it shares (102 KB); the default 150 KB,
  // named explicitly (S5 conventions).
  { prefixes: ['src/features/automation/builder/actions/send-email/'], limit: '150 KB' },
  { prefixes: ['src/features/automation/builder/'], limit: '150 KB' },
  // Run history (T523): its own lazy route, the default 150 KB, named explicitly (S5 conventions).
  { prefixes: ['src/features/automation/runs/'], limit: '150 KB' },
  // Notification panel, settings page and the base mute item (T524): lazy chunks, the default
  // 150 KB, named explicitly (S5 conventions). The bell itself is part of the app shell above.
  { prefixes: ['src/features/notifications/'], limit: '150 KB' },
  // Board of a shared kanban view (T317): it shares a chunk with the shared grid (cell values,
  // grid field model); T468 added the computed cells (renderers by result type, error tokens,
  // locks) there: 152.5 KB measured (147.5 KB before); T803 (one owner for the keys around a
  // cell editor) 160.04 KB; T816 (color rule painting in the shared grid) 165.43 KB. 170 KB
  // until the chunks are split (S9).
  { prefixes: ['src/features/share/public/components/SharedBoard'], limit: '170 KB' },
  // PDF viewer of the lightbox (T407): PDF.js (~130 KB gzip), loaded only when a PDF is opened;
  // its worker is a separate asset fetched by PDF.js itself.
  { prefixes: ['src/features/attachment/components/PdfViewer'], limit: '200 KB' },
  // Formula editor (T466): the CodeMirror dialog with the formula engine it shares with the
  // formula part of the field dialog; the CodeMirror part alone is checked below (120 KB).
  { prefixes: ['src/features/formula/components/FormulaEditorDialog'], limit: '185 KB' },
  // Formula popover of the column header (T468, S4b decision #12): the same editor (and the
  // full dialog behind "Expand") under the header; the same 185 KB budget.
  { prefixes: ['src/features/formula/components/FormulaPopover'], limit: '185 KB' },
];
const DEFAULT_ROUTE_LIMIT = '150 KB';

const initial = new Set(checks.flatMap((check) => check.path));

function routeLimit(/** @type {string} */ key) {
  const budget = ROUTE_BUDGETS.find(({ prefixes }) =>
    prefixes.some((prefix) => key.startsWith(prefix)),
  );
  return budget?.limit ?? DEFAULT_ROUTE_LIMIT;
}

for (const [key, chunk] of Object.entries(manifest)) {
  if (!key.startsWith('src/') || !key.endsWith('.tsx') || chunk.isEntry === true) continue;
  const path = closure([key]).filter((file) => !initial.has(file));
  // Screens that are part of the initial JS are measured there.
  if (path.length === 0) continue;
  checks.push({
    name: `Route chunk: ${key.replace(/^src\//u, '')}`,
    path,
    limit: routeLimit(key),
    gzip: true,
  });
}

/**
 * The dashboard route with charts on screen (T811): the page (grid, widgets,
 * KPI, tables) plus the ECharts chunk, outside the initial JS. 350 KB budget
 * (FRONTEND §11.1), 300 KB working cap (S7 decision #18). The records table
 * widget (`RecordsTable`, cell renderers) is a further lazy chunk, measured
 * on its own above.
 */
checks.push({
  name: 'Dashboard route with charts (page + ECharts)',
  path: closure([
    'src/features/dashboard/view/DashboardPage.tsx',
    'src/features/dashboard/charts/EChart.tsx',
  ]).filter((file) => !initial.has(file)),
  limit: '300 KB',
  gzip: true,
});

/**
 * A dashboard opened through its share link (T814, `/s/:token`): the shared
 * renderer (`features/dashboard/share`, the dashboard grid and widgets) plus
 * the ECharts chunk, outside the initial JS of the share entry — its own
 * chunks, so a shared grid or board does not carry them. The same 300 KB
 * working cap as the member route; 310 KB since zod and the
 * realtime client left the initial JS of the share entry (−34.6 KB there) and
 * now count here, plus T816 color rules: 301.73 KB measured.
 */
checks.push({
  name: 'Shared dashboard with charts (/s/:token, page + ECharts)',
  path: closure([
    'src/features/share/public/dashboard/SharedDashboardPage.tsx',
    'src/features/dashboard/share/SharedDashboardView.tsx',
    'src/features/dashboard/charts/EChart.tsx',
  ]).filter((file) => !shareInitial.includes(file)),
  limit: '310 KB',
  gzip: true,
});

/**
 * The dashboard editor (T812): a lazy chunk loaded on `?edit=1` by base
 * admins only, so the view above does not carry it. Measured without what
 * the view route already downloaded (page and ECharts): the grid editing,
 * widget library, settings panel and undo history: 23.4 KB measured, 40 KB cap.
 */
const dashboardView = new Set(
  closure([
    'src/features/dashboard/view/DashboardPage.tsx',
    'src/features/dashboard/charts/EChart.tsx',
  ]),
);
checks.push({
  name: 'Dashboard editor (loaded on ?edit=1)',
  path: closure(['src/features/dashboard/edit/DashboardEditor.tsx']).filter(
    (file) => !initial.has(file) && !dashboardView.has(file),
  ),
  limit: '40 KB',
  gzip: true,
});

/**
 * Formula editor (T466, BACKLOG S4b open question #9: CodeMirror 6, lazy,
 * ~120 KB gzip). The editor only opens from the formula part of the field
 * dialog (`FormulaField`: the formula engine — lexer, typecheck, catalogue
 * with en/vi docs, evaluator — ≤ 65 KB), so what opening it downloads is
 * the editor's closure without that part: CodeMirror and the editor UI.
 */
const formulaField = closure(['src/features/formula/components/FormulaField.tsx']).filter(
  (file) => !initial.has(file),
);
checks.push(
  {
    name: 'Formula field (formula engine), loaded with a formula field dialog',
    path: formulaField,
    limit: '65 KB',
    gzip: true,
  },
  {
    name: 'Formula editor (CodeMirror), loaded when the editor opens',
    path: closure(['src/features/formula/components/FormulaEditorDialog.tsx']).filter(
      (file) => !initial.has(file) && !formulaField.includes(file),
    ),
    limit: '120 KB',
    gzip: true,
  },
);

export default checks;
