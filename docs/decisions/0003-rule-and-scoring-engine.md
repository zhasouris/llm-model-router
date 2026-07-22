# ADR 0003 — Rule & Scoring Engine

- **Status:** Accepted
- **Date:** 2026-07-19
- **Context repo:** `llm-model-router`

## Context

The router must pick the best backend model for each request. An earlier direction
favored deterministic heuristics; we now believe heuristics alone are too blunt to make
a good decision. Instead we score each request against a set of criteria and use
**weighted scoring** — driven by the caller's strategy — to select the model.

Two realizations shape the design:

1. **There are two distinct kinds of "score."** One describes the *request* (a feature
   vector); the other describes how well each candidate *model* fits. Collapsing them
   hides the fact that a derived value like `complexity: 0.9` names a *requirement*, not
   a model — mapping that requirement onto a model needs the model catalog.
2. **Not every criterion is a weighted score.** Some are hard capability constraints
   (a model either supports vision or it doesn't). Those pre-filter the catalog; they
   are never weighted. This is the constraint-rule vs. scoring-rule split first noted in
   [ADR 0001](0001-multi-provider-translation-strategy.md).

## Decision

### Pipeline

```
Request
  ─▶ [Feature Extraction]     ─▶ feature vector (normalized 0..1 signals)
  ─▶ [Filter catalog]         ─▶ drop models failing hard capability constraints
  ─▶ [Weighted model scoring] ─▶ rank survivors by strategy-weighted feature scores
  ─▶ pick top model
```

### Stage 1 — Feature extraction

Extractors derive a **normalized feature vector** describing the request. Extractors are
**heterogeneous**:

- **Deterministic** extractors (e.g. Input Token Count) compute directly — no LLM.
- **Classifier-backed** extractors read from a single shared classifier call (below).

**One classifier call per request, not one per criterion.** A single structured call to
a configured, pinned classifier model returns all subjective/predictive features at once.
Deterministic extractors run alongside it for free. Extractors read from a shared
`RequestAnalysis` context that already holds the classifier output.

Illustrative classifier structured output:

```jsonc
{
  "complexity": 0.82,            // subjective difficulty
  "expectedOutputTokens": 1500,  // prediction
  "reasoningDepth": 0.4,         // need for explicit step-by-step reasoning
  "taskType": "coding",          // coding | summarization | extraction | creative | math | conversation | ...
  "dataSensitivity": 0.1         // privacy sensitivity → prefer self-hosted
}
```

### Normalization

Weighted scoring is only meaningful when signals are comparable. **Every extractor emits
a normalized `0..1` signal** and retains the raw value as metadata (for observability).
Without this, large-magnitude features (e.g. token counts in the tens of thousands)
drown out `0..1` features like complexity.

### Rule interface

A uniform contract covers both deterministic and classifier-backed criteria. Following
option **(b)** from discussion, a scoring rule both *extracts* a normalized signal and
*knows how that signal prefers models* — so adding a criterion is a single drop-in that
the strategy then weights.

```
interface IFeatureRule {
    string Name { get; }

    // Stage 1: derive a normalized signal from the request + shared analysis
    FeatureScore Extract(RoutingRequest req, RequestAnalysis ctx);

    // Stage 2: score a candidate model against this rule's signal (0..1)
    double ScoreModel(ModelDescriptor model, FeatureScore signal);
}

interface IConstraintRule {
    string Name { get; }
    // Hard filter: may this model serve this request at all?
    bool Admits(ModelDescriptor model, RoutingRequest req, RequestAnalysis ctx);
}
```

### Stage 2 — Weighted model scoring

- **Strategy = a weight vector** over the scoring rules. `cost` weights the cost-related
  features heavily; `quality` weights complexity/reasoning; `balanced` spreads weight;
  `latency` weights the latency feature.
- For each surviving model, final score = `Σ (strategyWeight[rule] × rule.ScoreModel(model, signal))`.
- Highest score wins; ties broken by a deterministic fallback (e.g. lower cost).

#### Per-rule normalization, and when to skip it

Rule outputs are min-max normalized **across the candidate set** before weighting, because
their raw units are incomparable — dollars, milliseconds, tier products. Relative ranking
within the candidates is the only meaningful comparison available for those.

That is wrong for a rule whose output is *already* on an absolute `0..1` scale, where the
magnitude itself carries meaning. Min-max stretches whatever spread happens to exist to fill
the range, so a signal of `0.1` and a signal of `1.0` produce an identical contribution — a
graded preference silently degenerates into a capability flag.

Such rules set **`fixedScale: true`** and are used as-is (clamped), not normalized.
Currently `reasoning_depth` and `data_sensitivity`.

*Found in practice:* on "Say hi in one word" (reasoning depth `0.1`), a reasoning-capable
model was handed the full reasoning bonus and beat a model that was both faster and cheaper
under the **latency** strategy. See `test/scoring.test.ts`.

A caveat worth recording: this change made the dry-run eval look *worse* (see below), because
that harness runs the deterministic heuristic provider, whose weak signals the old behaviour
was accidentally compensating for. Under the LLM classifier — the production default — the
same prompts rank correctly.
- The chosen model and a human-readable reason are surfaced via `X-Router-Model` /
  `X-Router-Reason` (see [ADR 0002](0002-router-header-contract.md)).

## Criteria menu

### Hard capability constraints (filters — never weighted)

| Criterion | Source | Filters out models that… |
|---|---|---|
| Vision / image input | deterministic | can't accept images |
| Tool / function calling | deterministic | don't support tools |
| Structured output / JSON mode | deterministic | can't guarantee the format |
| Audio input/output | deterministic | lack the modality |
| Context-window fit (input + expected output) | deterministic + classifier | can't hold the request |

### Request-feature scores (weighted core)

| Criterion | Source | Biases toward… |
|---|---|---|
| Input Token Count *(v1)* | deterministic | cheaper input pricing / large context |
| Expected Output Tokens *(v1)* | classifier | cheaper output pricing / high output cap |
| Complexity *(v1)* | classifier | higher capability tier |
| Reasoning depth *(v1 add)* | classifier | explicit reasoning models vs. fast models |
| Task type / domain *(v1 add)* | classifier | models that excel at that task |
| Precision vs. creativity | classifier | reliable/deterministic vs. generative models |
| Data sensitivity / privacy *(v1 add)* | classifier or header | self-hosted / Ollama over cloud |
| Language / multilinguality | classifier | models strong in the target language |
| Conversation length / turn count | deterministic | large-context, cache-friendly models |

### Operational / runtime scores (about the fleet, not the request)

Sourced from live telemetry (OpenTelemetry). Interface accepted in v1; wired up once OTel
is emitting signal.

| Criterion | Source | Biases toward… |
|---|---|---|
| Provider health / error rate | runtime | providers currently succeeding (soft failover) |
| Rate-limit headroom | runtime | providers with quota left |
| Latency / TTFT observed | runtime (OTel) | fast responders under `latency` strategy |
| Cost ceiling | header (`X-Router-Max-Cost`) | models under budget (may also filter) |

### Policy / governance (future, config-driven)

| Criterion | Source | Purpose |
|---|---|---|
| Data residency / region | config | compliance filtering |
| Tenant tier / allow-list | config | premium tenants get premium models |

### Learned / feedback (later)

| Criterion | Source | Purpose |
|---|---|---|
| Historical quality on similar requests | feedback loop | reinforce models that performed well |

## v1 scope

- **Extractors:** Input Token Count (deterministic); Expected Output Tokens, Complexity,
  Reasoning Depth, Task Type, Data Sensitivity (one shared classifier call).
- **Constraints:** vision, tools, structured output, audio, context-window fit.
- **Strategies:** `cost`, `quality`, `latency`, `balanced` as weight vectors.
- **Operational scores:** interface present, wiring deferred until OTel emits.

## Consequences

**Positive**
- Clean separation of request-features from model-fit makes the scorer testable and the
  catalog the single source of model truth.
- Adding a criterion is one drop-in rule + a strategy weight — matches the "add more
  later" goal.
- A single richer classifier call adds Reasoning/Task/Sensitivity at no extra call cost.
- Operational scores give soft failover and load-awareness for free once OTel is live.

**Negative / accepted tradeoffs**
- Every routed request carries an extra classifier LLM call on the critical path.
  *Mitigations:* small/fast pinned classifier; cache by prompt hash; skip the classifier
  for trivially small requests; `X-Router-Bypass` skips it entirely.
- Operational scores make routing **non-deterministic across time** (same request may
  route differently under load). This is intended for resilience but has testing
  implications — the deterministic feature/scoring core must be testable in isolation
  from live runtime signal.
- Normalization choices (how each raw value maps to `0..1`) materially affect routing and
  will need tuning.

## Follow-ups / TODO

- [ ] Define normalization functions per extractor (curves/thresholds).
- [ ] Define the classifier's structured output schema and the pinned classifier config.
- [ ] Define strategy weight vectors as configuration.
- [ ] Specify the model catalog schema (attributes consumed by constraints + scorers).
- [ ] Add classifier caching (by prompt hash) and a trivially-small-request skip path.
- [ ] Wire operational scores to OTel signal.

## Related

- [ADR 0001 — Multi-Provider Translation Strategy](0001-multi-provider-translation-strategy.md)
- [ADR 0002 — Router Header Contract](0002-router-header-contract.md)
