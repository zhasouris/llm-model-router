# TODO / backlog

The single place for open work. Decisions that are settled live in
[`decisions/`](decisions) as ADRs; unresolved design threads live in
[`discussions/`](discussions). This file is what's *queued*.

---

## Queued

### 1. Code coverage badge ✅ done

- [x] Coverage via `@vitest/coverage-v8` (`npm run coverage`), excluding the process
      entrypoint and the static demo page.
- [x] Thresholds set at the measured baseline and ratcheted up as coverage improved —
      now statements 85 / branches 64 / functions 87 / lines 87. CI fails below them.
- [x] `telemetry.ts` taken from **0% → 100%** (statements, branches, functions); it was
      the single largest hole. Includes the ADR 0008/0009 egress guard: the Azure Monitor
      exporter is never constructed without a connection string.
- [x] `ci.yml` workflow runs typecheck + tests + coverage on every push/PR (previously
      nothing ran the tests in CI at all) and uploads the report as an artifact.
- [x] README badge shows **88% lines**.

**Follow-up (open):** the badge number is currently static, kept honest by the enforced
floor — it can under-report if coverage improves, but never over-report. Swap it for a
live badge when convenient:
- [ ] shields.io **endpoint badge** backed by a gist updated from CI (needs a gist +
      a PAT secret), or **Codecov** (tokenless for public repos, adds a third party).
- [ ] Raise **branch coverage (64%)** — still the weakest metric. The remaining gap is
      concentrated in four files: `providers/adapters/anthropic.ts` (62 uncovered
      branches), `core/signal.ts` (26), `app.ts` (16), `report.ts` (11).
      Note that v8 counts every `??`/`?.` as a branch pair — `anthropic.ts` alone has 46
      of them in 288 lines — so a defensive codebase structurally lags here. A 90% branch
      target would mostly mean testing fallbacks that cannot occur; ~80% is the honest
      ceiling worth chasing. Statements/lines/functions are the metrics to push to 90%.

### 2. Sensitive-data routing — ADR written ✅, implementation open

The plan is written up as
**[ADR 0009 — Routing Sensitive Data to Approved Providers](decisions/0009-sensitive-data-routing.md)**
(status: *Proposed*). Core decision: data-handling policy is a **hard constraint, never a
score**, and it **fails closed** — with `policy > bypass > strategy` precedence.

Implementation queue (from the ADR's follow-ups):

- [ ] Catalog schema: `data_classes`, `region`, `retention`, `trains_on_data`, `self_hosted`.
- [ ] Policy config schema (global + per-key/tenant), fail-fast validated at startup.
- [ ] Deterministic detector library (PII/PAN/secrets/internal markers) — offline, unit-tested.
- [ ] `DataPolicyConstraint` implementing `ConstraintRule`; wire into the filter stage.
- [ ] Apply policy to the bypass path (currently a one-header hole through any control).
- [ ] Dry-run/report mode — log what *would* be refused before enforcing.
- [ ] Gold tests: a restricted request never routes to an unapproved provider, across **all**
      strategies and with bypass set.
- [ ] Blocked on the self-hosted/Ollama backend for a genuinely local target to route to.

---

### 3. Document `/v1/router/explain` in the OpenAPI spec

The demo endpoint is absent from `src/openapi.ts` entirely, so it never appears on the
Swagger page even though it is a public, unauthenticated part of the surface. It now also
emits the `X-Router-Model` / `X-Router-Reason` / `X-Router-Warning` response headers, which
should be documented the same way the `/v1/chat/completions` ones are.

---

### 4. The heuristic signal provider under-rates prompts

Exposed while fixing the `fixedScale` normalization bug. On *"Write a thread-safe LRU cache
in Rust with generics and explain the trade-offs"* the two providers disagree sharply:

| Signal | Heuristic | LLM classifier |
|---|---|---|
| `taskType` | **`conversation`** | `coding` |
| `complexity` | 0.41 | 0.70 |
| `reasoningDepth` | 0.12 | 0.60 |

Complexity below `0.5` makes the complexity rule actively favour *lower* tiers
(`tier × (2v − 1)` goes negative), so under heuristic signals a quality-strategy coding
request routes to a tier-1 model. The old over-weighted `reasoning_depth` was masking this.

This matters beyond the eval harness: the heuristic is the **degraded fallback** when the
classifier is unavailable, so a classifier outage currently degrades routing more than it
appears to.

- [ ] Teach the heuristic to detect task type (code fences, language names, "write a
      function", stack traces) instead of defaulting to `conversation`.
- [ ] Revisit the complexity rule's hard cliff at `0.5` — a small change either side of it
      flips the tier preference from strongest to weakest.
- [ ] Let `eval/run.ts` take `--provider llm` so the harness can measure the path that
      production actually uses. Today it only supports `heuristic` and `routellm`, which is
      why the tier-accuracy numbers below are heuristic-only.

---

## Carried over

Already tracked elsewhere; listed here so this file is the single view.

- [ ] **RouteLLM shadow-eval → promotion** — the sidecar and `SignalProvider` are built;
      the accuracy lift vs. the heuristic is not yet benchmarked through the judge
      ([ADR 0006](decisions/0006-leveraging-learned-routing.md)).
- [ ] **Native transformers for the remaining vendors** (Gemini, Cohere, …) — they work
      today over OpenAI-compatible endpoints; native adapters are a fidelity upgrade
      ([transformers checklist](transformers.md)).
- [ ] **Self-hosted / Ollama backend** — also unblocks the sensitive-data work above, since
      it provides a genuinely local "trusted provider".
- [ ] **Offline, telemetry-fed ML router** ([ADR 0005](decisions/0005-offline-ml-module.md)).
- [ ] **Automatic cross-provider failover.**
- [ ] **Eval harness Phase 2/3** — larger judged dataset, then telemetry-sourced
      ([eval-harness spec](eval-harness.md)).
