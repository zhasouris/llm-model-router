# ADR 0001 — Multi-Provider Translation Strategy

- **Status:** Accepted
- **Date:** 2026-07-19
- **Context repo:** `llm-model-router`

## Context

The project is an API proxy that sits in front of LLM providers. A client points its
SDK at the proxy instead of the provider's endpoint. The proxy inspects the request,
picks the best model for the work, forwards it to the appropriate provider, and returns
the response.

Clients speak a provider's **wire format** (initially OpenAI's `/v1/chat/completions`).
The router may choose a model from a *different* provider than the one whose format the
client used. That decouples inbound request format from the outbound provider and raises
the core problem: **how do we translate between provider formats?**

Provider formats differ in load-bearing ways:

- System prompt placement (top-level field vs. a message role)
- Tool-call / tool-result structures
- **Streaming SSE event formats** (materially different per provider)
- Stop reasons, usage/token accounting fields

### The naive approach and why it fails

Translating each vendor directly to each other vendor is an **N×N** matrix of
translators. Every new provider (Claude, then Ollama, then self-hosted, ...) must be
paired against every existing one. This grows quadratically and becomes unmaintainable.

## Decision

### Long-term target: canonical intermediate representation (hub-and-spoke)

Do **not** translate vendor→vendor. Translate vendor ↔ a neutral internal
representation (IR), and have the router operate **only** on the IR.

```
OpenAI request ─┐                          ┌─→ OpenAI
Claude request ─┤→  Canonical Request/  ─→ ┤─→ Claude
Ollama request ─┘      Response (IR)        └─→ Ollama
   (inbound)                                   (outbound)
```

- **Inbound adapter:** client wire format → canonical IR (parse)
- **Router:** works purely on the IR; never sees or cares about vendor formats
- **Outbound adapter:** IR → chosen provider's format (render); response → IR → client's format

This is **2N adapters** (in + out per provider), growing **linearly**. Inbound format
and outbound provider are fully decoupled: an OpenAI-shaped request routed to Claude is
just `OpenAI-in → IR → Claude-out`.

The cost is designing the IR well — it must be a faithful superset covering system
prompts, tool calls, streaming events, stop reasons, and usage across all providers.
That is real work, which is why it is deferred (see below).

### v1 scope: OpenAI-compatible surface only (translation deferred)

For v1 we sidestep the IR/translation work entirely while still reaching Claude models,
by keeping the whole pipeline OpenAI-shaped end to end:

```
OpenAI-shaped request → router picks model → forward to:
   • OpenAI models  → OpenAI API (native)
   • Claude models  → Anthropic's OpenAI-compatible endpoint
```

No IR and no translation layer are built in v1. Reaching Claude relies on Anthropic's
OpenAI-compatible endpoint.

### Structural promise to keep the punt from becoming a trap

From day one, **the router operates on an internal request object**, even though v1's
adapters are thin pass-throughs. This preserves the seam so that adding the real IR and
native provider adapters later is an *additive* change, not a rewrite.

## Consequences

**Positive**
- v1 ships fast: no translation layer, no IR design up front.
- Claude models are reachable in v1 with minimal code.
- The eventual canonical-IR design grows linearly (2N), not quadratically (N×N).
- The router is insulated from vendor formats from the start.

**Negative / accepted tradeoffs**
- v1 inherits the limitations of Anthropic's OpenAI-compatibility shim — some
  tool-use / streaming / cache-control features may degrade or be unavailable.
- The canonical IR remains a **documented TODO** and must be built before native
  multi-provider translation (and before Ollama / self-hosted providers land cleanly).

## Follow-ups / TODO

The transformer/adapter seam is now implemented — see
[`docs/transformers.md`](../transformers.md) for the live status checklist.

- [x] Adapter seam (`ProviderAdapter`: buildRequest / parseResponse / transformStream)
      with a `passthrough` adapter formalizing the OpenAI-compat path.
- [x] Native **Anthropic** Messages-API adapter (the reference), wired as the default
      for the Anthropic provider; fixture-tested.
- [ ] Native adapters for Google Gemini, Cohere, and the other vendors (future branches).
- [ ] Add adapters for self-hosted / Ollama models.
- [ ] A richer canonical IR if/when a vendor can't be expressed as OpenAI-in/out.

## Related decisions (settled context, not yet separate ADRs)

These were agreed during the same discussion and shape the surrounding design:

- **Header contract.** Routing-by-default, control headers (`X-Router-Strategy`,
  `X-Router-Bypass`), and response transparency headers (`X-Router-Model`,
  `X-Router-Reason`) — see
  [ADR 0002](0002-router-header-contract.md) for the full contract.
- **Rule & scoring engine.** Classifier-backed feature extraction + hard-constraint
  filtering + strategy-weighted model scoring — see
  [ADR 0003](0003-rule-and-scoring-engine.md) for the full engine design.
- **Declarative model catalog.** Candidate models and their attributes (cost, context
  window, vision/tools/JSON support, capability tier, latency) live as config/data, not
  code.
- **Auth.** Assumed the proxy holds provider credentials centrally; clients authenticate
  to the proxy. (To be confirmed.)
- **Endpoint scope (v1).** `/v1/chat/completions` only, plus a `/v1/models` listing;
  embeddings / Responses API deferred.
- **Cross-cutting requirements.** Configurable classifier model; OpenTelemetry
  instrumentation across the board.
- **Providers in scope.** OpenAI and Claude now; self-hosted / Ollama later.
