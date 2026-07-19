# Discussion — Learned Routing (RouteLLM/LLMRouter) & a Cascade Router

- **Status:** 🟡 Open / unresolved — **no decision made**
- **Date:** 2026-07-19
- **Context repo:** `llm-model-router`

> This is a discussion capture, not an ADR. It records where our thinking is, the options
> on the table, and the open questions. Nothing here is committed to.

## What prompted it

We compared our router to open-source projects and explored whether to adopt one, and how.
Key projects:

- **[RouteLLM](https://github.com/lm-sys/routellm)** (LMSYS/Berkeley) — Python. Routes
  between **exactly two models** (strong vs. weak) via a calibrated threshold, using
  **trained** routers (`mf` recommended, plus `sw_ranking`, `bert`, `causal_llm`). Weights
  auto-download from HuggingFace. Has a `Controller` API and an OpenAI-compatible server.
- **[LLMRouter](https://github.com/ulab-uiuc/LLMRouter)** (UIUC) — Python. Genuinely
  N-model with many router types; more of a research library, less battle-tested.

## Findings we agreed on

1. **Chassis vs. engine.** Our design is a better *chassis* — N-model, multi-provider,
   multi-signal, pluggable rules, header control, drop-in OpenAI proxy, OTel. RouteLLM is
   a better *engine* — its routing decision is **trained on human-preference data and
   empirically validated** (e.g. ~95% GPT-4 quality at a fraction of strong-model calls).
2. **Our routing intelligence is unvalidated.** Our signals come from a generic LLM
   classifier prompt and our strategy weights are hand-tuned YAML. We have *no evidence*
   they route well on real traffic.
3. **RouteLLM largely avoids the per-request LLM tax.** Its recommended `mf` router uses
   **no generative LLM at decision time** (at most a lightweight embedding + small math).
   `bert`/`causal_llm` are language models but purpose-trained and run locally — not a
   per-request prompt to a general chat model. This is the opposite of our approach, which
   pays for a full classifier LLM call on every routed request (the irony flagged in
   [ADR 0003](../decisions/0003-rule-and-scoring-engine.md)).

### Two claims we tested (both **false**)

- ❌ *"Drop in either and get all the benefits plus the gateway."* You can use RouteLLM as
  the **whole** router (inherit its validated quality, but collapse to 2 models and lose
  the gateway's value) **or** as a **signal into our scorer** (keep the gateway, but its
  published benchmark no longer transfers once its output is re-mapped through our
  unvalidated weights). You get one or a blend — not both intact.
- ❌ *"The only thing between us and a better router is tuned weights."* Tuned weights are
  necessary but insufficient. The bigger gates are **signal quality** (weights can't fix
  noisy inputs) and **evaluation** (you can't *claim* better without measuring, and you
  can't tune weights without an eval loop to tune against).

## The proposal under discussion: a cascade router

Run RouteLLM (as a **backend API/sidecar** for the online path; a **console app** for
offline calibration/eval) and use its **confidence** — the distance of its win-probability
from the threshold — as a **Stage-1 gate**:

- **Confident** (far from threshold) → act on RouteLLM's cheap decision.
- **Unconfident** (near threshold) → escalate for a richer decision.

This is a classic cheap-fast-first / escalate-the-ambiguous-middle cascade, and it would
directly remove the per-request LLM tax for the easy/obvious cases.

## Open questions (why it's unresolved)

1. **Currency mismatch.** RouteLLM answers a **binary** strong/weak question ≈ *one signal
   (difficulty)*. Our N-model scorer consumes **several** signals (task type, sensitivity,
   etc.). On the confident fast path we'd be routing on difficulty alone unless we fill the
   other signals with cheap deterministic defaults. **Is difficulty-only fast-path routing
   acceptable, or must we backfill the other signals?**
2. **Escalation direction (the sharp one).** The original idea was: unconfident → escalate
   to **our LLM classifier**. But that hands the *hardest* cases to our *least-validated*
   component, which could lower quality. Alternatives to weigh:
   - Escalate ambiguous cases to the **strong model directly** (safe, simple).
   - Escalate to a **heavier RouteLLM router** (`causal_llm`) — stay in the validated family.
   - Only escalate to the LLM classifier **after** measuring it beats these on the band.
3. **Online shape.** A per-request Stage-1 gate must be an **API/sidecar** (or in-process on
   the Python branch). A console app fits the *offline* role (training, threshold
   calibration, eval), not the runtime gate — likely we need both.
4. **Language/runtime.** RouteLLM is Python; `main` is the TypeScript runtime. Integration
   means a **Python sidecar** the TS proxy calls, or making Python the primary runtime.
   Operational cost: a service, HF weight downloads, an extra hop (co-locate to reduce it).
5. **Band width / calibration.** How wide is "unconfident"? The δ around the threshold
   trades cost vs. accuracy and can't be set without measurement.

## Blocking dependency

Every open question above routes through the same missing capability: an **evaluation
harness** — replay representative prompts, route them, measure cost-vs-quality against
fixed-model baselines. It's the prerequisite for setting the escalation band, justifying
the fallback, and validating any "better router" claim. It's also the natural precursor to
the offline ML module ([ADR 0005](../decisions/0005-offline-ml-module.md)).

## Options currently on the table (none chosen)

- **(0)** Do nothing yet — build the eval harness first, decide after we can measure.
- **(A)** RouteLLM sidecar as a **learned difficulty signal** feeding our scorer.
- **(B)** RouteLLM sidecar as a **Stage-1 confidence gate** with escalation (this note),
  with the escalation target still open (strong-model-direct vs. heavier router vs.
  classifier).
- **(C)** Adopt RouteLLM's server as the whole router (rejected-ish — collapses to 2 models).
- **(D)** Watch **LLMRouter** for native N-model learned routing as a future alternative.

## Suggested next step

Build the **evaluation harness** first. It unblocks every branch here and converts
"our design is better" from an architectural assertion into a measurable one.

## Related

- [ADR 0003 — Rule & Scoring Engine](../decisions/0003-rule-and-scoring-engine.md)
- [ADR 0005 — Offline ML as a Separate Module](../decisions/0005-offline-ml-module.md)
