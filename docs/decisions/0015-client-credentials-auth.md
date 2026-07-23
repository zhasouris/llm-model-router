# ADR 0015 — Protect the Proxy with OAuth 2.0 Client Credentials

- **Status:** Accepted (implemented)
- **Date:** 2026-07-23
- **Context repo:** `corgi-ai-gateway`

## Context

The `/v1/*` proxy surface is guarded today by a **static bearer token** — the request token
must exactly match one of `ROUTER_API_KEYS` ([`src/auth.ts`](../../src/auth.ts)). That is fine
for a demo and local dev, but it is weak for a real machine-to-machine deployment: the secret
is long-lived, shared, coarse (one key = all access), rotated only by editing config and
redeploying, and it says nothing about *which* caller made a request.

Callers of this gateway are **machines** — batch jobs, agents, other services — not users. The
standard for machine-to-machine auth is the OAuth 2.0 **client-credentials** grant: a caller
authenticates to an identity provider with a `client_id`/`client_secret`, receives a
short-lived **JWT access token**, and presents it as `Authorization: Bearer <jwt>`. The
gateway's job is to **validate** that token — not to issue it.

## Decision

**Replace the static-key check with resource-server validation of OAuth 2.0 client-credentials
JWTs. Provider-agnostic, fail-closed, with a configurable required scope.**

### 1. The gateway is a resource server, not an authorization server

It never issues tokens. An external IdP does. The gateway validates every `/v1/*` request's
bearer JWT against configuration:

- **Signature** — RS256 (or the issuer's advertised alg) against the issuer's **JWKS**, fetched
  from the OIDC discovery document, cached in memory, and refreshed on an unknown `kid`.
- **`iss`** — equals the configured trusted issuer.
- **`aud`** — equals the configured audience (the gateway's API identifier).
- **`exp` / `nbf`** — the token is currently valid.
- **Scope** — if a `required_scope` is configured, the token's `scope` (space-delimited) or
  `scp` claim must contain it. Empty by default (any valid token from the trusted issuer
  passes).

Any failure → **401** with `WWW-Authenticate: Bearer error="invalid_token"`. The demo
endpoints (`/demo`, `/v1/router/explain`) remain unauthenticated — they are registered *ahead*
of the guard (unchanged, [ADR 0002](0002-router-header-contract.md)).

### 2. Provider-agnostic (generic OIDC)

The implementation knows only the OIDC contract — an **issuer**, an **audience**, a **JWKS**,
and an optional **scope**. No vendor SDK, no vendor-specific claim handling. It works with
Microsoft Entra ID, Auth0, Okta, Keycloak, or Cognito by configuration alone:

```yaml
# config/server.yaml
auth:
  enabled: true
  issuer: "https://login.example.com/"          # iss must match; JWKS discovered from here
  audience: "api://corgi-ai-gateway"            # aud must match
  required_scope: ""                             # optional, e.g. "router.invoke"
  jwks_uri: ""                                   # optional override; else OIDC discovery
```

Secrets (`client_secret`) live with the **caller**, never here — the gateway only needs the
issuer's *public* keys.

### 3. Replace, don't augment

`ROUTER_API_KEYS` and the static-key path are **removed**. There is no dual mode to keep
consistent, and no long-lived shared secret to leak. The two escape hatches remain:

- **`auth.enabled: false`** — open, for local dev only (unchanged).
- **Fail-closed by default** — with `enabled: true` and no issuer configured, *nothing can
  validate*, so every `/v1/*` request is 401. This is exactly how the demo-only Azure
  deployment stays closed today (it shipped an empty key set); now it stays closed by shipping
  no issuer. The posture is preserved, the mechanism is cleaner.

### 4. Audit falls out for free

A validated JWT carries `azp` / `client_id` — *which application* called. Recorded on the span
and metrics ([ADR 0008](0008-observability.md)) and correlated with the decision id, this gives
per-client attribution and an audit trail that a shared static key never could.

## Consequences

**Positive**

- Short-lived, per-client, revocable credentials instead of one long-lived shared secret.
- Rotation is the IdP's job; the gateway needs no redeploy to rotate a caller's key.
- Per-caller audit and cost attribution become possible (`client_id` claim).
- Standard, boring, and portable — any OIDC IdP, validated with a mature JWT library (`jose`).

**Negative / accepted trade-offs**

- **Requires app registrations at the IdP** — one for the gateway (defining the audience/scope)
  and one per calling client. This is inherent to the grant. It is *not* the "auth layer in
  front of the container" that was rejected for the Azure deploy (nothing sits in front; the
  app validates tokens itself) — but registrations do come back at the IdP layer.
- **The client must now acquire tokens.** Callers — including the `CorgiAI.Client` .NET client
  ([ADR 0014](0014-dotnet-client-and-prerequisites.md)) — need a client-credentials token
  client (MSAL `ConfidentialClientApplication` for Entra, or a generic OAuth token client) that
  fetches and refreshes the JWT and attaches it. This is a client-side prerequisite, tracked in
  that repo.
- **Local dev needs a token or the bypass.** Without an IdP handy, `auth.enabled: false` is the
  local-dev path; the hermetic test suite mints its own JWTs against a local test key.
- **A network dependency on the JWKS endpoint** on first validation (cached thereafter). A JWKS
  fetch failure must fail closed, not open.

## Follow-ups / TODO

- [ ] `jose`-based validation in `src/auth.ts` (`createRemoteJWKSet` + `jwtVerify`), with the
      key resolver injectable so tests supply a local JWKS.
- [ ] Config schema: `auth.{issuer,audience,required_scope,jwks_uri}`; remove `ROUTER_API_KEYS`
      and `routerApiKeys` from secrets.
- [ ] Refactor the auth-dependent tests to mint signed JWTs against a local key set.
- [ ] OpenAPI security scheme → OAuth2 `clientCredentials` (+ bearer JWT).
- [ ] Deploy: drop the `ROUTER_API_KEYS` secret; add `issuer`/`audience`/`required_scope`;
      `-DemoOnly` = no issuer = fail-closed. Update `.env.example` and the deploy README.
- [ ] Client-side token acquisition in `CorgiAI.Client` (coordinated via ADR 0014).
- [ ] Record `client_id`/`azp` on the routing span (ADR 0008).

## Related

- [ADR 0002 — Router Header Contract](0002-router-header-contract.md) (the guard's placement; demo endpoints stay open)
- [ADR 0008 — Observability](0008-observability.md) (per-client audit from the `client_id` claim)
- [ADR 0014 — .NET Client](0014-dotnet-client-and-prerequisites.md) (the client must acquire and attach tokens)
