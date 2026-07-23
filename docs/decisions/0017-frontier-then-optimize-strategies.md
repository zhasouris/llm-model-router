# ADR 0017 — Frontier-Then-Optimize Routing: `best` / `value` / `fast`

- **Status:** Accepted (implementing)
- **Date:** 2026-07-23
- **Context repo:** `corgi-ai-gateway`

## Context

Every strategy today (`cost`, `quality`, `latency`, `balanced`) is a **single weighted
sum** over all rules ([ADR 0003](0003-rule-and-scoring-engine.md)). That folds capability
and price into one number, so cost always leaks into "quality": once the catalog was priced
realistically ([reprice, 2026-07-23]) and competency was seeded ([ADR 0010](0010-per-task-competency-scores.md)),
`quality` still routed a hard coding prompt to `o4-mini` over the stronger `claude-opus-4-8`,
because a 10%-worse-but-30×-cheaper model wins the blended score. Re-tuning weights only moves
the leak — a weighted sum can never say "first decide who is *good enough*, then optimise."

There are only **three** things a caller actually wants to optimise: the **best** model, the
best **value**, or the **fastest** — and the first two are the same quality question ("who is
good enough?") answered with a different tie-breaker, while the third is an orthogonal axis
(time) a quality×cost blend cannot express.

## Decision

**Two-stage selection — build the capability *frontier* for the task, then optimise a single
objective within it — exposed as three strategies: `best`, `value`, `fast`.**

### 1. Stage one — capability score `Q`

Score every eligible model by the **quality-family rules only** (`complexity`,
`reasoning_depth`, `task_type`/competency, `data_sensitivity`) — **no `cost`, `latency`,
`expected_output`, or `input_tokens`**. `Q(m)` answers one question: *how good is this model
for this task?* It reuses the existing scorer ([ADR 0003](0003-rule-and-scoring-engine.md))
with a single shared **capability weight vector** (not per-strategy).

Because `complexity` scores `tier·(2v−1)` — negative for high tier at low difficulty — `Q`
is **difficulty-aware for free**: a hard prompt's high-`Q` models are the strong ones; a
trivial prompt's are the cheap ones. No special easy-prompt guard is needed.

### 2. Stage two — the frontier (top cluster)

The **frontier** is every model within `δ` of the top capability score:
`{ m : Q(m) ≥ Q_max · (1 − δ) }`. `δ` (default **0.12**) is the one tuning knob: tight → the
frontier is near-ties only; loose → `value`/`fast` may trade a little capability for a lot of
savings/speed. A genuinely-worse-but-cheap model (e.g. `deepseek` reasoning 0.83 vs a 0.94
frontier) falls **outside** the frontier and can't win `value` — but still wins where it *is*
near the top.

### 3. Stage three — optimise one objective within the frontier

| Strategy | Objective within the frontier | Intent |
|---|---|---|
| **`best`** | max `Q` (the frontier top) | the strongest model, price-blind |
| **`value`** *(default)* | min blended cost | strongest that's also economical |
| **`fast`** | min `avg_latency_ms` | soonest among the genuinely-capable |

`best` is trivially the frontier top; `value`/`fast` re-order the frontier by cost/latency.
Models outside the frontier follow, ordered by `Q`, so the ranked list stays complete and
`pickRoutable` (walk to the first model with an API key, [ADR 0007](0007-per-model-api-keys.md))
is unchanged.

### 4. What is removed / kept

- **Removed strategies:** `cost`, `quality`, `latency`, `balanced`.
  - "cheapest, quality be damned" and "keep it under a budget" are served by **`value` +
    the existing `X-Router-Max-Cost` cap** — a constraint that composes with any strategy,
    not a fourth strategy.
  - `balanced` *was* value; it collapses into `value`.
- **Kept:** the hard-constraint filter (capability/context), `X-Router-Max-Cost`, the
  `X-Router-Bypass` escape hatch, and per-task competency.
- **Default strategy:** `value`.
- **Unknown strategy:** fails soft to `value` with `X-Router-Warning` (unchanged posture,
  [ADR 0002](0002-router-header-contract.md)).

### 5. Why not a fourth (`fast` as a cap instead)?

`X-Router-Max-Latency` would only *bound* time, not *minimise* it — a real-time surface wants
the *soonest* adequate model, which is a first-class objective. So `fast` earns strategy
status; cost does not, because "cheapest of the good" is exactly `value` and "cheapest at any
quality" is a cap.

## Consequences

**Positive**

- `best` surfaces the genuinely strongest model for the task (Opus on coding, etc.) —
  capability is decisive because cost is not in `Q`.
- `value` is cost-aware **without** letting a much-weaker model win — the frontier is a
  quality floor.
- `fast` finally expresses the time axis; three strategies map to three real intents.
- Difficulty-awareness and the easy-prompt guard fall out of `Q`; no new heuristics.
- Selection is a thin layer over the existing scorer; ADR 0003's rule engine is intact.

**Negative / accepted trade-offs**

- **Breaking API change:** `X-Router-Strategy` values change. Callers, the .NET client
  ([ADR 0014](0014-dotnet-client-and-prerequisites.md)), gold data, demo, and docs update.
- **`δ` is a tuning knob** — too tight and `value`≈`best`; too loose and `value` picks a
  visibly weaker model to save money. Needs an eval sweep, and eventually per-task `δ`.
- **A two-model frontier can be volatile** near the `δ` boundary (a model flips in/out with a
  small `Q` change). Acceptable; `pickRoutable` and the ranked tail keep the answer sensible.
- **`fast` picks within the frontier**, so on a hard prompt it won't drop to a tiny 200ms
  model — it returns the fastest *capable* one. That is intended, but a caller wanting
  raw speed regardless of quality must use `bypass`.

## Follow-ups / TODO

- [ ] `config/routing.yaml` (or `strategies.yaml` reshaped): capability weights + `frontier.delta`
      + per-strategy objective; Zod schema + fail-fast validation.
- [ ] `Q` + `topCluster` + `orderByObjective` in the scorer; router uses them.
- [ ] Rename `Strategy` union → `best|value|fast`; header parse, default `value`, soft-fallback.
- [ ] Re-derive `eval/datasets/gold.jsonl` for the new strategies; update all tests.
- [ ] Demo strategy selector, OpenAPI enum, ADR 0002, READMEs.
- [ ] Surface frontier membership + objective in `/v1/router/explain` and the demo.
- [ ] Eval sweep to tune `δ` (and consider per-task `δ`).

## Related

- [ADR 0003 — Rule & Scoring Engine](0003-rule-and-scoring-engine.md) (the scorer this builds on)
- [ADR 0010 — Per-Task Competency](0010-per-task-competency-scores.md) (the capability signal)
- [ADR 0002 — Router Header Contract](0002-router-header-contract.md) (`X-Router-Strategy` values)
