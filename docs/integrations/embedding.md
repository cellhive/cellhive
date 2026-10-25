# Embedding Cellhive in another website

This guide is for people who want to show a Cellhive dashboard, view or form **inside another website** (an intranet, a wiki, a status page) with an `<iframe>`, and for self-hosters who run the server that makes it possible.

- **What can be embedded**: only a share link that anyone can open, without password, with embedding turned on.
- **Allowed sites**: only the origins listed on the link may frame it; every other site is refused by the browser.
- **The embed code**, what the host page needs (its own Content Security Policy), and how it works behind the scenes.

Embedding is a way to *show* a share link, not a separate permission: everything [dashboards.md](dashboards.md) §9 says about share links (whose numbers, what visitors see) applies. The normative formats are in `docs/CONTRACTS.md` §16 (`settings.embed`) and §16A (**Nhúng**). The architecture is in ADR-38 §4. If this guide and those documents disagree, the contracts win. Please report the mismatch.

## Contents

1. [What can be embedded](#1-what-can-be-embedded)
2. [Turning embedding on](#2-turning-embedding-on)
3. [Allowed sites (origins)](#3-allowed-sites-origins)
4. [The embed code](#4-the-embed-code)
5. [The host page: Content Security Policy and other headers](#5-the-host-page-content-security-policy-and-other-headers)
6. [How it works (self-hosters)](#6-how-it-works-self-hosters)
7. [Security notes](#7-security-notes)
8. [Troubleshooting](#8-troubleshooting)
9. [Reference: limits](#9-reference-limits)

---

## 1. What can be embedded

The embeddable page is the share page with `?embed=1`:

```text
https://cellhive.example.com/s/<token>?embed=1
```

It shows the shared dashboard, view or form **without the share page's header and footer**, so it fits inside another page. Every other Cellhive page (the app, `/s/<token>` without `?embed=1`) refuses to be framed by any site.

A link can be embedded only when **all** of these hold:

| Condition | Why |
| --- | --- |
| **Who can open** = "Anyone with the link" (`audience = public`) | A link for people in the organization needs the Cellhive session cookie, which browsers do not send to a third-party frame. |
| **No password** | The password unlock is a cookie (`SameSite=Strict`) that never reaches a third-party frame. |
| **Allow embedding** is on, with **at least one allowed site** | Only listed origins may frame the page (§3). |
| The link works: not revoked, turned off, expired or blocked by the organization's `public_sharing` policy, and its creator still has access | Otherwise the page refuses to be framed (§6). |

The organization's policy decides whether public links exist at all: with "Only for forms", only form links can be public, hence embedded; with "Not allowed", nothing can be embedded.

All three link targets can be embedded: **dashboards** (read-only, with the filters, refresh and TV mode the link allows), **views** (grid or kanban, with the settings of the link) and **forms**.

---

## 2. Turning embedding on

Embedding is set on an existing link, in the share dialog:

1. Open the dashboard, view or form, choose **Share**, and create the link with **Anyone with the link** and no password (or change the existing link and save).
2. Open the **Embed** tab of the dialog.
3. Under **Sites that may embed the link**, type a site address (**Site address**, for example `https://intranet.example.com`) and choose **Add site**. Each change is saved at once.
4. Turn on **Allow embedding** ("The sites below can show the link in a frame").
5. Copy the **Embed code** (§4) and paste it into a page of a listed site.

The tab explains why the switch is disabled: "Only a link anyone can open can be embedded" (switch the link to public first) or "A link with a password cannot be embedded" (remove the password first). If you later switch an embedded link to the organization, or set a password, saving turns embedding off and the dialog says so before you save. Removing the last site while embedding is on turns it off too.

**The full link address is shown only once**, when the link is created. If you need the embed code later, paste the link address into **Link address** in the Embed tab (it must be this link's address), or create a new link: the code is then shown right away. Creating a new link changes the address, so update the pages that embed the old one.

**API.** Embedding is part of the link's settings (`settings.embed = { enabled, allowed_origins }`) and is changed with `PATCH /api/v1/share-links/:shareLinkId` from a **signed-in session** (managing share links never accepts an API token):

```json
{ "settings": { "embed": { "enabled": true, "allowed_origins": ["https://intranet.example.com"] } } }
```

`embed` is merged with the stored value, so sending only `allowed_origins` keeps `enabled`. Errors are `422 VALIDATION_FAILED` with a detail code:

| Detail code | Path | When |
| --- | --- | --- |
| `EMBED_NOT_SUPPORTED` | `settings.embed.enabled` | Turning embedding on (or keeping it on) for a link that is not public or has a password, including a `PATCH` that switches the audience or sets a password while embedding is on |
| `INVALID_ORIGIN` | `settings.embed.allowed_origins[i]` | An entry is not a valid origin (§3) |
| `INVALID_ORIGIN` | `settings.embed.allowed_origins` | Embedding on with no origin |

---

## 3. Allowed sites (origins)

An allowed site is an **origin**: scheme, host and optional port, nothing else.

| Accepted | Refused |
| --- | --- |
| `https://intranet.example.com` | `https://intranet.example.com/wiki` (path), `https://intranet.example.com?x=1` (query) |
| `https://intranet.example.com:8443` | `https://*.example.com` (wildcard) |
| `HTTPS://Intranet.Example.com/` (stored as `https://intranet.example.com`) | `http://intranet.example.com` (plain `http`) |
| `http://localhost:5173`, `http://127.0.0.1:8080`, `http://[::1]:3000`, **only when the server does not run with `NODE_ENV=production`** | `https://user@intranet.example.com` (user info), IP addresses in brackets other than `[::1]` |

- Origins are stored normalized: host in lower case, default port (`:443`) and trailing `/` removed, duplicates dropped.
- At most **20** sites per link.
- Each subdomain is its own origin: list `https://wiki.example.com` and `https://intranet.example.com` separately.
- The origin is that of the **page that contains the `<iframe>`**. If the frame is nested inside other frames, every ancestor must be listed (that is how `frame-ancestors` works).

---

## 4. The embed code

The Embed tab produces this code (with the link's address and name; this one is for a dashboard or view link):

```html
<iframe src="https://cellhive.example.com/s/<token>?embed=1"
  title="Orders overview"
  width="100%" height="600" style="border:0"
  loading="lazy" referrerpolicy="no-referrer"
  sandbox="allow-scripts allow-same-origin allow-downloads allow-popups allow-popups-to-escape-sandbox"
  allow="fullscreen"></iframe>
```

| Attribute | Why |
| --- | --- |
| `title` | The frame's accessible name for screen readers. Keep it meaningful. |
| `width`, `height`, `style` | Adjust to your page. The page inside scrolls when it is taller than the frame; on a narrow frame (under 1,024 px) a dashboard shows one column. |
| `loading="lazy"` | The frame loads when it comes near the screen. |
| `referrerpolicy="no-referrer"` | The token is in the address: the host page's address is not sent to Cellhive, and Cellhive's pages never send a `Referer` either. |
| `sandbox="…"` | A suggested sandbox, chosen by what the link shows (below). Never top-level navigation: the frame cannot replace your page. |
| `allow="fullscreen"` | Lets the dashboard's TV mode go full screen. |

The suggested sandbox depends on the link's target:

| Token | View | Form | Dashboard | Why |
| --- | --- | --- | --- | --- |
| `allow-scripts allow-same-origin` | yes | yes | yes | The Cellhive page itself runs and calls its own API. |
| `allow-downloads` | yes | yes | yes | CSV/PNG downloads (when the link allows them). |
| `allow-popups allow-popups-to-escape-sandbox` | yes | yes | yes | Links in URL cells, form descriptions and dashboard text widgets open in a new tab. They carry `rel="noopener noreferrer"`, so the new tab cannot reach the frame or your page; escaping the sandbox lets the linked site load normally instead of in a crippled sandboxed tab. |
| `allow-forms` | no | yes | no | Without it, browsers block the submission of a form inside a sandboxed frame, so the **Submit** button of an embedded form does nothing. |

You may remove tokens you do not need (for example the pop-up tokens if no external link matters), or drop `sandbox` entirely: the frame is cross-origin, so it cannot read or script your page in any case.

---

## 5. The host page: Content Security Policy and other headers

Cellhive decides **who may frame it** (its `frame-ancestors`). Your site decides **what it may frame**. If the host page sends a Content Security Policy, it must allow the Cellhive origin as a frame source:

```http
Content-Security-Policy: default-src 'self'; frame-src https://cellhive.example.com
```

- Use `frame-src` (or `child-src`; without either, `default-src` applies). Only the Cellhive origin is needed: the frame loads its scripts, styles and data from Cellhive itself, under Cellhive's own policy.
- If the host page sends `Permissions-Policy` with `fullscreen=(self)`, add the Cellhive origin (`fullscreen=(self "https://cellhive.example.com")`) for TV mode to go full screen.
- A host page with `Cross-Origin-Embedder-Policy: require-corp` or `credentialless` can only frame pages that opt in; Cellhive's share pages do not send `Cross-Origin-Embedder-Policy`/`Cross-Origin-Resource-Policy`, so such a page cannot embed them.
- Your own `X-Frame-Options` or `frame-ancestors` only control who may frame **your** page; they do not affect the Cellhive frame.

---

## 6. How it works (self-hosters)

The headers of the embeddable page depend on the link, so they are not static nginx headers:

1. The browser requests `/s/<token>?embed=1` (the token is exactly 43 characters, `embed` exactly `1`).
2. nginx of the `web` image rewrites the request to the API: `GET /api/v1/shares/<token>/page`.
3. The API answers an empty `200` with the page's headers and `X-Accel-Redirect: /_share/embed`:
   - The link works, is public, has no password and has embedding on with allowed origins → `Content-Security-Policy` of the web client with `frame-ancestors <allowed origins>` and **no** `X-Frame-Options`.
   - **Anything else** (unknown or revoked token, link off, expired, creator without access, rate limit, an error) → `frame-ancestors 'none'` and `X-Frame-Options: DENY`. The answer never contains data of the link.
4. nginx serves `share.html` from the internal location `/_share/embed` with those two headers plus the share page headers that do not depend on the link (`share-embed-headers.conf`: `nosniff`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, …) and `Cache-Control: no-store`.
5. The page then reads the link through `/api/v1/shares/<token>/…`, which checks the link on every request as usual.

Every other page keeps the static `frame-ancestors 'none'` and `X-Frame-Options: DENY`. `vite preview` behaves the same way by asking the API. The origins stored on the link are checked again before they go into the header.

What this means for a deployment:

- **Use the `web` image's nginx config** (or reproduce `infra/docker/web/default.conf.template`: the `$arg_embed` map, the rewrite, the `/_share/embed` location and `share-embed-headers.conf`). A front proxy that serves the web client without this rewrite makes every embed fail.
- **A reverse proxy in front** (Traefik, Caddy, a load balancer) must not add or override `X-Frame-Options` or `Content-Security-Policy` on `/s/`; a global `X-Frame-Options: DENY` there blocks every embed. It also must not strip the query string.
- **Development**: origins `http://localhost`, `http://127.0.0.1` and `http://[::1]` (any port) are accepted only when the API does not run with `NODE_ENV=production`.
- Requests to `/api/v1/shares/<token>/page` count toward the per-IP read limit of share links (20 requests/s); over the limit, the page is served un-frameable for that request.

---

## 7. Security notes

- **The link is public.** Anyone who views the source of the host page sees the token in the `<iframe>` and can open `https://cellhive.example.com/s/<token>` directly, outside your site. The allowed-origins list prevents **other sites from framing** the page (clickjacking, impersonation); it is not access control. Embed only what you would share with a public link.
- **Numbers follow the link creator.** An embedded dashboard shows the numbers of the person who created the link, with their current permissions ([dashboards.md](dashboards.md) §9.1). Create the link with an account whose access is what visitors may see.
- **To stop an embed**, turn embedding off (the frame is refused at the next load), turn the link off, or revoke it (`410` for everyone). Creating a new link changes the address, so the old embed stops working.
- Embedded pages are never indexed (`X-Robots-Tag: noindex, nofollow`) or cached (`no-store`), and send no `Referer`.

---

## 8. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| The frame says the site "refused to connect", or stays blank, and the browser console mentions `frame-ancestors` or `X-Frame-Options` | The host page's origin is not in the link's list (check scheme, subdomain and port), embedding is off, or the link is not public, has a password, is off, expired or revoked. Also check that the frame's `src` ends with `?embed=1`. |
| Same, although the settings look right | A proxy in front of Cellhive adds `X-Frame-Options` or its own CSP, or the deployment does not use the `web` image's nginx rewrite (§6). Look at the response headers of `/s/<token>?embed=1`. |
| The console mentions `frame-src` or `child-src` | The **host page's** CSP does not allow the Cellhive origin (§5). |
| The embedded form cannot be submitted | The `sandbox` attribute lacks `allow-forms` (code copied from an older version, or edited by hand). Copy the code again from the Embed tab of the form link (§4). |
| Links in the frame do nothing | The `sandbox` lacks `allow-popups allow-popups-to-escape-sandbox` (§4). |
| TV mode does not go full screen | Keep `allow="fullscreen"`; check the host page's `Permissions-Policy` (§5). |
| Downloads do nothing | Keep `allow-downloads` in the sandbox, and check that the link allows downloads. |
| `422 EMBED_NOT_SUPPORTED` | The link is for the organization or has a password (§1). |
| `422 INVALID_ORIGIN` | An origin with a path, wildcard, `http://` (outside development) or no origin at all while embedding is on (§3). |
| `http://localhost` is refused | The server runs with `NODE_ENV=production`. Use an `https` origin. |
| The frame was working, then is refused after a reload (or shows "This link is no longer available" while it stays open) | The link was revoked, turned off or expired, or its creator lost access: from then on the page is served with `frame-ancestors 'none'`, so the browser no longer shows it in a frame. |

---

## 9. Reference: limits

| Item | Value |
| --- | --- |
| Embeddable page | `/s/<token>?embed=1` only |
| Links that can be embedded | `audience = public`, no password, `settings.embed.enabled = true` |
| Allowed origins per link | 0–20 (at least 1 while embedding is on) |
| Origin format | `https://host[:port]`; `http://localhost`, `127.0.0.1`, `[::1]` only outside production |
| Headers when embeddable | `Content-Security-Policy: … frame-ancestors <origins>`, no `X-Frame-Options` |
| Headers otherwise | `frame-ancestors 'none'`, `X-Frame-Options: DENY` |
| Share page read limit (includes the embed header request) | 20 requests/s per IP |
| Managing share links (and embedding) | signed-in session only, never an API token |
