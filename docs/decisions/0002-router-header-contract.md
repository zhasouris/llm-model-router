# ADR 0002 — Router Header Contract (Control & Response Headers)

- **Status:** Accepted
- **Date:** 2026-07-19
- **Context repo:** `llm-model-router`

## Context

The proxy must stay **drop-in compatible** with OpenAI SDKs — a client changes only its
base URL and everything keeps working. That means the request/response **body** must
remain a pristine OpenAI `chat.completions` payload. We still need a way for callers to
steer the router and to observe what it decided.

HTTP **headers** are the natural side channel: every official OpenAI SDK supports
injecting custom headers, both globally and per request, without touching the body.

- **Python:** `OpenAI(default_headers={...})` and per-call `extra_headers={...}`
- **Node/TS:** `new OpenAI({ defaultHeaders: {...} })` and per-call `{ headers: {...} }`

This keeps router instructions out of the body (so the body stays schema-valid and any
middleware that only understands OpenAI JSON is unaffected) while giving callers control
and transparency.

## Decision

### Default behavior

**Routing is on by default.** The proxy inspects the request and picks the model per the
active strategy. The body `model` field is treated as a hint/fallback and is **ignored**
unless routing is explicitly bypassed.

### Inbound control headers (client → proxy)

| Header | Purpose | Values | Default |
|---|---|---|---|
| `X-Router-Strategy` | Which optimization the router favors | `cost` \| `quality` \| `latency` \| `balanced` | `balanced` |
| `X-Router-Bypass` | Skip all routing; use the body `model` verbatim | `true` (present/truthy) | routing active |

Decision flow:

```
if X-Router-Bypass is truthy:
    forward body.model unchanged to its provider
else:
    run the active strategy → pick model → rewrite body.model → forward
```

The proxy **strips** these `X-Router-*` control headers before forwarding upstream so
they never reach OpenAI/Anthropic.

### Outbound response headers (proxy → client)

Emitted for transparency so behavior is debuggable without server logs:

| Header | Meaning | Example |
|---|---|---|
| `X-Router-Model` | The model actually chosen | `gpt-4.1-mini` |
| `X-Router-Reason` | Why it was chosen | `low-complexity` |
| `X-Router-Warning` | Soft warnings (e.g. unknown strategy, degraded signal) | `signal degraded; used deterministic defaults` |
| `X-Router-Duration-Ms` | Time spent **in the routing step** — detection, signal, filtering, scoring. Excludes the upstream call, so it is the overhead the proxy adds. | `142` |

Header values are folded to printable ASCII before being emitted: reasons and warnings are
human-facing prose, and a non-Latin-1 character in a header value makes the runtime reject
the whole response. The JSON body keeps the original text.

### Error handling for control headers

- **Missing** `X-Router-Strategy` → use the default strategy (`balanced`).
- **Unknown** `X-Router-Strategy` value → **fail soft**: fall back to the default and
  echo an `X-Router-Warning` response header so the caller can debug. (Failing hard with
  a 400 is more correct but less friendly for a drop-in proxy; we chose friendliness.)

## Alternatives considered

- **Sentinel model name (`model: "auto"`) as the control surface.** Would make routing
  *opt-in* and survive body-only middleware. Rejected as the primary mechanism in favor
  of **routing-by-default + a `X-Router-Bypass` escape hatch**, which is the simpler
  mental model. The sentinel remains available as a future convenience if needed.
- **Putting router instructions in the request body.** Rejected — pollutes the OpenAI
  schema and breaks drop-in compatibility.

## Consequences

**Positive**
- Full drop-in OpenAI SDK compatibility; body stays schema-valid.
- Per-request and global control both work via standard SDK header hooks.
- Callers can see what the router did (`X-Router-Model` / `X-Router-Reason`) without
  access to logs.
- Clean, explicit escape hatch (`X-Router-Bypass`) for pinning a specific model.

**Negative / accepted tradeoffs**
- Fail-soft on unknown strategy values can mask caller typos; mitigated by the
  `X-Router-Warning` response header.
- Header-based control is invisible to tooling that only inspects request bodies.

## Follow-ups / TODO

- [ ] Finalize the exact set of strategy values as the rule system firms up (ADR-to-come).
- [ ] Decide whether to also honor a `model: "auto"` sentinel as an alias for routing.
- [ ] Specify any additional hint headers (e.g. cost ceiling, model allow-list) if the
      rule system calls for them.

## Related

- [ADR 0001 — Multi-Provider Translation Strategy](0001-multi-provider-translation-strategy.md)
