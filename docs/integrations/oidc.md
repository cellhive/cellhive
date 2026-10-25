# Sign-in with OpenID Connect (OIDC)

This guide is for people who run a Cellhive instance and want users to sign in with an identity provider (IdP): Keycloak, Authentik, Google, Microsoft Entra ID, or any other OpenID Connect provider.

- **Configuration**: the `OIDC_*` environment variables, the redirect URI to register, and sample settings for four providers.
- **Accounts**: who may sign in, when accounts are created (JIT), how existing accounts are linked, and why linking by email is off by default.
- **Operations**: error codes users see, the break-glass command when the IdP is gone, an IdP inside your LAN, and troubleshooting.

Providers are configured **per instance** by the operator, never per organization: only the operator decides which IdPs are trusted, because one user account can belong to several organizations. Password sign-in always stays available. The normative formats are in `docs/CONTRACTS.md` §27, §12.1 and §6, and the environment list in `docs/SPEC.md` §20. The architecture is in ADR-36 §3. If this guide and those documents disagree, the contracts win. Please report the mismatch.

## Contents

1. [How it works](#1-how-it-works)
2. [Configuration](#2-configuration)
3. [Provider examples](#3-provider-examples)
4. [Who may sign in: accounts, JIT sign-up and domains](#4-who-may-sign-in-accounts-jit-sign-up-and-domains)
5. [Linking accounts](#5-linking-accounts)
6. [Error codes](#6-error-codes)
7. [Break-glass: when the IdP is unavailable](#7-break-glass-when-the-idp-is-unavailable)
8. [An IdP inside your network](#8-an-idp-inside-your-network)
9. [Troubleshooting](#9-troubleshooting)
10. [Reference: limits](#10-reference-limits)

---

## 1. How it works

1. The sign-in page lists one button per provider (`GET /api/v1/auth/providers`), labelled with `OIDC_<SLUG>_NAME`.
2. The button opens `GET /api/v1/auth/oidc/<slug>/start?next=<path>`. Cellhive creates a `state`, a `nonce` and a PKCE verifier (S256), stores them in a short-lived encrypted cookie `ob_oidc` (10 minutes, one use, `HttpOnly; SameSite=Lax; Path=/api/v1/auth/oidc/`), and redirects the browser to the IdP.
3. The IdP authenticates the person and redirects back to `GET /api/v1/auth/oidc/<slug>/callback?code=…&state=…`.
4. Cellhive checks the state cookie, exchanges the code (with the client secret, `client_secret_basic`, and the PKCE verifier), then validates the ID token: issuer, audience (`aud`, and `azp` when there are several audiences), expiry, `nonce`, `iat` within 5 minutes, and the signature with a key from the IdP's JWKS (RS*, PS*, ES* or EdDSA; never `none` or `HS*`).
5. The person is matched by **(provider, `sub`)**, never by email alone (§4). On success Cellhive opens a normal session (the same as a password sign-in) and redirects to `next` (internal paths only; anything else becomes `/`). On failure it redirects to `/login?error=<CODE>` (§6).

The library is `openid-client` v6. Calls to the IdP (discovery, token, JWKS) have a 10 s timeout. Discovery metadata and the JWKS are cached for 1 hour; the JWKS is reloaded at once when an ID token names an unknown key id (`kid`), so key rotation needs no restart.

Nothing secret is logged: not the `code`, the verifier, the `state`, the `nonce`, the tokens, the client secret or the cookie. Failures are logged with the provider, the error code and a reason (`discovery_failed`, `token_request_failed`, `id_token_invalid`, `jwks_failed`, `signature_invalid`), and counted in the metric `oidc_callbacks_total{provider, result}`.

---

## 2. Configuration

### 2.1 Variables

Add the providers to `.env`, then restart the `api` service. Every variable is read at start-up. A missing or invalid value **stops the API from starting**, with a message that names the variable (never its value).

| Variable | Default | Meaning and validation |
| --- | --- | --- |
| `OIDC_PROVIDERS` | empty (password only) | Comma-separated provider slugs, in button order. Each slug is `[a-z0-9-]{1,32}`, at most **10** providers, no duplicates. Variables of slugs not in this list are ignored. |
| `OIDC_<SLUG>_ISSUER` | required | The issuer URL. Cellhive reads `<issuer>/.well-known/openid-configuration`. Must be `https://` (`http://` only when `NODE_ENV=development`), without user info, query or fragment. A path is allowed (Keycloak realms, Authentik applications). |
| `OIDC_<SLUG>_CLIENT_ID` | required | Client id, at most 255 characters. |
| `OIDC_<SLUG>_CLIENT_SECRET` | required | Client secret of a **confidential** client, sent with HTTP Basic (`client_secret_basic`). At most 1,024 characters. Public clients are not supported. |
| `OIDC_<SLUG>_NAME` | the slug | Label of the button, at most 100 characters. |
| `OIDC_<SLUG>_SCOPES` | `openid email profile` | Scopes to request, separated by spaces and/or commas (duplicates are ignored). Must include `openid`. Keep `email`: without an email claim no account can be created or linked by email. |
| `OIDC_<SLUG>_ALLOW_SIGNUP` | `false` | `true` creates an account the first time an unknown person signs in, if the IdP says the email is verified (§4.2). `true` or `false` only. |
| `OIDC_<SLUG>_ALLOWED_DOMAINS` | any domain | Comma-separated email domains that new accounts may have (`example.com,example.vn`). Exact domains: `example.com` does **not** match `sub.example.com`. Applies only to creating accounts (§4.2). |
| `OIDC_<SLUG>_LINK_BY_EMAIL` | `false` | `true` lets a first sign-in attach to an existing account with the same email, if the IdP says the email is verified (§5.2). Read §5.2 before enabling it. |
| `OIDC_<SLUG>_AUTO_JOIN_ORG` | empty | Slug of an organization (`[a-z0-9-]{1,100}`) that **new** accounts of this provider join with the `member` role. If no organization has that slug, the account is created without it and a warning is logged. |

`<SLUG>` is the slug in upper case with `-` replaced by `_`: the slug `my-idp` is configured with `OIDC_MY_IDP_ISSUER`, `OIDC_MY_IDP_CLIENT_ID` and so on.

The template `.env.example` contains a commented example for a slug `keycloak`.

### 2.2 Redirect URI

Register this redirect URI (also called callback URL or "Valid redirect URI") at the IdP, exactly, for each provider:

```text
<PUBLIC_URL>/api/v1/auth/oidc/<slug>/callback
```

For example `https://cellhive.example.com/api/v1/auth/oidc/keycloak/callback`. It is built from `PUBLIC_URL`; if you change `PUBLIC_URL` or the slug, update the IdP. Linking an account from the profile (§5.1) returns to the **same** URI, so there is nothing else to register.

The IdP must send the browser back with a normal redirect (`GET`, the default `response_mode=query`). Do not configure `form_post`. Your reverse proxy must pass the `ob_oidc` cookie on `/api/v1/auth/oidc/`.

### 2.3 Example

```dotenv
OIDC_PROVIDERS=keycloak,google

OIDC_KEYCLOAK_ISSUER=https://sso.example.com/realms/acme
OIDC_KEYCLOAK_CLIENT_ID=cellhive
OIDC_KEYCLOAK_CLIENT_SECRET=change-me
OIDC_KEYCLOAK_NAME=Acme SSO
OIDC_KEYCLOAK_ALLOW_SIGNUP=true
OIDC_KEYCLOAK_ALLOWED_DOMAINS=acme.example
OIDC_KEYCLOAK_AUTO_JOIN_ORG=acme

OIDC_GOOGLE_ISSUER=https://accounts.google.com
OIDC_GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
OIDC_GOOGLE_CLIENT_SECRET=change-me
OIDC_GOOGLE_NAME=Google
```

Treat client secrets like passwords: keep them out of version control, and rotate them at the IdP if they leak.

---

## 3. Provider examples

Each example uses a slug; replace `cellhive.example.com` with your `PUBLIC_URL` host. The settings are named as the providers' admin consoles name them at the time of writing and may move between versions.

### 3.1 Keycloak

1. In your realm: **Clients → Create client**, type **OpenID Connect**, client id `cellhive`.
2. **Client authentication: On** (confidential client). **Standard flow: On**. Turn off the flows you do not need (implicit, direct access grants).
3. **Valid redirect URIs**: `https://cellhive.example.com/api/v1/auth/oidc/keycloak/callback`. **Web origins** can stay empty (Cellhive calls the token endpoint from the server).
4. **Credentials** tab: copy the client secret.
5. Make sure the client's default scopes include `email` and `profile` (they do by default).

```dotenv
OIDC_KEYCLOAK_ISSUER=https://sso.example.com/realms/acme
OIDC_KEYCLOAK_CLIENT_ID=cellhive
OIDC_KEYCLOAK_CLIENT_SECRET=…
OIDC_KEYCLOAK_NAME=Acme SSO
```

The issuer is the realm URL, without a trailing `/`. Keycloak older than version 17 has `/auth` in the path (`https://sso.example.com/auth/realms/acme`). Keycloak sends `email_verified` from the user's "Email verified" flag: if your realm lets users register or change their email without verifying it, those users get `email_verified: false` and Cellhive will not create or link accounts from their email (which is what you want).

### 3.2 Authentik

1. **Applications → Providers → Create → OAuth2/OpenID Provider**.
2. **Client type: Confidential**. Copy the client id and secret.
3. **Redirect URIs/Origins**: `https://cellhive.example.com/api/v1/auth/oidc/authentik/callback` (strict match).
4. **Signing Key**: choose a certificate (for example the self-signed one Authentik creates). Without a signing key, Authentik signs ID tokens with HS256 and the client secret, which Cellhive refuses (`OIDC_PROVIDER_ERROR`, reason `signature_invalid`).
5. Scopes: keep `openid`, `email`, `profile`.
6. **Applications → Create**, slug `cellhive`, attach the provider. The issuer is shown on the provider page as "OpenID Configuration Issuer".

```dotenv
OIDC_AUTHENTIK_ISSUER=https://auth.example.com/application/o/cellhive/
OIDC_AUTHENTIK_CLIENT_ID=…
OIDC_AUTHENTIK_CLIENT_SECRET=…
OIDC_AUTHENTIK_NAME=Authentik
```

Copy the issuer exactly as Authentik shows it, **including the trailing `/`**: the ID token's `iss` must match it character for character. Check what your Authentik version sends as `email_verified` (in the "email" scope mapping) before you turn on `LINK_BY_EMAIL` or `ALLOW_SIGNUP`: some versions send a fixed value rather than a real verification status.

### 3.3 Google

1. Google Cloud console → **APIs & Services → OAuth consent screen**: set it up (internal for a Google Workspace organization, external otherwise).
2. **Credentials → Create credentials → OAuth client ID**, application type **Web application**.
3. **Authorized redirect URIs**: `https://cellhive.example.com/api/v1/auth/oidc/google/callback`. Copy the client id and secret.

```dotenv
OIDC_GOOGLE_ISSUER=https://accounts.google.com
OIDC_GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
OIDC_GOOGLE_CLIENT_SECRET=…
OIDC_GOOGLE_NAME=Google
```

- Google needs `https` redirect URIs, except for `localhost` during development.
- `ALLOWED_DOMAINS` checks the **email domain** (for example `acme.example`). Cellhive does not read Google's `hd` (hosted domain) claim. A consumer Google account can be registered with an address of any domain once Google has verified the mailbox. If only your Google Workspace users may get accounts, make the consent screen **Internal** as well.
- Google confirms the mailbox, not who controls the domain over time. Keep `LINK_BY_EMAIL=false` unless every account that will sign in is managed by your Workspace.

### 3.4 Microsoft Entra ID (Azure AD)

1. Entra admin center → **App registrations → New registration**. Supported account types: usually **this organizational directory only** (single tenant).
2. **Redirect URI**: platform **Web**, `https://cellhive.example.com/api/v1/auth/oidc/entra/callback`.
3. **Certificates & secrets → New client secret**: copy the **value** (not the secret id). Note the expiry: Entra secrets expire, and sign-in fails with `OIDC_PROVIDER_ERROR` once it does.
4. **Token configuration → Add optional claim → ID → `email`** if your users' email is not otherwise in the token. Grant the `email` and `profile` permissions if asked.

```dotenv
OIDC_ENTRA_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
OIDC_ENTRA_CLIENT_ID=<application (client) id>
OIDC_ENTRA_CLIENT_SECRET=<secret value>
OIDC_ENTRA_NAME=Microsoft
OIDC_ENTRA_LINK_BY_EMAIL=false
```

- Use the tenant id (a GUID) in the issuer. The multi-tenant `common` and `organizations` endpoints do not have a fixed issuer, and the ID token's `iss` would not match.
- **Keep `LINK_BY_EMAIL=false`.** In Entra ID the `email` claim is not a verified, stable identifier: it can be unverified, a tenant admin (or, in some configurations, the user) can change it, and it can name a domain the tenant does not own. Trusting it to find an existing account is the "nOAuth" account takeover published in 2023: someone who controls any Entra tenant sets a victim's address as an account's email and signs in as the victim to apps that link by email. Cellhive matches identities by `(provider, sub)` and, by default, never by email.
- Cellhive creates or links an account from the email only when the ID token says `email_verified: true` (the JSON boolean). Entra ID tokens usually carry no such claim, so with Entra **JIT sign-up does not create accounts** (`OIDC_EMAIL_UNVERIFIED`). Invite people, let them create their account, then have them connect Microsoft under **Connected accounts** (§5.1). If you need JIT sign-up with Entra, put a broker that verifies emails (for example Keycloak with Entra as an identity provider) in front of it.

---

## 4. Who may sign in: accounts, JIT sign-up and domains

### 4.1 Matching

On each callback Cellhive looks, in this order:

| Case | Result |
| --- | --- |
| **(a)** The `(provider, sub)` identity is already connected to an account | Sign in as that account (refused with `UNAUTHENTICATED` if the account is disabled). The stored email of the connection is updated for display; a changed email or name at the IdP **never** moves the connection to another account. |
| **(b)** No such identity, but an account has the same email (case-insensitive) | `OIDC_ACCOUNT_EXISTS`: nothing is connected and no session is opened. The person signs in with their password and connects the provider in their profile (§5.1). Exception: `LINK_BY_EMAIL=true` (§5.2). |
| **(c)** No account at all | Create one if `ALLOW_SIGNUP=true` and the conditions of §4.2 hold, otherwise `OIDC_SIGNUP_DISABLED`. |

Organization membership never comes from the IdP: group or claim → role mapping, forcing SSO and turning off password sign-in are not supported.

### 4.2 JIT sign-up

With `OIDC_<SLUG>_ALLOW_SIGNUP=true`, a first sign-in of an unknown person creates an account when:

1. the ID token has a valid `email` **and** `email_verified` is the JSON boolean `true` (the string `"true"` does not count), otherwise `OIDC_EMAIL_UNVERIFIED`;
2. the email's domain (lower case, punycode) is **exactly** one of `ALLOWED_DOMAINS`, when that variable is set, otherwise `OIDC_DOMAIN_NOT_ALLOWED`. Subdomains do not match: list `acme.example,eu.acme.example` to allow both.

The new account has no password, its display name is `name`, else `preferred_username`, else the part of the email before `@` (at most 100 characters), and it uses the organization's language and time zone defaults. The creation is audited as `user.created` with `method: "oidc"`.

A new account belongs to **no organization**, unless:

- `OIDC_<SLUG>_AUTO_JOIN_ORG=<org slug>`: it joins that organization as `member` in the same step (audited `org_member.added`). Combine it with `ALLOWED_DOMAINS` so that only your domain gets in.
- Someone invites it: the person opens the invitation, chooses **Sign in as … to accept**, and signs in with the provider. The invitation's email must match the account's email.

`ALLOWED_DOMAINS` applies **only** to creating accounts. It does not restrict sign-in of accounts that already exist, nor linking (§5).

### 4.3 Typical set-ups

| Goal | Settings |
| --- | --- |
| Company IdP, everyone in the company may use Cellhive | `ALLOW_SIGNUP=true`, `ALLOWED_DOMAINS=<your domains>`, `AUTO_JOIN_ORG=<your org>` |
| Company IdP, access only by invitation | `ALLOW_SIGNUP=true`, `ALLOWED_DOMAINS=<your domains>`, no `AUTO_JOIN_ORG`: people get an account but see nothing until invited |
| IdP for existing users only | `ALLOW_SIGNUP=false` (default): people sign in with a password once and connect the provider (§5.1) |
| Public IdP (Google, Entra multi-tenant users) | `ALLOW_SIGNUP=false`, or `true` only with `ALLOWED_DOMAINS` |

---

## 5. Linking accounts

### 5.1 Connected accounts (manual linking)

Signed-in users open the user menu → **Connected accounts** (`/account/connections`; shown when at least one provider is configured). There they see their connections (provider, email reported by the IdP, last sign-in) and can **Connect** or **Disconnect** a provider.

- **Connect** calls `POST /api/v1/me/identities/<slug>/start` (session and CSRF token required; there is no `GET`, so another site cannot start a link in your session). It returns the IdP's authorization URL with **`max_age=0`**: the IdP must authenticate the person **again** instead of reusing an existing IdP session, which might belong to someone else on a shared browser.
- The callback accepts the link only for the **same** user and session that started it (signing out or switching users in between → `OIDC_STATE_INVALID`), and only if the ID token's `auth_time` is at most 10 minutes old (and not more than 5 minutes in the future). The browser returns to `/account/connections`, or `/account/connections?error=<CODE>` (§6). No new session is created.
- One connection per provider and account. A provider account already connected to another Cellhive user, or a second account of the same provider → `IDENTITY_IN_USE`.
- **Disconnect** (`DELETE /api/v1/me/identities/:id`) is refused with `LAST_LOGIN_METHOD` when the account has no password and this is its only connection, so nobody locks themselves out. Existing sessions stay signed in.
- Linking and unlinking are audited (`auth.identity_linked` with `method: "manual"`, `auth.identity_unlinked`). Tokens and API keys cannot use these routes (they are session only).

### 5.2 Linking by email (`LINK_BY_EMAIL=true`)

With `OIDC_<SLUG>_LINK_BY_EMAIL=true`, case (b) of §4.1 connects the identity to the existing account and signs in, when:

- the ID token says `email_verified: true` (JSON boolean), **and**
- the account is active (otherwise `UNAUTHENTICATED`), **and**
- the account has no other connection of the same provider (otherwise `OIDC_ACCOUNT_EXISTS`: email is never a second way in).

It is audited as `auth.identity_linked` with `method: "email"`.

Enable it **only** for an IdP that you control and that verifies every email it issues, and where users cannot set or change their own email (a company Keycloak with verified emails, for example). Whoever can make the IdP issue a token with `email_verified: true` for an address can then sign in as the Cellhive user with that address, **including owners and admins**. Never enable it for Entra ID (§3.4), for multi-tenant or public IdPs, or for an IdP where users register themselves.

### 5.3 Accounts without a password

Accounts created by OIDC have no password. For them:

- "Forgot password" sends nothing, and an administrator's password reset link answers `422 NO_PASSWORD`;
- they cannot disconnect their last provider (§5.1);
- the CLI can still set a first password (§7).

---

## 6. Error codes

After a failed sign-in the browser lands on `/login?error=<CODE>` and the page explains the code:

| Code | Meaning | Fix |
| --- | --- | --- |
| `OIDC_STATE_INVALID` | The state cookie is missing, expired (10 minutes), already used, or does not match: the sign-in took too long, was opened in another browser, the back button replayed it, or a proxy dropped the cookie | Start again. If it always fails, check that the reverse proxy forwards cookies on `/api/v1/auth/oidc/` and that `PUBLIC_URL` is the address users open. |
| `OIDC_PROVIDER_ERROR` | The IdP refused or failed (its `error_description` is never shown), discovery or the token request failed, or the ID token did not validate (issuer, audience, expiry, nonce, `iat` skew, signature) | Read the API log line for the provider: it has the reason and the library code (§9). |
| `OIDC_ACCOUNT_EXISTS` | An account with this email exists and is not connected to this provider identity | Sign in with the password, then **Connected accounts → Connect** (§5.1). |
| `OIDC_SIGNUP_DISABLED` | No account matches and `ALLOW_SIGNUP` is `false` | Invite the person, or enable sign-up (§4.2). |
| `OIDC_EMAIL_UNVERIFIED` | Sign-up is on, but the token has no email or `email_verified` is not `true` | Verify the email at the IdP, map the claim, or invite the person (§3.4 for Entra). |
| `OIDC_DOMAIN_NOT_ALLOWED` | Sign-up is on, but the email's domain is not exactly one of `ALLOWED_DOMAINS` | Add the domain (subdomains must be listed separately). |
| `UNAUTHENTICATED` | The Cellhive account is not active (disabled) | The same account cannot sign in with a password either. |
| `RATE_LIMITED` | More than 20 sign-in starts per minute from this IP address | Wait a minute. Behind a proxy, check `TRUSTED_PROXIES`, otherwise all users share the proxy's IP. |

After a failed **link** (§5.1) the browser lands on `/account/connections?error=<CODE>`, with `OIDC_STATE_INVALID`, `OIDC_PROVIDER_ERROR` or `IDENTITY_IN_USE`. The **Connect** button itself can fail with `429 RATE_LIMITED` (same 20 per minute per IP) or `503 DEPENDENCY_UNAVAILABLE` (the IdP's discovery did not answer).

Other answers of the routes: an unknown provider slug → `404`, a slug of the wrong form → `422`.

---

## 7. Break-glass: when the IdP is unavailable

If the IdP is down, misconfigured or gone, people who have a password still sign in with it. For accounts that sign in **only** with OIDC (including a sole owner), run on the server:

```bash
docker compose exec api cellhive user reset-password --email owner@example.com
```

(in a development checkout: `pnpm cellhive user reset-password --email owner@example.com`). The command prints a one-time link (valid 24 hours) that sets a password for **any** active account, including accounts without a password. The account's OIDC connections stay. The command is for operators with shell access to the server; it is not available over the API.

Before removing a provider from `OIDC_PROVIDERS`, make sure its users have a password or another connection; otherwise they need this command. Connections of a removed provider stay listed under its slug and can be disconnected.

---

## 8. An IdP inside your network

Cellhive calls the IdP from the **`api`** container (discovery, token, JWKS). These calls are deliberately allowed to reach private addresses, because the operator configures the URL (they do not go through the outbound HTTP allowlist used by automations). The **browser** also has to reach the IdP's authorization endpoint.

- **Use `https`.** `http://` issuers are accepted only with `NODE_ENV=development`. For a LAN IdP with an internal certificate authority, make Node in the `api` container trust it, for example by mounting the CA file and setting `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` for the `api` service.
- **One name for both sides.** The issuer URL must resolve from the `api` container **and** from users' browsers, and it must equal the `issuer` the IdP publishes (and puts in `iss`). Do not point Cellhive at an internal name (`http://keycloak:8080/...`) while the IdP advertises a public one: the issuer check fails. Configure the IdP's public hostname (Keycloak: `KC_HOSTNAME`), and if needed make that name resolve to the internal address inside Docker (split DNS or `extra_hosts`).
- **Development** (`NODE_ENV=development`): a local Keycloak on `http://localhost:8080/realms/dev` works. Remember that `localhost` inside the `api` container is the container itself.

---

## 9. Troubleshooting

Look at the API logs first: each failure logs the provider, the result code and a reason, plus the library's error code (`OAUTH_…`) and the IdP's OAuth `error` when there is one.

| Log reason / symptom | Cause and fix |
| --- | --- |
| API does not start, `OIDC_…: must be …` | A variable is missing or invalid (the message names it). `http://` issuer outside development, slug with upper case or `_`, more than 10 providers, scopes without `openid`, `true`/`false` misspelled, an `AUTO_JOIN_ORG` that is not a valid slug. |
| `discovery_failed` | The `api` container cannot fetch `<issuer>/.well-known/openid-configuration` within 10 s: DNS, firewall, TLS (untrusted CA, §8), or a wrong issuer path (`/realms/<realm>`, Authentik's trailing `/`, Keycloak's old `/auth`). Check with `docker compose exec api wget -qO- <issuer>/.well-known/openid-configuration`. |
| `token_request_failed`, OAuth error `invalid_client` | Wrong client secret, expired secret (Entra), or the client is public / uses another authentication method. Cellhive sends the secret with HTTP Basic. |
| `token_request_failed`, `invalid_grant` | The redirect URI registered at the IdP differs from `<PUBLIC_URL>/api/v1/auth/oidc/<slug>/callback`, or the code was already used or expired (a slow or repeated callback). |
| `id_token_invalid` with a claim comparison error | The ID token's `iss` differs from `OIDC_<SLUG>_ISSUER` (trailing slash, `common` tenant, internal vs. public host), or `aud` does not contain the client id. |
| `id_token_invalid`, `IAT_SKEW` | The ID token was issued more than **5 minutes** away from the API server's clock. Synchronize clocks with NTP on the IdP and the Cellhive host. |
| Link fails, `id_token_invalid`, `AUTH_TIME` | When connecting an account, the IdP did not return `auth_time`, or the authentication is older than 10 minutes: the IdP ignored `max_age=0` (re-authentication). Configure the IdP to include `auth_time` and honour `max_age`; check clocks too. |
| `signature_invalid`, `NO_MATCHING_KEY` | No key of the IdP's JWKS matches the token's `kid`, even after reloading the JWKS. After a key rotation this resolves itself on the next attempt; if not, check that `jwks_uri` in the discovery document is reachable from the `api` container. |
| `signature_invalid`, `UNSUPPORTED_JWS` | The token is signed with `HS256` (Authentik without a signing key, §3.2) or another algorithm Cellhive does not accept. Configure an RSA, EC or EdDSA signing key. |
| `jwks_failed` | The JWKS could not be fetched (network, TLS, more than 256 KB). |
| Users of one provider get `OIDC_ACCOUNT_EXISTS` | Expected with `LINK_BY_EMAIL=false`: they already have a password account. They connect the provider once (§5.1). |
| JIT sign-up never creates accounts | `email_verified` is missing or not `true` in the ID token (typical with Entra ID, §3.4), or the domain is not exactly listed. |

---

## 10. Reference: limits

| Item | Value |
| --- | --- |
| Providers per instance | ≤ 10, slug `[a-z0-9-]{1,32}` |
| State cookie `ob_oidc` | 10 minutes, one use, `Path=/api/v1/auth/oidc/` |
| `state`, `nonce`, PKCE verifier | 32 random bytes each, base64url |
| `next` | ≤ 2,048 characters, internal path only |
| Timeout of each IdP call | 10 s |
| Discovery and JWKS cache | 1 hour; JWKS reloaded on an unknown `kid` |
| `iat` skew | ≤ 300 s |
| `auth_time` when linking | ≤ 10 minutes old (≤ 300 s in the future) |
| Sign-in or link starts | 20 per minute per IP |
| Password reset link from the CLI | one use, 24 hours |
