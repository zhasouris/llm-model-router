# ADR 0016 — Inspector Auth: Google Sign-In for `/demo`, Anonymous `/v1/router/explain`

- **Status:** Accepted (not yet implemented)
- **Date:** 2026-07-23
- **Context repo:** `corgi-ai-gateway`

## Context

The gateway has **two audiences with two different auth needs**:

- **Machines** call the proxy (`/v1/chat/completions`, `/v1/models`, …). These are guarded by
  OAuth 2.0 **client-credentials** bearer JWTs ([ADR 0015](0015-client-credentials-auth.md)) —
  the right model for service-to-service calls.
- **Humans** open the **decision inspector** — the `/demo` page and the `/v1/router/explain`
  endpoint its JavaScript calls. These are registered *ahead* of the bearer guard and, when
  `demo.enabled` is on, are **completely public** ([ADR 0002](0002-router-header-contract.md),
  [app.ts](../../src/app.ts)).

Two problems with the status quo now that the deployment is a **full proxy with real provider
keys** ([llm-router live deploy]):

1. The `/demo` **page** should not be an anonymous surface on a public, token-spending
   deployment — it deserves a real human sign-in.
2. `/v1/router/explain` is currently a *demo-internal* route — registered only when
   `demo.enabled`, called only by the page's JavaScript, and **absent from the OpenAPI spec**
   (which is why it does not appear in the deployed Swagger). But `explain` is genuinely useful
   on its own: it runs the full routing pipeline and returns the decision trace **without
   forwarding a completion**. It should be a *standard*, documented, always-available endpoint —
   not a hidden demo helper.

These pull in **different directions for the two routes**, so we treat them separately rather
than gating both the same way.

## Decision

**Gate the `/demo` page with "Sign in with Google" (interactive OIDC). Promote
`/v1/router/explain` to a standard, documented, anonymous endpoint — no auth on either the
machine plane or the human plane.**

### 1. Three planes, cleanly separated

| Surface | Who | Mechanism | ADR |
|---|---|---|---|
| `/v1/chat/completions`, `/v1/models`, `/v1/router/{models,providers}` | machines | client-credentials bearer JWT | 0015 |
| `/demo` | humans | Google sign-in + session cookie | **this** |
| `/v1/router/explain` | **anyone** | **none — standard anonymous endpoint** | **this** |
| `/healthz` | anyone | none | — |

The planes never mix. A browser session does not grant proxy access; a machine bearer token does
not grant `/demo` access; and `explain` needs neither.

### 2. `/v1/router/explain` becomes standard and anonymous

- **Always registered**, decoupled from `demo.enabled` — it is part of the API, not a demo
  helper. (It still needs the server-side classifier key to produce real signals; without one it
  degrades, as today.)
- **Anonymous** — registered *ahead* of the bearer guard (so no machine token) and **not** behind
  the Google session gate. Any client, human or machine, can call it with no credentials.
- **Documented** — added to [`src/openapi.ts`](../../src/openapi.ts) so it appears in the deployed
  Swagger, with its request shape (OpenAI-style body + `X-Router-*` option headers) and the
  decision-trace response (including the `X-Router-Model` / `X-Router-Reason` / `X-Router-Duration`
  headers, [ADR 0002](0002-router-header-contract.md)).

**Accepted cost/abuse trade-off:** an anonymous `explain` spends **one classifier LLM call per
request** (fractions of a cent) and can be called by anyone. It **never forwards a completion**,
so it cannot trigger a real model call, and throughput is bounded by `maxReplicas`. We accept
this as the price of a genuinely public, credential-free decision-explanation endpoint. If abuse
materialises, the mitigation is rate-limiting or a heuristic-only (classifier-off) explain mode —
not adding auth, which would defeat the "standard and anonymous" intent.

### 3. `/demo` behind Google sign-in (authorization-code, signed-cookie session)

Three new routes on the gateway:

- **`GET /auth/login`** — generate `state` + `nonce`, redirect to Google's authorize endpoint
  (`scope=openid email profile`).
- **`GET /auth/callback`** — verify `state`, exchange the code, verify the ID token (Google's
  JWKS, `iss`, `aud` = our client id, `nonce`, `exp`), set a **signed session cookie**, redirect
  to `/demo`.
- **`GET /auth/logout`** — clear the session cookie.

The session is a **stateless, HMAC-signed cookie** (signed with `SESSION_SECRET`), `HttpOnly`,
`Secure`, `SameSite=Lax`, short TTL, carrying only `sub` / `email` / `exp` — no server-side store,
so the container stays stateless and scale-to-zero. A `requireSession` middleware guards **`/demo`
only**; a missing/invalid/expired cookie redirects to `/auth/login`. Because the page's `explain`
calls are anonymous, the page still functions the moment the user is signed in — no token
threading between page and endpoint.

### 4. Any Google account is allowed in (for now)

Access policy for `/demo`: **any account that can sign in with Google passes.** Its purpose is to
remove anonymous access to the *page* and attach an identity (`email`) to inspector usage, not to
restrict to an org. It is deliberately loose, and a **single config knob**, so tightening later is
config, not a redesign:

```yaml
# config/server.yaml
demo:
  auth:
    enabled: true
    allowed_emails: []     # empty = any Google account; else an allowlist
    allowed_domain: ""     # optional Google Workspace 'hd' claim, e.g. "example.com"
```

### 5. Generic OIDC; the Google client is created by hand

Reuse the ADR 0015 OIDC discipline (discovery document → JWKS, verify `iss`/`aud`/`exp`). Google's
endpoints come from `https://accounts.google.com/.well-known/openid-configuration`; only the
client id/secret are Google-specific. New config/secrets: `GOOGLE_CLIENT_ID` (non-secret),
`GOOGLE_CLIENT_SECRET` (secret), `SESSION_SECRET` (secret) — wired through `.env` → `deploy.ps1` →
`app.bicep` like the existing secrets, never committed.

Unlike the Entra registration ([`setup-oauth.ps1`](../../deploy/azure/setup-oauth.ps1)), a Google
**OAuth 2.0 Web application** client and its consent screen are created in the **Google Cloud
Console** (`gcloud` cannot fully create them). Manual prerequisite:

- Google Cloud project → OAuth consent screen (External).
- Credentials → OAuth client ID → **Web application**.
- **Authorized redirect URI** = `<deployment-origin>/auth/callback`, e.g.
  `https://llmrouter-app.purplehill-bc78c3f6.eastus2.azurecontainerapps.io/auth/callback`.

## Consequences

**Positive**

- The `/demo` page is no longer anonymous on a public deployment; each session has a real identity
  (`email`) for basic attribution.
- `/v1/router/explain` is now a **first-class, documented, credential-free** endpoint — anyone (a
  script, a notebook, a curious user) can get a full routing decision trace with a single request,
  and it shows up in Swagger.
- Right tool per audience: humans sign in for the page, machines present tokens for the proxy, and
  the read-only `explain` needs nothing.
- Stateless signed-cookie sessions keep the container scale-to-zero; reuses the ADR 0015 OIDC
  verification discipline (no new auth paradigm).

**Negative / accepted trade-offs**

- **Anonymous `explain` spends money.** One classifier call per request, callable by anyone,
  bounded only by `maxReplicas`. Accepted deliberately (see §2); mitigation if needed is
  rate-limiting or a heuristic-only mode, not auth.
- **"Any Google account" is a weak gate** on `/demo` — stops drive-bys and adds attribution, but
  anyone with a Google account gets in until `allowed_emails`/`allowed_domain` is set. One-line
  config change to tighten.
- **Manual Google Cloud Console step**, not automatable like the Entra side.
- **The redirect URI is pinned to the deployment hostname.** Container Apps' generated suffix
  changes on teardown/redeploy, breaking sign-in until the Google client's redirect URI is
  updated (same fragility already noted for published links in the deploy README).
- **New session-management surface** — cookies, `state`/`nonce`, a `SESSION_SECRET` to hold and
  rotate — more moving parts than the stateless bearer check.
- **Interactive login only** for `/demo`; there is no headless path to the *page*. Headless
  consumers use the anonymous `explain` endpoint directly instead.

## Follow-ups / TODO

- [ ] Move `/v1/router/explain` out of the `if (demo.enabled)` block in
      [`src/app.ts`](../../src/app.ts) — register it unconditionally, ahead of the bearer guard,
      with no auth.
- [ ] Add `/v1/router/explain` to [`src/openapi.ts`](../../src/openapi.ts) (request body + option
      headers + decision-trace response and `X-Router-*` headers).
- [ ] `/auth/login`, `/auth/callback`, `/auth/logout` routes + `requireSession` middleware (new
      `src/google-auth.ts`), gating **`/demo` only**.
- [ ] Config schema `demo.auth.{enabled,allowed_emails,allowed_domain}`; env overrides
      `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `SESSION_SECRET`.
- [ ] Signed-cookie session helper (HMAC via `SESSION_SECRET`); `HttpOnly`/`Secure`/`SameSite=Lax`.
- [ ] Deploy: pass the two secrets + client id through `deploy.ps1` / `app.bicep`; document the
      Google Cloud Console steps and the `/auth/callback` redirect URI in the deploy README and
      `docs/help/oauth.md`. Update `.env.example`.
- [ ] Hermetic tests: mint Google-shaped ID tokens against a local key set (mirroring
      `test/authtest.ts`) — login redirect, callback happy path, bad `state`/`nonce`, expired
      session, `allowed_emails`/`allowed_domain` policy; and a test that `explain` needs no auth.
- [ ] A "Sign in with Google" affordance + signed-in email/logout on the `/demo` page.

## Related

- [ADR 0015 — Client-Credentials Auth](0015-client-credentials-auth.md) (the machine plane)
- [ADR 0002 — Router Header Contract](0002-router-header-contract.md) (inspector endpoints, guard placement, `X-Router-*` headers)
- [ADR 0008 — Observability](0008-observability.md) (attribution — a human `email` for `/demo` usage)
