# Spec — Routing Evaluation Harness

- **Status:** Draft spec (not yet built)
- **Date:** 2026-07-20
- **Unblocks:** [ADR 0006](decisions/0006-leveraging-learned-routing.md) steps 2–5, and any
  "our router is better" claim.

## Why

Our routing weights and signals are unvalidated. Before we trust *any* routing decision —
ours, RouteLLM's, or a blend — we need to **measure** it. The harness turns "our design is
better" from an architectural assertion into a number, and it is the prerequisite for
promoting a learned signal (ADR 0006) and for the offline ML loop ([ADR 0005](decisions/0005-offline-ml-module.md)).

## Goals

1. Given a **dataset of prompts**, run each through the routing pipeline and record the
   **decision** (chosen model, reason, feature vector) — without needing to spend money.
2. Estimate **cost** per request from the catalog and token counts.
3. When labels or live execution are available, measure **quality**, and report
   **cost-vs-quality** against fixed-model **baselines**.
4. Support **shadow comparison** of two `SignalProvider`s (e.g. classifier vs. RouteLLM)
   over the same dataset.

## Non-goals (for v1)

- Not a benchmark leaderboard; scoped to *our* catalog and traffic.
- Not real-time; it runs offline/batch.

## Design

### Inputs

- **Dataset**: a list of scenarios — `{ id, request (OpenAI body), tags?, difficultyLabel?, expectedTier? }`.
  Sources: sampled real traffic (from telemetry, later), a curated set, or a public set.
- **Config**: catalog + strategies (reuse `config/`), the `SignalProvider`(s) under test,
  and the mode (dry-run vs. live).

### Modes

**Phase 1 — dry-run (no spend).** For each scenario:
- Run `detect → analyze → filter → score → decision` **without forwarding**.
- Record: chosen model, reason, full feature vector, filtered candidate set, estimated
  cost (`inputTokens×inCost + expectedOutputTokens×outCost`).
- If `expectedTier`/`difficultyLabel` present: compute **routing accuracy** (did we pick
  the intended tier?).

**Phase 2 — live (spends, opt-in).** For a sampled subset:
- Actually forward to the chosen model *and* to each baseline.
- Score **quality** via a judge model or reference answers.
- Report realized cost and quality, not just estimates.

### Baselines (compare every run against)

- `always-cheapest`, `always-strongest`, `random`, and each **strategy** (`best`, `value`,
  `fast`). Baselines are the yardstick — a router only "wins" if it beats always-strong on
  cost at comparable quality, or always-cheap on quality at comparable cost.

### Base-model delta report (`npm run eval:baseline`)

Reframes the comparison the way an adopter thinks: *vs. defaulting to one model, what did
routing save and where did it get sharper?* Pick a base model (the status-quo default) and,
for each of `best`/`value`/`fast`, diff every pick against **always-base** — as **two
distinct KPIs**, never blended:

- **Cost** — net % vs always-base, split into cost Δ on downgrades vs upgrades.
- **Targeted accuracy** — router − base on the **task-appropriate benchmark** (SWE-bench for
  coding, AIME for math, GPQA for reasoning; from `docs/process/model-scores.json`) and
  per-task competency (ADR 0010), **segmented by whether the prompt needed accuracy** (hard)
  vs not — so "accuracy where you need it" is explicit.

Each pick is classified `upgrade` / `downgrade` / `forced-upgrade` (base can't serve the
prompt) / `unchanged` by task competency vs the base.

```bash
npm run eval:baseline -- --base gpt-4.1-mini --dataset eval/datasets/curated.jsonl
```

The base you choose sets the story: a **weak** default (`gpt-4.1-mini`) shows the router is
cheaper *and* sharper almost everywhere; a **strong** default (`o3`) shows large savings with
a small, *measured* accuracy give-up on hard prompts — the exact trade-off, made visible.
A third lens (real LLM-judged accuracy on a sample) is a planned add, reusing `judge.ts`.

### Shadow comparison (the ADR 0006 gate)

Run the same dataset with `SignalProvider = classifier` and `= routellm`, holding
everything else fixed. Report per-provider: decision distribution, estimated/real cost,
quality (Phase 2), and **agreement / disagreement** (where they diverge, and who was right
when labels exist). This is what promotes (or rejects) RouteLLM.

### Metrics reported

- Cost: mean/median per request, total, and vs. each baseline (% savings).
- Quality: accuracy vs. labels (Phase 1) or judge score (Phase 2).
- Distribution: how often each model/tier is chosen, per strategy/provider.
- Efficiency frontier: cost-vs-quality points for router(s) and baselines.
- Degradation rate: how often the classifier degraded (signal reliability).

### Output

- A machine-readable `report.json` plus a rendered `report.md` summary table. Deterministic
  in dry-run mode so results are diffable across code changes (regression guard).

## Implementation notes

- Lives under `eval/` in the repo; reuses the existing `Router`, catalog, and
  `SignalProvider` interfaces — no duplication of routing logic.
- Dry-run must **not** hit the network (hermetic, like the test suite); Phase 2 is explicitly
  gated behind a flag and a spend budget.
- `SignalProvider` is injected, so the same harness evaluates classifier, RouteLLM, or a
  future model without changes.

## Phasing

1. **v1 — dry-run**: decisions, estimated cost, distribution, label accuracy, baselines.
   Enough to sanity-check our weights and to run shadow decision-agreement.
2. **v2 — live quality**: judge/reference scoring on a sampled subset with a spend cap.
3. **v3 — telemetry-fed**: pull the dataset from real traffic; feeds the ADR 0005 loop.

## Open questions

- **Quality signal for Phase 2**: judge model, human labels, or reference answers? (Judge
  is cheapest to start; note its bias.)
- **Dataset**: curate vs. sample real traffic vs. a public set — likely start curated, move
  to sampled once telemetry is flowing.

## Related

- [ADR 0006 — Leveraging Learned Routing](decisions/0006-leveraging-learned-routing.md)
- [ADR 0005 — Offline ML as a Separate Module](decisions/0005-offline-ml-module.md)
- [ADR 0003 — Rule & Scoring Engine](decisions/0003-rule-and-scoring-engine.md)
