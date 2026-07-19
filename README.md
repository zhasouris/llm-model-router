# llm-model-router

**An OpenAI-compatible proxy that picks the best model for every request — automatically.**

Point your existing OpenAI SDK at it instead of `api.openai.com`. It inspects each
request, decides which model best fits the work (by cost, quality, latency, or a blend),
forwards to the right provider, and streams the response straight back. No client changes
beyond the base URL.

```
your app ──(OpenAI SDK)──▶ llm-model-router ──▶ the right model, this time
                                │
                    detect → classify → filter → score → forward
```

---

## Why this project exists

The open-source LLM tooling world is split into two halves that rarely meet:

- **Routing brains** — projects like [RouteLLM](https://github.com/lm-sys/routellm) and
  [LLMRouter](https://github.com/ulab-uiuc/LLMRouter) are excellent at *deciding* which
  model should answer a prompt (easy prompts → cheap model, hard prompts → strong model).
  But they're research/serving frameworks for the **decision itself** — not something you
  can drop in front of an app.
- **Gateways** — projects like [LiteLLM](https://github.com/BerriAI/litellm) and Portkey
  are outstanding **proxies**: one OpenAI-format endpoint over 100+ providers, with keys,
  budgets, fallbacks, and logging. But their routing is coarse — load-balancing and
  failover, not "pick the *best* model for *this* request."

**Almost nothing open-source combines the two.** If you want a real drop-in proxy *and*
a genuine per-request model decision, you generally end up reaching for commercial
products (Martian, Not Diamond, Unify).

`llm-model-router` is that missing intersection:

> **A drop-in OpenAI-compatible proxy with a pluggable difficulty/cost/quality scoring
> engine and a clean header-based control surface — self-hosted, and yours.**

It's deliberately designed so the routing *brain* and the *gateway* are separable:
the runtime stays lean and forwards fast, while the expensive ML that learns from your
traffic runs **offline** and feeds results back in as data — so a trained router
(RouteLLM-style) can slot in behind the same interface without touching the hot path.

---

## Where it's useful

- **Cut inference spend without hand-tuning model choice.** Stop hard-coding `gpt-4.1`
  everywhere. Let easy requests fall to a cheap/fast model and reserve the expensive model
  for the work that needs it — per request, not per app.
- **One endpoint, many providers.** OpenAI and Claude today (Claude via its
  OpenAI-compatible endpoint); self-hosted / Ollama on the roadmap. Your app speaks
  OpenAI and never changes.
- **Per-call control without breaking the schema.** A team can ask for `cost` on a batch
  job and `quality` on a customer-facing path — via a header, with the request body still
  a pristine OpenAI payload.
- **A foundation you own.** Self-hosted, config-driven, OpenTelemetry throughout. The
  catalog, strategies, and classifier are all configuration; adding a model is an edit,
  not a deploy.
- **A place to put a learned router.** Already collecting telemetry? The offline module is
  designed to consume it and improve routing over time.

Not the right tool if you just want a passive multi-provider gateway with failover — a
mature gateway like LiteLLM already does that well, and can even sit *underneath* this as
the provider-translation layer.

---

## How it works

```
request ─▶ detect ─▶ (bypass?) ─▶ analyze ─▶ filter (hard constraints) ─▶ weighted score ─▶ forward
```

1. **Detect** deterministic facts (token count, vision/tools/audio, JSON mode).
2. **Analyze** — one cheap classifier call estimates the subjective signals (complexity,
   expected output size, reasoning depth, task type, data sensitivity). It degrades
   gracefully: if the classifier fails, routing still happens on deterministic signals.
3. **Filter** the model catalog by hard capability constraints (a vision request never
   routes to a non-vision model, ever).
4. **Score** every surviving model with strategy-weighted, normalized rules and pick the
   winner.
5. **Forward** to the chosen provider and stream the response back unchanged.

### Control it with headers (never the body)

| Header | Effect |
|---|---|
| `X-Router-Strategy: cost \| quality \| latency \| balanced` | Which objective to optimize |
| `X-Router-Bypass: true` | Skip routing; use the body's `model` verbatim |
| `X-Router-Max-Cost: <usd per 1k>` | Cost ceiling |

And it tells you what it did, on every response:

| Response header | Meaning |
|---|---|
| `X-Router-Model` | The model it chose |
| `X-Router-Reason` | Why |
| `X-Router-Warning` | Soft warnings (e.g. classifier degraded, unknown strategy) |

The design rationale for every one of these choices lives in
[`docs/decisions/`](docs/decisions) as ADRs.

---

## Implementations

This branch is the **TypeScript** runtime (Hono + `tsx`). A **Python** runtime
(FastAPI) with identical behavior lives on the `feature/python-implementation` branch.
The ADRs 0001–0003 and 0005 are shared by both; ADR 0004 documents each stack.

## Stack (TypeScript)

Hono (+ `@hono/node-server`), Zod for config validation, the `openai` SDK for the
classifier call, global `fetch` for streaming passthrough, `gpt-tokenizer` for token
counting, OpenTelemetry, run via `tsx`. See
[ADR 0004](docs/decisions/0004-stack-and-project-layout.md).

## Configuration

| File | Holds |
|---|---|
| `.env` | Secrets — provider keys + proxy bearer tokens (gitignored; copy from `.env.example`) |
| `config/server.yaml` | Classifier, OTel, auth, provider endpoints |
| `config/models.yaml` | Model catalog (cost, context, capabilities, tier) |
| `config/strategies.yaml` | Strategy → weight vectors |

## Run

### Local

```bash
npm install
cp .env.example .env        # then fill in keys
npm start                   # serves on :8000
```

### Docker

```bash
docker compose up --build   # reads .env, serves on :8000
```

### Interactive testing

Open **`http://localhost:8000/docs`** — a Swagger UI documenting the endpoints, the
`X-Router-*` control headers, and bearer auth, so you can try requests in the browser.
The raw spec is at `/openapi.json`.

### Call it

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Authorization: Bearer $ROUTER_KEY" \
  -H "Content-Type: application/json" \
  -H "X-Router-Strategy: cost" \
  -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}' -i
```

## Tests

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit
```

Testing rules and invariants are in [`docs/TESTING.md`](docs/TESTING.md).

---

## Status & roadmap

**v1 (now):** OpenAI-compatible surface; OpenAI native + Claude via Anthropic's
OpenAI-compat endpoint; classifier-backed scoring; header control; streaming; OTel; Docker.

**Deferred (documented in the ADRs):**
- Canonical intermediate representation + native multi-provider translation (ADR 0001) —
  or routing provider translation through a mature gateway like LiteLLM instead.
- Self-hosted / Ollama backends.
- Offline, telemetry-fed ML router (ADR 0005) — where a trained RouteLLM-style decision
  model would plug in.
- Automatic cross-provider failover.

## Related & prior art

- Routing brains: [RouteLLM](https://github.com/lm-sys/routellm),
  [LLMRouter](https://github.com/ulab-uiuc/LLMRouter),
  [vLLM Semantic Router](https://vllm-semantic-router.com/)
- Gateways: [LiteLLM](https://github.com/BerriAI/litellm), Portkey, OpenRouter,
  Cloudflare AI Gateway

This project's niche is the **overlap** of those two lists.
