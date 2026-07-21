# Vendor transformers (adapters)

The router and clients always speak the **OpenAI chat-completions** shape. A
*transformer* (adapter) translates that to a vendor's API and back — the
hub-and-spoke design from [ADR 0001](decisions/0001-multi-provider-translation-strategy.md).

```
OpenAI request ─▶ adapter.buildRequest    ─▶ native request
native response ─▶ adapter.parseResponse   ─▶ OpenAI response   (non-streaming)
native SSE      ─▶ adapter.transformStream ─▶ OpenAI SSE         (streaming)
```

Each provider in `config/server.yaml` selects one via `adapter:` (default
`openai` = passthrough). Adding a native adapter is additive — implement the
`ProviderAdapter` interface, register it in `src/providers/adapters/index.ts`,
and point a provider at it. No router or scorer changes.

## Status

**Built**

- [x] **passthrough** (`openai`) — identity; OpenAI + every OpenAI-compatible
      vendor. Forwards to `<base_url>/chat/completions` unchanged.
- [x] **anthropic** — native Anthropic **Messages API** (`/v1/messages`):
      system-prompt hoisting, message/content mapping (incl. images + tools),
      response translation, and SSE stream translation. Fixture-tested
      (`test/adapter.test.ts`).

**Planned** (each a future branch; these vendors work today via `passthrough`
against their OpenAI-compatible endpoints — a native adapter is a fidelity
upgrade, not a requirement):

- [ ] **google** — Gemini `generateContent` (roles→`user`/`model`, parts, safety)
- [ ] **cohere** — native Chat API
- [ ] **mistral** — native (compat is close; native for full fidelity)
- [ ] **deepseek** — native
- [ ] **xai** — native
- [ ] **together** / **groq** — hosted open models (compat is generally faithful)

## Which vendor uses which today

| Provider | Adapter | Endpoint |
|---|---|---|
| openai | passthrough | `/chat/completions` (native) |
| **anthropic** | **anthropic** | `/messages` (native Messages API) |
| google, mistral, deepseek, xai, groq, together, cohere | passthrough | their OpenAI-compat `/chat/completions` |

To switch Anthropic back to its OpenAI-compat endpoint, set its `adapter: openai`
in `server.yaml`.

## Notes

- Native adapters are verified with **fixtures** (known OpenAI request → expected
  native body; native response/SSE → OpenAI), so they're testable without a live
  key for that vendor.
- The `anthropic` adapter is wired as the default for the Anthropic provider but,
  like every provider, only forwards when its key (`ANTHROPIC_API_KEY`) is set.
- Adding an adapter: see `src/providers/adapters/anthropic.ts` as the reference
  implementation.
