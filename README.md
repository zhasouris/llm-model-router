# llm-model-router

**An OpenAI-compatible proxy that picks the best model for every request — automatically.**

### ▶ [**Try the live decision inspector**](https://llmrouter-app.purplehill-bc78c3f6.eastus2.azurecontainerapps.io)

Type a prompt — or click a gold preset — and watch the router pick a model: the
signals it extracted, every candidate scored and ranked, which models were excluded
and why, and the headers a real OpenAI client would read back. No sign-up, no key.

*Inspector only. The deployment carries no provider keys, so it decides but never
forwards — the whole `/v1` surface answers 401. Running on Azure Container Apps
(see [deploy/azure](deploy/azure)); it scales to zero, so the first click may wait
a few seconds for a cold start.*

[![live demo](https://img.shields.io/badge/live%20demo-decision%20inspector-7c3aed)](https://llmrouter-app.purplehill-bc78c3f6.eastus2.azurecontainerapps.io)
![tests](https://img.shields.io/badge/tests-115%20passing-brightgreen)
![coverage](https://img.shields.io/badge/coverage-88%25%20lines-green)
![routing eval](https://img.shields.io/badge/routing-83%25%20judged%20%7C%2011%2F11%20gold-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-97.7%25-3178c6)
![Docker](https://img.shields.io/badge/Docker-ready-2496ed)
![OpenTelemetry](https://img.shields.io/badge/OpenTelemetry-instrumented-f5a800)
![license](https://img.shields.io/badge/license-MIT-blue)

Point your existing OpenAI SDK at it instead of `api.openai.com`. It inspects each
request, decides which model best fits the work (by cost, quality, latency, or a blend),
forwards to the right provider, and streams the response straight back. No client changes
beyond the base URL.

```
your app ──(OpenAI SDK)──▶ llm-model-router ──▶ the right model, this time
                                │
                    detect → classify → filter → score → forward
```

> **About this project.** A self-hosted, production-shaped exploration of per-request LLM
> routing — built to be *read* as much as run. The design decisions are documented as ADRs,
> the routing quality is measured (not asserted), and the architecture is deliberately
> separable so a trained ML router can slot in without touching the hot path. If you're
> evaluating the engineering, start with [How it works](#how-it-works),
> [Measuring the routing](#measuring-the-routing), and the [ADRs](docs/decisions).

---

## At a glance

- **Drop-in.** OpenAI-compatible surface — change the base URL, nothing else.
- **A real per-request decision**, not load-balancing: easy prompts fall to a cheap/fast
  model, hard prompts reserve the expensive one — per request, not per app.
- **Measured, not hoped.** A built-in eval harness scores routing against provable gold
  cases (**11/11**) and LLM-judged ground truth (**83%** accuracy, 0% over-routing).
- **Pluggable routing brain.** Deterministic heuristic, a cheap-LLM classifier, or a
  RouteLLM sidecar — all behind one `SignalProvider` interface; degrades gracefully.
- **Header-based control surface** that never touches the request body.
- **Observable by default.** OpenTelemetry throughout; per-model cost attribution.
- **Yours.** Self-hosted, config-driven, MIT. Adding a model is an edit, not a deploy.

---

## Quickstart

```bash
npm install
cp .env.example .env        # then fill in provider keys
npm start                   # serves on :8000
```

or with Docker:

```bash
docker compose up -d --build              # reads .env, serves on :8000
docker compose --profile routellm up -d --build   # + the RouteLLM sidecar
```

Call it exactly like the OpenAI API — just add a routing header:

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Authorization: Bearer $ROUTER_KEY" \
  -H "Content-Type: application/json" \
  -H "X-Router-Strategy: cost" \
  -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}' -i
```

Open **`http://localhost:8000`** for the decision inspector (the same page as the
[live demo](https://llmrouter-app.purplehill-bc78c3f6.eastus2.azurecontainerapps.io)),
and **`/docs`** for a Swagger UI documenting the endpoints, the `X-Router-*` control
headers, and bearer auth. Raw spec at `/openapi.json`.

Deploying it yourself takes one command — see [deploy/azure](deploy/azure).

---

## Why this project exists

The open-source LLM tooling world is split into two halves that rarely meet:

- **Routing brains** — projects like [RouteLLM](https://github.com/lm-sys/routellm) and
  [LLMRouter](https://github.com/ulab-uiuc/LLMRouter) are excellent at *deciding* which
  model should answer a prompt. But they're research/serving frameworks for the **decision
  itself** — not something you can drop in front of an app.
- **Gateways** — projects like [LiteLLM](https://github.com/BerriAI/litellm) and Portkey
  are outstanding **proxies**: one OpenAI-format endpoint over 100+ providers, with keys,
  budgets, fallbacks, and logging. But their routing is coarse — load-balancing and
  failover, not "pick the *best* model for *this* request."

**Almost nothing open-source combines the two.** If you want a real drop-in proxy *and* a
genuine per-request model decision, you generally end up reaching for commercial products
(Martian, Not Diamond, Unify).

`llm-model-router` is that missing intersection:

> **A drop-in OpenAI-compatible proxy with a pluggable difficulty/cost/quality scoring
> engine and a clean header-based control surface — self-hosted, and yours.**

It's deliberately designed so the routing *brain* and the *gateway* are separable: the
runtime stays lean and forwards fast, while the expensive ML that learns from your traffic
runs **offline** and feeds results back in as data — so a trained router (RouteLLM-style)
can slot in behind the same interface without touching the hot path.

### Where it's useful

- **Cut inference spend without hand-tuning model choice.** Stop hard-coding `gpt-4.1`
  everywhere; reserve the expensive model for the work that needs it — per request.
- **One endpoint, many providers.** **32 models across 9 vendors** — OpenAI, Anthropic,
  Google, Mistral, DeepSeek, xAI, Groq, Together and Cohere — behind a single
  OpenAI-shaped API. A pluggable transformer layer talks each vendor's dialect: Anthropic
  goes over its **native Messages API**, the rest over their OpenAI-compatible endpoints,
  and adding a native adapter is one file (see [docs/transformers.md](docs/transformers.md)).
  Self-hosted / Ollama on the roadmap.
- **Per-call control without breaking the schema.** Ask for `cost` on a batch job and
  `quality` on a customer-facing path — via a header, body still a pristine OpenAI payload.
- **A foundation you own.** Self-hosted, config-driven, OpenTelemetry throughout.
- **A place to put a learned router.** The offline module is designed to consume your
  telemetry and improve routing over time.
- **Per-model cost breakdown.** Give each model its own vendor key (`api_key_env`) and the
  vendor's billing attributes spend per model — no custom metering (see [ADR 0007](docs/decisions/0007-per-model-api-keys.md)).

Not the right tool if you just want a passive multi-provider gateway with failover — a
mature gateway like LiteLLM already does that well, and can even sit *underneath* this as
the provider-translation layer.

---

## How it works

```
request ─▶ detect ─▶ (bypass?) ─▶ analyze ─▶ filter (hard constraints) ─▶ weighted score ─▶ forward
```

1. **Detect** deterministic facts (token count, vision/tools/audio, JSON mode).
2. **Analyze** — a pluggable **signal provider** estimates the subjective signals
   (complexity, expected output size, reasoning depth, task type, data sensitivity). Ships
   with a deterministic heuristic and a cheap-LLM classifier; a **RouteLLM sidecar** (a
   trained difficulty model) drops in behind the same `SignalProvider` interface. Degrades
   gracefully — if the signal source fails, routing continues on deterministic signals.
3. **Filter** the model catalog by hard capability constraints (a vision request never
   routes to a non-vision model, ever).
4. **Score** every surviving model with strategy-weighted, normalized rules and pick the
   winner.
5. **Forward** to the chosen provider and stream the response back unchanged.

### The datapoints it collects

Every request is reduced to two kinds of signal before any model is scored.

**Deterministic facts** — extracted with no LLM call, in `detect.ts`:

| Datapoint | How it's derived |
| --- | --- |
| `inputTokens` | `gpt-tokenizer` over all message text (+4 tokens/message overhead); char-based fallback if tokenizing fails |
| `requiresVision` | any `image_url` / `input_image` content part |
| `requiresTools` | a non-empty `tools[]` or `functions[]` |
| `requiresStructuredOutput` | `response_format` of `json_object` or `json_schema` |
| `requiresAudio` | `modalities: ["audio"]` or an `input_audio` / `audio` part |

**Predictive signals** — the subjective read on the prompt, produced by a pluggable
`SignalProvider` as a normalized `ClassifierResult`:

| Signal | Range | Meaning |
| --- | --- | --- |
| `complexity` | 0..1 | How hard the request is |
| `expectedOutputTokens` | int | Predicted response length |
| `reasoningDepth` | 0..1 | How much multi-step reasoning is needed |
| `taskType` | enum | coding, math, reasoning, analysis, summarization, extraction, creative, translation, conversation |
| `dataSensitivity` | 0..1 | Presence of sensitive data (PII, secrets, medical) |

Three providers implement that one interface, and any can be swapped in via config —
graceful degradation is built in, so a failed signal source never blocks routing:

- **`llm-classifier`** (runtime default) — a cheap-LLM call in JSON mode at `temperature 0`; on any error it degrades to safe defaults.
- **`heuristic`** — deterministic keyword + length scoring, fully offline; used for the hermetic eval dry-run and as the fallback.
- **`routellm`** — a trained RouteLLM sidecar whose strong-vs-weak win-rate maps onto `complexity`; the remaining signals are backfilled from the heuristic, and it falls back entirely if the sidecar is unreachable.

Those raw signals are then turned into **eight feature rules**. Each rule owns both halves of
its logic — it extracts a normalized `0..1` signal from the request, and it knows how to
score a candidate model against that signal — so adding a routing criterion is a single
drop-in:

| Rule | Signal it reads | How it scores a model (higher = better) |
| --- | --- | --- |
| `input_tokens` | prompt size vs. 128k | favors cheap input pricing, weighted up as prompts grow |
| `expected_output` | predicted output vs. 8k | favors cheap output pricing, weighted up as output grows |
| `complexity` | `complexity` | `tier × (2·complexity − 1)` — hard prompts favor higher tiers, easy prompts lower |
| `reasoning_depth` | `reasoningDepth` | rewards models that declare a `reasoning` capability |
| `task_type` | 1 if coding/math/reasoning/analysis | rewards higher-tier models on hard task classes |
| `data_sensitivity` | `dataSensitivity` | biases toward local/self-hosted providers (neutral until one exists) |
| `cost` | — | `−(costPer1kInput + costPer1kOutput)` |
| `latency` | — | `−avgLatencyMs` |

Every model in the catalog (`config/models.yaml`) carries the attributes these rules read:
`tier`, `contextWindow`, `maxOutputTokens`, `costPer1kInput`, `costPer1kOutput`,
`avgLatencyMs`, and `capabilities` — plus an optional per-model `api_key_env`.

### The scoring mechanism

Selection runs in three stages, and only the last one is weighted:

1. **Hard filter (constraints).** Before any scoring, every model must pass unweighted,
   strategy-independent capability gates: `vision`, `tools`, `structured_output`, `audio`,
   and a `context_window` check (`inputTokens + expectedOutput ≤ contextWindow`, and
   `expectedOutput ≤ maxOutputTokens`). A vision request can *never* reach a non-vision
   model — this is a filter, not a preference.

2. **Per-rule scoring, then min-max normalization.** Each surviving model gets a raw score
   from every rule. Because those raw scores live on wildly different scales (dollars,
   milliseconds, tier integers), each rule's scores are **min-max normalized to `0..1`
   across the candidate set** — so a weight means the same thing regardless of the rule's
   native units. (If every candidate ties on a rule, they all get `0.5`.)

3. **Strategy-weighted sum.** The normalized scores are multiplied by the active strategy's
   weight vector and summed. Highest total wins; ties break deterministically — by score,
   then cheaper blended cost, then model id — so routing is reproducible. The dominant
   contribution is surfaced in `X-Router-Reason`.

A **strategy is just a weight vector** over the eight rules (`config/strategies.yaml`);
weights are relative and need not sum to 1:

| Rule | `balanced` | `cost` | `quality` | `latency` |
| --- | --- | --- | --- | --- |
| `complexity` | 2.0 | 0.0 | 3.0 | 0.5 |
| `reasoning_depth` | 1.0 | 0.0 | 2.0 | 0.3 |
| `task_type` | 1.0 | 0.0 | 1.5 | 0.3 |
| `cost` | 1.0 | 3.0 | 0.1 | 0.5 |
| `latency` | 0.5 | 0.5 | 0.1 | 3.0 |
| `expected_output` | 0.3 | 1.0 | 0.3 | 0.3 |
| `input_tokens` | 0.3 | 1.0 | 0.2 | 0.3 |
| `data_sensitivity` | 0.3 | 0.0 | 0.3 | 0.3 |

A design detail worth noting: the `cost` strategy zeroes the quality rules entirely. Under
per-rule normalization, even a weight-`0.3` quality rule will tip hard prompts toward
expensive models — so a *pure* cost objective has to switch them off, not just turn them
down. Tuning weights is a config edit; adding a whole new criterion is one new rule file.

### Control it with headers (never the body)

| Header | Effect |
| --- | --- |
| `X-Router-Strategy: cost \| quality \| latency \| balanced` | Which objective to optimize |
| `X-Router-Bypass: true` | Skip routing; use the body's `model` verbatim |
| `X-Router-Max-Cost: <usd per 1k>` | Cost ceiling |

And it tells you what it did, on every response:

| Response header | Meaning |
| --- | --- |
| `X-Router-Model` | The model it chose |
| `X-Router-Reason` | Why |
| `X-Router-Warning` | Soft warnings (e.g. classifier degraded, unknown strategy) |

The design rationale for every one of these choices lives in [`docs/decisions/`](docs/decisions) as ADRs.

---

## Measuring the routing

A router is only as good as its decisions, so the project ships an **evaluation harness**
that turns "is it any good?" into numbers — two ways, each honest about what it proves:

| Method | What it proves | Result |
| --- | --- | --- |
| **Provable gold cases** (`test/gold.test.ts`) | Requests whose correct target is *objectively determinable* (vision → vision model; pure-`cost` → cheapest; bypass → verbatim; audio → error) | **11/11** |
| **Quality-judged accuracy** (`npm run eval:judge`) | For each prompt, a weak and a strong model both answer, an LLM judge decides whether the strong answer was *meaningfully* better, and the router's choice is scored against that ground truth | **83% accuracy · 0% over-routing · 17% under-routing** (balanced, 12-prompt set) |

```bash
npm run eval          # dry-run: strategies vs. baselines + estimated cost (hermetic)
npm run eval:judge    # quality-judged accuracy (makes real model calls; spends)
```

**Honest caveats:** the judged number is a small set with a single judge model, and the
default signal is a coarse heuristic — closing the gap is exactly what the RouteLLM signal
is for. The harness is the feedback loop that will *prove* whether it helps. Spec:
[`docs/eval-harness.md`](docs/eval-harness.md).

---

## Architecture & design decisions

The engineering choices are documented as **Architecture Decision Records** in
[`docs/decisions/`](docs/decisions) — the reasoning, the alternatives weighed, and the
tradeoffs accepted. Highlights:

- **Brain/gateway separation** — the fast forwarding path and the expensive routing
  intelligence are decoupled, so a learned router can be promoted in without a rewrite.
- **`SignalProvider` interface** — heuristic, LLM classifier, and RouteLLM sidecar are
  interchangeable behind one contract, with graceful degradation.
- **Config over code** — catalog, strategies, and classifier are all YAML; adding a model
  is an edit, not a deploy.
- **Per-model API keys** ([ADR 0007](docs/decisions/0007-per-model-api-keys.md)) — vendor
  billing does the cost attribution, no custom metering.

Testing rules and invariants: [`docs/TESTING.md`](docs/TESTING.md).

---

## Implementations

The primary runtime is **TypeScript** (this repo, `main`). A **Python** runtime (FastAPI)
with equivalent behavior lives on the `feature/python-implementation` branch. ADRs
0001–0003 and 0005–0007 are shared by both; ADR 0004 documents each stack.

### Stack (TypeScript)

Hono (+ `@hono/node-server`), Zod for config validation, the `openai` SDK for the
classifier call, global `fetch` for streaming passthrough, `gpt-tokenizer` for token
counting, OpenTelemetry, run via `tsx`. The signal source is a pluggable `SignalProvider`
(heuristic / LLM classifier / RouteLLM sidecar). See [ADR 0004](docs/decisions/0004-stack-and-project-layout.md).

---

## Configuration

| File | Holds |
| --- | --- |
| `.env` | Secrets — provider keys, optional per-model keys, proxy bearer tokens (gitignored; copy from `.env.example`) |
| `config/server.yaml` | Classifier, OTel, auth, provider endpoints |
| `config/models.yaml` | Model catalog (cost, context, capabilities, tier, optional `api_key_env`) |
| `config/strategies.yaml` | Strategy → weight vectors |
| `sidecar/` | Optional RouteLLM signal sidecar (Python) — see its README |

**Per-model keys** (optional): a model in `models.yaml` may set `api_key_env` to
authenticate its own calls with a dedicated vendor key; otherwise it falls back to the
provider default.

---

## Tests

```bash
npm test          # vitest — 51 tests incl. gold routing + judging logic (hermetic)
npm run typecheck # tsc --noEmit
npm run eval      # dry-run routing eval (strategies vs. baselines)
npm run eval:judge# quality-judged accuracy (spends — real model calls)
```

---

## Status & roadmap

**Now:** OpenAI-compatible surface over **32 models / 9 vendors**; a pluggable transformer
layer (Anthropic native Messages API, OpenAI-compat passthrough for the rest —
[docs/transformers.md](docs/transformers.md)); pluggable signal (heuristic / LLM classifier
/ RouteLLM sidecar); strategy-weighted scoring; header control; streaming; per-model API
keys; OpenTelemetry (traces, metrics, logs); Docker; evaluation harness (dry-run + provable
gold + quality-judged accuracy); CI (typecheck, tests, coverage floors) + security scanning
(SAST + DAST).

**In progress / deferred** (full backlog: [docs/TODO.md](docs/TODO.md)):

- **RouteLLM shadow-eval → promotion** ([ADR 0006](docs/decisions)): the sidecar +
  `SignalProvider` are built; the accuracy lift vs. the heuristic is not yet benchmarked
  through the judge.
- Native transformers for the remaining vendors (Gemini, Cohere, …) — they work today over
  their OpenAI-compatible endpoints; native adapters are a fidelity upgrade, tracked as a
  checklist in [docs/transformers.md](docs/transformers.md).
- Self-hosted / Ollama backends.
- Offline, telemetry-fed ML router ([ADR 0005](docs/decisions)).
- Automatic cross-provider failover.
- **Sensitive-data routing** — enforce data-handling policy as a hard, fail-closed
  constraint ([ADR 0009](docs/decisions/0009-sensitive-data-routing.md), planned).

---

## Related & prior art

- **Routing brains:** [RouteLLM](https://github.com/lm-sys/routellm),
  [LLMRouter](https://github.com/ulab-uiuc/LLMRouter),
  [vLLM Semantic Router](https://vllm-semantic-router.com/)
- **Gateways:** [LiteLLM](https://github.com/BerriAI/litellm), Portkey, OpenRouter,
  Cloudflare AI Gateway

This project's niche is the **overlap** of those two lists.

---

## License

[MIT](LICENSE)