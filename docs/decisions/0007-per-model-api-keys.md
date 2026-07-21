# ADR 0007 — Per-Model API Keys

- **Status:** Accepted
- **Date:** 2026-07-20
- **Context repo:** `llm-model-router`

## Context

Most LLM vendors let an account hold multiple API keys. Billing dashboards break spend
down **per key**. Today the proxy authenticates every call to a provider with a single
provider-level key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`), so all of a vendor's models
share one key and the vendor can't attribute cost per model.

We want **per-model cost visibility** without building our own billing system — by letting
each model use its own vendor key so the vendor's dashboard does the breakdown.

## Decision

A model in `config/models.yaml` may declare an optional **`api_key_env`** — the name of an
environment variable holding that model's own API key. Key resolution for any upstream
call is:

```
resolveApiKey(provider, modelId):
  1. if the model has `api_key_env` AND that env var is set  -> use it
  2. otherwise                                               -> use the provider default key
```

- Keys stay in the environment (`.env`), never in YAML — `models.yaml` only names the env
  var, consistent with ADR 0004.
- The default remains the provider key, so per-model keys are **opt-in** and nothing breaks
  when they're absent.
- Applied everywhere the proxy authenticates upstream: the **forwarder** (uses the chosen
  model's key) and the **classifier** (uses the classifier model's key, else provider key).

Implementation: `AppConfig.resolveApiKey(provider, modelId?)` in `src/config.ts`;
`ModelDescriptor.apiKeyEnv`; the forwarder passes the chosen `model` id through.

## Consequences

**Positive**
- Per-model cost breakdown falls out of the vendor's own billing — no custom metering.
- Opt-in and backward compatible; unset per-model keys transparently fall back.
- Also enables per-model quota isolation and key rotation.

**Negative / accepted tradeoffs**
- More env vars to manage as models get their own keys.
- Cost attribution is only as granular as the keys created; a model without its own key is
  still billed under the provider default.
- This attributes cost at the vendor; our own OTel-based per-model cost tracking (from token
  usage) remains a separate, complementary option.

## Related

- [ADR 0004 — Stack & Project Layout](0004-stack-and-project-layout.md)
- [ADR 0003 — Rule & Scoring Engine](0003-rule-and-scoring-engine.md)
