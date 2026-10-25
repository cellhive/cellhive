import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite';

import {
  CONTENT_SECURITY_POLICY,
  isSharePagePath,
  SECURITY_HEADERS,
  SHARE_EMBED_LINK_HEADERS,
  SHARE_EMBED_PAGE_HEADERS,
  SHARE_PAGE_HEADERS,
  shareEmbedTokenOf,
} from './security-headers.ts';

/**
 * Glide's overlay editor module, which glide imports lazily when the first
 * editor opens. The package does not export it: the grid imports it through
 * this alias to load it ahead of time (`src/grid/editors/preload.ts`). Same
 * file, so the same chunk as glide's own dynamic import.
 */
export const GLIDE_OVERLAY_EDITOR_ALIAS = {
  find: /^glide-overlay-editor$/u,
  replacement: join(
    dirname(createRequire(import.meta.url).resolve('@glideapps/glide-data-grid')),
    '../esm/internal/data-grid-overlay-editor/data-grid-overlay-editor.js',
  ),
};

/** The HTML of the share pages (T317): its own light entry, `src/share-main.tsx`. */
const SHARE_HTML = '/share.html';

/**
 * `vite preview` sends the headers nginx sends in production: the security
 * headers everywhere, and those of the share pages on `/s/*` and
 * `/verify-sender` (`infra/docker/web/*.conf`). Like nginx, those are served `share.html`
 * (in `pnpm dev` too) and every other path the app's `index.html`. An
 * embedded share page (`/s/:token?embed=1`, T809) takes its
 * `Content-Security-Policy` and `X-Frame-Options` from the API
 * (`GET /api/v1/shares/:token/page`), as nginx does through
 * `X-Accel-Redirect`; without an answer it may not be framed.
 */
async function embedLinkHeaders(target: string, token: string): Promise<Record<string, string>> {
  const fallback = {
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'X-Frame-Options': 'DENY',
  };
  try {
    const response = await fetch(`${target}/api/v1/shares/${token}/page`);
    if (!response.ok) return fallback;
    const headers: Record<string, string> = {};
    for (const name of SHARE_EMBED_LINK_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    return headers['Content-Security-Policy'] === undefined ? fallback : headers;
  } catch {
    return fallback;
  }
}

function previewHeaders(target: string): Plugin {
  const sharePage = (req: { url?: string | undefined }) => {
    if (!isSharePagePath(req.url ?? '')) return false;
    req.url = SHARE_HTML;
    return true;
  };
  return {
    name: 'cellhive-preview-headers',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        sharePage(req);
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const token = shareEmbedTokenOf(req.url ?? '');
        const headers = sharePage(req) ? SHARE_PAGE_HEADERS : SECURITY_HEADERS;
        if (token === null) {
          for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
          next();
          return;
        }
        void embedLinkHeaders(target, token).then((linkHeaders) => {
          const all = { ...SHARE_EMBED_PAGE_HEADERS, ...linkHeaders };
          for (const [name, value] of Object.entries(all)) res.setHeader(name, value);
          next();
        });
      });
    },
  };
}

/**
 * `pnpm dev` serves the SPA on :5173 and proxies `/api` and `/ws` to the API
 * (`VITE_API_TARGET`, default http://localhost:3000), so the browser sees one
 * origin and the session cookie works as in production behind nginx.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const target =
    process.env['VITE_API_TARGET'] ?? env['VITE_API_TARGET'] ?? 'http://localhost:3000';
  const proxy: Record<string, ProxyOptions> = {
    '/api': { target, xfwd: true },
    '/ws': { target, ws: true, xfwd: true },
  };
  return {
    plugins: [react(), tailwindcss(), previewHeaders(target)],
    resolve: { alias: [GLIDE_OVERLAY_EDITOR_ALIAS] },
    server: { port: 5173, strictPort: true, proxy },
    preview: { port: 4173, strictPort: true, proxy },
    build: {
      target: 'es2023',
      // Lets size-limit (`.size-limit.js`) find the chunks each route loads.
      manifest: true,
      // The app, and the public share pages as an entry of their own (T317).
      rollupOptions: { input: { main: 'index.html', share: 'share.html' } },
    },
  };
});
