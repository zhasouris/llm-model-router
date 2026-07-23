# ADR 0014 — Official .NET Client (RouterClient) and Its Router-Side Prerequisites

- **Status:** Proposed (plan; the client is a separate codebase). Includes the
  distribution & repository-topology decision (polyrepo; versioned contract, not co-bundled binaries).
- **Date:** 2026-07-23
- **Context repo:** `llm-model-router` — this ADR records the **router-side** commitments
  (R1–R4). The client itself (`RouterClient`, a .NET package set) lives in its own
  repository; its internal design ADRs are referenced but not renumbered into this repo's
  `docs/decisions/` sequence.

## Context

The proxy is deliberately **stateless** — every request is classified and routed on its own
([ADR 0003](0003-rule-and-scoring-engine.md)). But batch runs, scheduled jobs, and agent
loops are stateful *across* requests, and a stateless proxy has nowhere to hold that state.
Four capabilities need a client to exist at all: **pinning** (decide once for a homogeneous
batch, then execute N times without re-paying classification or breaking provider prompt
caching), **run-level budget** (cumulative spend across a job, vs. the per-request
`X-Router-Max-Cost`), **decision capture** (surfacing `X-Router-Model`/`-Reason`/`-Warning`
when a framework like Semantic Kernel owns the call), and **run aggregation** (one structured
summary per job).

This is **not** the advisory-mode client that was
[proposed and reverted earlier](../TODO.md) (commit `4a7aa24`). That design had the client
make the vendor call *itself*, moving provider keys and policy enforcement out of the proxy —
rejected because a self-hosted proxy already sits inside the trust boundary, so nothing was
gained. **RouterClient is the opposite:** every call still routes *through* the proxy. No keys
move, no policy weakens, there is no second data path. The client adds cross-request *state
and ergonomics* on top of the existing routed path — which is exactly the thing the stateless
proxy cannot do and should not try to.

The initial target is **Semantic Kernel (.NET)**. SK resolves one `OpenAIClient` from DI at
construction and owns it for the process lifetime, which forces two design constraints the
client must respect (see Decision).

A **project reorg is pending** to house the client alongside this repo; this ADR does not
prescribe the topology, only that the client is a separate package/repo and that R1–R4 are
owned here.

## Decision

**Build an official .NET client, `RouterClient`, and commit to the four router-side changes
(R1–R4) it depends on.** The full, authoritative build plan is preserved verbatim in the
appendix. Two decisions in it are load-bearing and are called out here because they explain
*why the client is even possible* without forking the OpenAI SDK:

1. **Configure a genuine `OpenAIClient`; never subclass, proxy, or reimplement it.** The
   client sets `OpenAIClientOptions.Endpoint` to the router and adds a `System.ClientModel`
   **`PipelinePolicy`** that injects `X-Router-*` request headers and captures the response
   headers. Because the returned object is a *real* `OpenAIClient`, it drops into
   `AddOpenAIChatCompletion(modelId, client)` and any third-party library that accepts one,
   with zero compatibility surface of our own. (Client repo's ADR-001.)

2. **Ambient scopes over `AsyncLocal<T>` as the primary API**, because SK never lets the
   caller hand a different client to an already-built `Kernel`. `BeginScope(...)` sets
   strategy/budget/pin ambiently; the pipeline policy reads it per request. Derived clients
   (`With(...)`) remain a secondary API. (Client repo's ADR-002.)

### What this repo owns — router-side prerequisites (R1–R4)

| # | Change | Status | Notes |
|---|---|---|---|
| **R1** | `X-Router-Pin: <model>` **request** header — force a model *and* mark it a pin (not a bypass) so telemetry separates the two | **New** | Extends the header contract ([ADR 0002](0002-router-header-contract.md)). `X-Router-Bypass` exists but conflates pin and bypass. |
| **R2** | `POST /v1/router/explain` — dry-run returning the decision (model, reason, scores, filtered-out candidates) without executing | ✅ **Already shipped** | Built this session; returns `decision`, `ranked` (with scores), `excluded`, `signalProvider`, `routingMs`. Satisfies R2 as-is. |
| **R3** | `X-Router-Cost-Usd` **response** header — the router's own per-call cost estimate | **New (number exists)** | `estimatedCost` is already computed in `router.ts`; R3 is emitting it as a header. Avoids duplicating pricing in the client (which would drift). Extends ADR 0002. |
| **R4** | `X-Router-Decision-Id` **response** header — opaque id correlating a decision to router-side telemetry | **New** | Ties to observability ([ADR 0008](0008-observability.md)); distinct from W3C trace ids, which the client also propagates. |

So one of four is done, and R3 is emitting a value the router already has. R1 and R4 are the
genuinely new surface, both additive response/request headers under the ADR 0002 contract.

**On R3, explicitly:** the client *could* compute cost from response `usage` tokens against a
locally fetched catalog, but that duplicates pricing logic in two places and will drift out of
truth — the same failure mode ADR 0010 flags for competency metadata and ADR 0009 for
region/retention. The router already knows the number; it should emit it. If R3 slips, the
client implements a clearly-labelled *estimate* behind an interface so the swap is trivial.

### Distribution & repository topology

There will be **multiple language-specific clients** (.NET first, then TypeScript and Python).
How they ship, and how they stay in step with the server, is decided here so every future
client follows the same rule.

**Clients and the server are separate artifacts, published to their native channels — never
co-bundled as combined "release binaries."** They are consumed by different roles, through
different registries, at different times:

| Component | Ships as | Installed by |
|---|---|---|
| Server (`llm-model-router`) | Docker image (already), optionally a standalone binary | whoever *operates* the router |
| .NET client | NuGet package | an app *developer* (`dotnet add package`) |
| TypeScript client | npm package | `npm install` |
| Python client | PyPI package | `pip install` |

Co-packaging a NuGet artifact with a container image does not match how either is installed —
the operator and the developer are frequently different people who never interact. Bundling
would only ship a version mismatch together, not prevent one.

**The real coupling — contract drift — is solved by a versioned contract, not co-distribution:**

- The `X-Router-*` header contract ([ADR 0002](0002-router-header-contract.md)) is versioned as
  a **Router Protocol version**. The server advertises the version it speaks; each client
  declares the minimum it requires.
- The contract is published as a **machine-readable spec** — the server already emits OpenAPI
  documenting the `X-Router-*` headers (`src/openapi.ts`); it is extended to fully specify
  R1–R4 and versioned. Clients validate/generate against that one spec.
- A **language-neutral conformance suite** (request/response fixtures over the headers) is run
  in CI by the server *and every client*. That — not bundling — is what keeps N clients honest,
  and it matches the eval harness's "prove it, don't assert it" posture.

**Repository topology: polyrepo — each client in its own repository**, not a monorepo. The
server's header contract is deliberately stable (ADR 0002 is Accepted), which removes the
monorepo's one real advantage (atomic cross-client changes for a churning contract) while the
polyrepo keeps each client native to its ecosystem: a .NET repo *is* a .NET repo, publishing to
NuGet is trivial without path-scoped release plumbing, and each package links to a focused repo
rather than a large polyglot one. A mixed-language monorepo (Node + .NET + Python CI and
triple-registry publishing) is a real tax paid for a benefit a stable contract does not need.

The "read as one stack" goal (§9 of the plan) is met without a monorepo: a shared GitHub org,
cross-linked READMEs, and the versioned contract spec as the common spine.

> **Revisit trigger.** If the protocol starts changing often enough that keeping N client repos
> in lockstep becomes the dominant cost, the monorepo trade flips. This chooses polyrepo on
> *today's* stable-contract reality, not permanently.

## Consequences

**Positive**

- Makes routing control first-class in SK projects **without** replacing the OpenAI client —
  the pipeline-policy approach has no version-coupling to SDK internals, because
  `System.ClientModel` policies are a supported extension point.
- The four cross-request capabilities become real, and none of them require the client to
  make routing decisions — the router decides, the client *remembers*. That keeps the trust
  boundary and the single data path intact.
- R1/R3/R4 are small, additive header work; R2 is done; the router's OTel already emits the
  `traceparent` the client relies on for end-to-end spans.

**Negative / accepted trade-offs**

- **Pinning is, strictly, a way of turning routing off** for a batch — and a reviewer will
  notice the product's headline is per-request decisions while the client's headline feature
  is *not* re-deciding. The plan's answer is the right one and must be built, not skipped: a
  **homogeneity check** (`PinAsync` explains the first N requests and warns/throws if they
  would not all route the same way), so pinning is only applied where it is provably safe.
  This matches the honest-measurement posture of the eval harness rather than papering over
  the tension.
- **A second repo to keep in step.** R1–R4 are a contract between two codebases; the header
  names and semantics must not drift. They live under the ADR 0002 contract precisely so there
  is one authority for them.
- **SK's abstractions churn** faster than the OpenAI SDK's — hence the plan's core/SK package
  split, so the reusable core outlives an SK major version.

### Scope boundaries (carried from the plan — **do not build**)

- A wrapper, proxy, or subclass of `OpenAIClient`.
- Any reimplementation of the chat/completion surface.
- **Client-side routing logic** — the router decides, the client remembers.
- Azure OpenAI-specific support in v1 (endpoint/auth model differ; defer).

## Related

- [ADR 0002 — Router Header Contract](0002-router-header-contract.md) (R1/R3/R4 extend it)
- [ADR 0003 — Rule & Scoring Engine](0003-rule-and-scoring-engine.md) (the stateless engine the client wraps state around)
- [ADR 0008 — Observability](0008-observability.md) (R4 decision id; end-to-end traces)
- [ADR 0009](0009-sensitive-data-routing.md) / [ADR 0010](0010-per-task-competency-scores.md) (the "metadata drifts if duplicated" argument behind R3)
- The reverted **advisory-mode client** ([docs/TODO.md](../TODO.md) history, commit `4a7aa24`) — the design this one is deliberately *not*.

---

## Appendix — Authoritative build plan (verbatim)

> The plan below is the authoritative specification for the **`RouterClient` .NET repository**.
> Its internal `ADR-001` / `ADR-002` / `docs/adr/` references belong to **that** repo's own
> ADR sequence and are distinct from this repo's `docs/decisions/` numbering. Only R1–R4 above
> are commitments of `llm-model-router`.

# RouterClient (.NET) — Build Plan
**A .NET client for `llm-model-router` that makes routing control first-class in
Semantic Kernel projects — without replacing the OpenAI client.**

---

## 0. Instructions for the implementing agent

This document is the authoritative build plan. Work through the phases in order.
Where this says **DECISION**, record an ADR in `docs/adr/` before implementing. Where it
says **DO NOT**, treat it as a hard scope constraint. Where it says **PREREQUISITE
(router)**, that work lands in the `llm-model-router` repository first — this client
cannot be completed without it.

**Before writing code**, verify the current APIs of `OpenAI` (the official .NET SDK, v2.x)
and `Microsoft.SemanticKernel.Connectors.OpenAI`. Both moved significantly during the
`Azure.AI.OpenAI` → `OpenAI` + `System.ClientModel` transition, and exact type and method
names must be confirmed rather than assumed. Record findings in `docs/sdk-notes.md`.

---

## 1. Premise

The proxy is deliberately stateless. Batch runs, scheduled jobs, and agent loops are
inherently stateful *across* requests. **This client is where that cross-request state
lives.** That is its entire justification — not header ergonomics.

Concretely, it provides four things a stateless proxy cannot:

1. **Pinning** — decide once for a homogeneous batch, then execute N times without
   re-paying classification latency and spend, and without breaking provider prompt
   caching by switching models mid-run.
2. **Run-level budget** — cumulative spend tracking across a run, with abort or
   strategy-downshift on approach. `X-Router-Max-Cost` is per-request; jobs care about
   the total.
3. **Decision capture** — surfacing `X-Router-Model` / `-Reason` / `-Warning` to the
   caller, which is otherwise buried because Semantic Kernel owns the call.
4. **Run aggregation** — one structured summary per job (model distribution, spend,
   degraded-classifier count) instead of N log lines.

---

## 2. Hard constraint: do not wrap or subclass `OpenAIClient`

Semantic Kernel accepts an `OpenAIClient` instance and calls it internally. Any type that
is not *actually* an `OpenAIClient` cannot be injected, and the package's usefulness
collapses to code the author personally wrote.

**DECISION — ADR-001.** This library does not subclass, proxy, or reimplement
`OpenAIClient`. It **configures a genuine `OpenAIClient`** by:

- setting `OpenAIClientOptions.Endpoint` to the router base URL, and
- adding a custom `PipelinePolicy` to the `System.ClientModel` pipeline.

The policy is the entire interception mechanism. It injects `X-Router-*` request headers
and captures `X-Router-*` response headers. Because the returned object is a real
`OpenAIClient`, it drops into `AddOpenAIChatCompletion(modelId, client)` and into any
third-party library that accepts one, with zero compatibility surface of our own.

This is a better fit than the equivalent JS/Python design, and the ADR should say so:
`System.ClientModel` pipeline policies are a first-class, supported extension point, so
this library has no version-coupling to SDK internals.

**DO NOT** attempt to intercept via `HttpClient`/`DelegatingHandler` as the primary
mechanism. It works, but it sits below the pipeline and loses the SDK's retry and
telemetry context. Pipeline policy is the correct layer.

---

## 3. Second key decision: ambient scopes, not derived clients

**DECISION — ADR-002.**

In a JS/Python client the natural ergonomic is an immutable derived client
(`router.with({ strategy: 'cost' })`). **That does not fit Semantic Kernel.** SK resolves
one client from DI at construction time and owns it for the process lifetime; the caller
never gets to hand a different client to an already-built `Kernel`.

Therefore the primary API is an **ambient scope** flowing over `AsyncLocal<T>`:

```csharp
using var scope = router.BeginScope(new RouterScopeOptions {
    Strategy = RouterStrategy.Cost,
    MaxCostPerCall = 0.002m,
    Budget = 5.00m
});
var result = await kernel.InvokePromptAsync("...");   // routed per the scope
```

The pipeline policy reads the current ambient scope on each request and writes the
appropriate headers. When no scope is active, no `X-Router-*` request headers are sent
and the router applies its own defaults — an unscoped client behaves exactly like a plain
OpenAI client pointed at the proxy.

Derived clients remain available as a secondary API (`router.With(...)` returning a new
configured `OpenAIClient`) for callers constructing their own kernels per unit of work.

**Async caveat to handle and test:** `AsyncLocal` flows into child tasks but does not flow
*back* out. Concurrent work started inside a scope inherits it correctly; work started
before the scope does not. Document this. For parallel batches, the scope must be entered
inside each worker task, or the derived-client form used instead.

---

## 4. Router-side prerequisites

These land in `llm-model-router` before or alongside this client. Track them as issues
there, not here.

| # | Change | Needed for |
|---|---|---|
| R1 | `X-Router-Pin: <model>` request header — force a specific model *and* record that it was a pin rather than a bypass, so telemetry can distinguish them | Pinning |
| R2 | `POST /v1/router/explain` — dry-run returning the decision (chosen model, reason, score, filtered-out candidates) without executing the completion | Pinning, homogeneity check, demo |
| R3 | `X-Router-Cost-Usd` response header — the router's own estimate for the call | Budget tracking |
| R4 | `X-Router-Decision-Id` response header — opaque id correlating a decision to router-side telemetry | Decision capture, audit |

**On R3:** the client could instead compute cost from response `usage` tokens against a
locally fetched catalog, but that duplicates pricing logic in two places and will drift.
Have the router emit the number it already knows. If R3 slips, implement a temporary
client-side estimate behind an interface so the swap is trivial, and mark it clearly as
an estimate in the run summary.

---

## 5. Package layout

Three packages, so the core is usable without Semantic Kernel:

```
RouterClient                    # core: options, policy, scopes, decisions, budget
  └─ depends on: OpenAI, System.ClientModel  (NOT Semantic Kernel)
RouterClient.SemanticKernel     # SK integration: kernel builder extensions, filters
  └─ depends on: RouterClient, Microsoft.SemanticKernel.Abstractions
RouterClient.Extensions.DependencyInjection   # IServiceCollection wiring, IOptions
```

Target `net8.0` and `net9.0`. Nullable enabled, warnings as errors, deterministic builds,
source link, and a strong-named assembly.

**DO NOT** take a Semantic Kernel dependency in the core package. SK's abstractions churn
faster than the OpenAI SDK's, and a core package that outlives an SK major version is
worth more.

---

## 6. Core API surface

### 6.1 Construction and DI

```csharp
services.AddRouterClient(options =>
{
    options.Endpoint = new Uri("https://router.internal/v1");
    options.ApiKey   = builder.Configuration["Router:Key"];
    options.DefaultStrategy = RouterStrategy.Balanced;
    options.CaptureDecisions = true;
});
// Registers: IRouterClient, OpenAIClient (configured), IRouterDecisionSink
```

Then, in the kernel builder:

```csharp
kernelBuilder.AddOpenAIChatCompletion(
    modelId: "auto",
    openAIClient: sp.GetRequiredService<OpenAIClient>());
```

Support keyed registration so multiple router configurations can coexist
(`AddRouterClient("batch", ...)`), which matters for apps with both an interactive path
and a scheduled path.

**Note the `modelId: "auto"` convention.** SK requires a model id and sends it in the
body; the router treats `"auto"` as "you decide". Document this prominently — it is the
single most likely point of confusion for an SK user, and the README quickstart must show
it.

### 6.2 Strategy typing

Strategies come from the router's `strategies.yaml` and are user-extensible, so a closed
`enum` would be wrong. Use the extensible-enum pattern already idiomatic in
`System.ClientModel` and the Azure SDKs:

```csharp
public readonly record struct RouterStrategy(string Value)
{
    public static RouterStrategy Cost     => new("cost");
    public static RouterStrategy Quality  => new("quality");
    public static RouterStrategy Latency  => new("latency");
    public static RouterStrategy Balanced => new("balanced");
    public static implicit operator RouterStrategy(string value) => new(value);
    public override string ToString() => Value;
}
```

Well-known values give IntelliSense; custom strategies still compile.

### 6.3 Decision capture

Two mechanisms, both fed by the pipeline policy:

**Ambient (for "what did it just pick"):**

```csharp
using var scope = router.BeginScope(RouterStrategy.Quality);
var answer = await kernel.InvokePromptAsync(prompt);
var decision = scope.LastDecision;   // model, reason, warnings, costUsd, decisionId
```

**Sink (for aggregation and logging):**

```csharp
public interface IRouterDecisionSink
{
    void Record(RouterDecision decision);
}
```

Default implementation aggregates into the active scope and writes an `ILogger` structured
event. Users can supply their own for a metrics backend.

**Streaming works.** SSE response headers arrive before the body, so the policy captures
the decision at response-start; the caller has it before the stream completes. Add an
explicit test for this — it is a question a reviewer will ask.

### 6.4 Pinning

```csharp
var pin = await router.PinAsync(sampleRequest, new RouterScopeOptions {
    Strategy = RouterStrategy.Cost,
    SampleSize = 5,          // homogeneity check
    OnHeterogeneous = HeterogeneityBehaviour.Warn
});
using var scope = router.BeginScope(pin);
foreach (var item in items)
    await kernel.InvokePromptAsync(item.Prompt);
```

`PinAsync` calls `/v1/router/explain` (R2) rather than executing a completion, so pinning
costs nothing.

**Homogeneity check — build this, do not skip it.** Pinning is, strictly, a way of turning
the router off, and a reviewer will notice that the product's headline feature is
per-request decisions while the client's headline feature is not making them. The answer
is that pinning is only safe for *homogeneous* batches — and that should be proven, not
assumed. When `SampleSize > 1`, `PinAsync` explains the first N requests; if they would
not all route to the same model, it warns (or throws, per `OnHeterogeneous`) with the
divergent models named. This turns an apparent contradiction into a measured feature and
matches the honest-measurement posture of the router's eval harness.

### 6.5 Budget and run summary

```csharp
var summary = await router.RunAsync(new RouterScopeOptions {
    Strategy = RouterStrategy.Cost,
    Budget = 5.00m,
    OnBudgetExceeded = BudgetBehaviour.Abort   // or DownshiftStrategy
}, async ct =>
{
    foreach (var item in items)
        await kernel.InvokePromptAsync(item.Prompt, cancellationToken: ct);
});
// summary: TotalCostUsd, CallCount, ModelCounts, Warnings,
//          DegradedClassifierCount, Decisions[]
```

`BudgetBehaviour.Abort` cancels via the supplied `CancellationToken`.
`DownshiftStrategy` switches the ambient scope to `cost` at a configurable threshold
(default 80%) and records the switch in the summary. Budget accounting must be
thread-safe — use `Interlocked` on a decimal-as-long cents counter or a lock; batches are
frequently parallel.

### 6.6 Telemetry

- `ActivitySource` named `RouterClient` with spans for `Router.Pin`, `Router.Run`, and
  `Router.Call`, tagged with chosen model, strategy, reason, and decision id.
- W3C `traceparent` propagates automatically through the pipeline; verify it reaches the
  router and links spans end to end. This is the payoff of the OTel work already in the
  proxy — a trace showing the routing decision inline is a strong demo.
- `ILogger` structured events, never string-interpolated.

---

## 7. Phasing

### v1 — the shippable thing

- Pipeline policy: request header injection, response header capture
- `RouterClientOptions`, DI registration, keyed registration
- `RouterStrategy` extensible enum
- Ambient scopes (`BeginScope`) + derived clients (`With`)
- Decision capture: ambient `LastDecision` + `IRouterDecisionSink`
- `PinAsync` with homogeneity check (requires R1, R2)
- `RunAsync` with budget, abort/downshift, and run summary (requires R3)
- SK integration package + kernel builder extension
- `ActivitySource` spans, traceparent verification
- Sample: a scheduled batch job showing pin + budget + summary

### v2

- Routing-aware retry: on failure, retry with the failed model excluded — client-side
  failover, which the router's ADRs currently defer
- Routing manifest: persist every decision in a run; replay a batch pinned to those exact
  decisions, so output is reproducible as the catalog and classifier change underneath.
  This matters in regulated environments where "why does this differ from last month" is
  an audit question
- `router.Session()` — sticky model across an agent conversation, preventing mid-dialogue
  tone/format shifts and cache invalidation

### v3 / stretch

- TypeScript parity package
- SK filter (`IFunctionInvocationFilter`) surfacing the decision into
  `FunctionResult.Metadata`, so decisions appear in SK's own telemetry

### DO NOT build

- A wrapper, proxy, or subclass of `OpenAIClient` (see §2)
- Any reimplementation of chat/completion surface area
- Client-side routing logic — the router decides, the client remembers
- Azure OpenAI-specific support in v1 (the endpoint and auth model differ; defer)

---

## 8. Testing

- **Hermetic transport tests.** A stub `PipelineTransport` returning canned responses with
  `X-Router-*` headers. No network in CI.
- **Header matrix.** Every combination of scope options → expected request headers.
  Table-driven.
- **AsyncLocal semantics.** Explicit tests for: nested scopes, parallel workers inside a
  scope, scope not leaking to sibling tasks, disposal restoring the prior scope.
- **Streaming decision capture.** Assert the decision is available before stream
  completion.
- **Budget concurrency.** Parallel calls against a budget; assert no overspend and
  deterministic abort.
- **Homogeneity check.** Divergent explain responses → warn/throw as configured.
- **SK integration test.** A real `Kernel` built with the configured client against the
  stub transport, asserting the call reaches the router with the expected headers. This is
  the test that proves the premise of §2 — treat it as the acceptance gate for v1.

---

## 9. Repository hygiene

Carry over the standards from `llm-model-router`:

- Repository description, topics (`dotnet`, `semantic-kernel`, `openai`, `llm`,
  `routing`), homepage set from day one
- CI badge; green Actions on every push; `dotnet format` enforced
- ADRs in `docs/adr/`, numbered, context / decision / consequences.
  ADR-001 (no subclassing), ADR-002 (ambient scopes over derived clients) are the two that
  demonstrate design judgment — write them properly
- Tagged releases, NuGet packages published from CI, changelog from v0.1.0
- README structure: the §1 premise, then the SK quickstart including the `"auto"` model id
  convention, then pin/budget examples, then architecture. Lead with the batch job sample,
  not the pipeline diagram
- Semgrep config and dependency scanning, matching the existing repo
- Cross-link with `llm-model-router` in both READMEs so the two read as one stack
