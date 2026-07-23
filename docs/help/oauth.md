# Configuring OAuth

The `/v1/*` proxy surface is protected by **OAuth 2.0 client-credentials** JWTs
([ADR 0015](../decisions/0015-client-credentials-auth.md)). Callers are machines: they get a
JWT from an identity provider and present it as `Authorization: Bearer <jwt>`. The gateway
**validates** the token — it never issues one. This guide covers configuring the gateway, and
what a caller has to do.

## What the gateway validates

On every `/v1/*` request:

| Check | Against |
|---|---|
| **Signature** | the issuer's JWKS (fetched from OIDC discovery, cached, refreshed on new `kid`) |
| **`iss`** | your configured `issuer` |
| **`aud`** | your configured `audience` (skipped if you leave it empty) |
| **`exp` / `nbf`** | the token is currently valid |
| **scope** | if `required_scope` is set, the token's `scope`/`scp` must contain it |

The **demo endpoints stay open** — `/demo` and `POST /v1/router/explain` are registered ahead
of the auth guard and never require a token.

## Configuration

Set these in `config/server.yaml` **or** the environment (env wins; useful for a hosted
deployment where the YAML is baked into the image). None are secrets — the issuer's *public*
keys do the validating.

```yaml
# config/server.yaml
auth:
  enabled: true                      # AUTH_ENABLED
  issuer: "https://login.example.com/"   # AUTH_ISSUER — iss must match
  audience: "api://corgi-ai-gateway"     # AUTH_AUDIENCE — aud must match
  required_scope: ""                     # AUTH_REQUIRED_SCOPE — optional, e.g. router.invoke
  jwks_uri: ""                           # AUTH_JWKS_URI — optional; else <issuer>/.well-known/jwks.json
```

| Env var | Effect |
|---|---|
| `AUTH_ENABLED` | `false` turns the OAuth check off entirely — `/v1` is open, no token required (**local dev only**). `true` (default) validates tokens. |
| `AUTH_ISSUER` | Trusted issuer. **Empty ⇒ fail closed:** every `/v1` request is 401. |
| `AUTH_AUDIENCE` | Expected `aud`. Empty ⇒ audience is not checked (rely on the issuer). |
| `AUTH_REQUIRED_SCOPE` | Require this scope, e.g. `router.invoke`. Empty ⇒ any valid token passes. |
| `AUTH_JWKS_URI` | Override the JWKS URL if it isn't at the standard OIDC location. |

### Three postures

- **Protected (production).** `enabled: true` + an `issuer` (and usually `audience`). Tokens
  are validated.
- **Fail-closed (demo-only).** `enabled: true` + **no** issuer. Nothing can validate, so every
  `/v1` request is 401 — while the public inspector keeps working. This is what `-DemoOnly`
  deploys.
- **Open (local dev).** `AUTH_ENABLED=false`. No token required. Never do this on a public URL.

## Provider setup

The gateway only knows the OIDC contract, so any provider works by configuration. In each,
you register **one app for the gateway** (defines the audience/scope) and **one app per
caller** (gets a client id + secret).

**Microsoft Entra ID** — register an API app; the `issuer` is
`https://login.microsoftonline.com/<tenant>/v2.0` and the `audience` is the app's Application
ID URI (`api://…`). Expose an app role or scope and set `required_scope` to it.

**Auth0** — create an API (its *Identifier* is the `audience`); the `issuer` is
`https://<tenant>.auth0.com/`. Define a permission and set `required_scope`.

**Keycloak** — the `issuer` is `https://<host>/realms/<realm>`; create a client with the
*Service Accounts* (client-credentials) flow enabled; the `audience` is whatever the client's
token carries (map it if needed).

## Getting a token (the caller's side)

A caller exchanges its `client_id` + `client_secret` for a JWT at the provider's token
endpoint, then calls the gateway with it:

```bash
# 1. get a token (example against a generic OIDC token endpoint)
ACCESS_TOKEN=$(curl -s -X POST "$TOKEN_ENDPOINT" \
  -d grant_type=client_credentials \
  -d client_id="$CLIENT_ID" \
  -d client_secret="$CLIENT_SECRET" \
  -d audience="api://corgi-ai-gateway" \
  -d scope="router.invoke" | jq -r .access_token)

# 2. call the gateway
curl https://your-gateway/v1/chat/completions \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Router-Strategy: cost" \
  -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}'
```

The `.NET` client ([`corgi-ai-client-dotnet`](https://github.com/zhasouris/corgi-ai-client-dotnet))
does step 1 for you (MSAL / a client-credentials token client) and attaches + refreshes the
token automatically.

## Deploying with auth (Azure)

`deploy.ps1` reads the OAuth config from `.env`:

```bash
# .env
AUTH_ISSUER=https://login.example.com/
AUTH_AUDIENCE=api://corgi-ai-gateway
AUTH_REQUIRED_SCOPE=router.invoke
```

A full deploy **refuses to run without `AUTH_ISSUER`** (nothing else protects the public URL);
`-DemoOnly` configures no issuer and fails closed. See [deploy/azure](../../deploy/azure).

## Troubleshooting a 401

Every rejection is a `401` with `WWW-Authenticate: Bearer error="invalid_token"`. The body's
`error.message` says which check failed, and the server logs `token validation failed` with a
reason (never the token). Common causes:

| Message / reason | Fix |
|---|---|
| `authentication is not configured` | `enabled: true` but no `issuer` — set `AUTH_ISSUER`, or this is the intended fail-closed demo posture. |
| `missing bearer token` | No `Authorization: Bearer` header. |
| unexpected `iss` / `aud` | The token's issuer/audience don't match your config. Check both sides. |
| `exp` claim / expired | The token has expired — fetch a fresh one (they're short-lived by design). |
| `token missing required scope` | The client's app registration doesn't grant `required_scope`. |
| JWKS fetch failure | The gateway can't reach the issuer's JWKS endpoint — it **fails closed** (401), it does not fall open. Check egress/DNS to the issuer. |

## Related

- [ADR 0015 — Client-Credentials Auth](../decisions/0015-client-credentials-auth.md) (the decision and its trade-offs)
- [deploy/azure/README](../../deploy/azure/README.md) (the demo-only vs full-proxy deploy shapes)
- [observability](observability.md) (the validated `client_id` is recorded for per-client audit)
