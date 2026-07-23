# Deploying to Azure

Deploys `corgi-ai-gateway` to **Azure Container Apps**, publicly reachable over
HTTPS, with **no gateway or app registration in front of it**.

```
internet ──HTTPS──▶ Container Apps ingress ──▶ router container (:8000)
                                                    │
                                    App Insights ◀──┘ (OpenTelemetry, ADR 0008)
```

## Two shapes

| | `-DemoOnly` (recommended) | Full proxy |
|---|---|---|
| Purpose | Publish the decision inspector | Actually route traffic |
| Keys deployed | Classifier only | Classifier + provider keys |
| `AUTH_ISSUER` | **Unset on purpose** | Required |
| `/demo`, `/v1/router/explain` | Public | Only with `-DemoEnabled` |
| `/v1/chat/completions` | **401 to everyone** | OAuth JWT required |
| Worst-case spend | One cheap classifier call per inspect | Real model calls |

### Demo-only

```powershell
./deploy.ps1 -ResourceGroup rg-llm-router -Location eastus -DemoOnly
```

This ships the classifier key and **no provider keys at all**, so nothing can
be forwarded upstream even in principle, and deliberately configures **no OAuth
issuer**.

That last part is the non-obvious bit, and worth understanding rather than
trusting: **auth stays enabled, so with no issuer to validate against the
gateway fails closed** — every `/v1` request is 401 (ADR 0015). The inspector
still works because `/demo` and `/v1/router/explain` are registered *ahead* of
the auth middleware — Hono runs matching handlers in registration order.

The container app's root URL lands on the inspector — `/` redirects to `/demo`
(302), so the hostname Azure hands you is the shareable link with no path to
remember. With the inspector off, `/` falls back to `/docs` instead.

The result is a public page that demonstrates the routing decision, and a
deployment whose maximum possible cost is one `gpt-4.1-nano` call per click.
`test/demoonly.test.ts` pins this posture so a future reordering of the routes
cannot quietly turn the inspector off — or the proxy on.

### Full proxy

```powershell
./deploy.ps1 -ResourceGroup rg-llm-router -Location eastus
```

Here the app is on the public internet with nothing in front of it, so its own
OAuth JWT validation is the only thing protecting it. `AUTH_ISSUER` (and usually
`AUTH_AUDIENCE`) must be set — a discovery URL for your OIDC provider; callers
present a client-credentials JWT. `deploy.ps1` refuses to run otherwise. Add
`-DemoEnabled` to also expose the
inspector — but note that combination puts an unauthenticated, token-spending
endpoint on a public URL. `maxReplicas` bounds how fast that can run away, not
whether it can. The hostname contains a generated suffix, which is obscurity,
not security; crawlers find things.

## Prerequisites

- **Azure CLI** — <https://aka.ms/installazurecli>, then `az login`
- An Azure subscription you can create resource groups in
- `.env` at the repo root, populated (`cp .env.example .env`)
- **No local Docker required** — the image is built in Azure by `az acr build`

## Switches

| Switch | Default | Notes |
|---|---|---|
| `-Location` | `eastus` | Any region with Container Apps |
| `-NamePrefix` | `llmrouter` | Seeds all resource names; 3–17 lowercase alphanumerics |
| `-DemoOnly` | off | Inspector only: classifier key, no provider keys, `/v1` closed |
| `-DemoEnabled` | off | Exposes `/demo` + `/v1/router/explain` unauthenticated (implied by `-DemoOnly`) |
| `-MinReplicas` | `0` | Scale to zero — costs nothing idle, cold start on first hit |
| `-MaxReplicas` | `3` | Ceiling on concurrency, and on runaway spend |
| `-ImageTag` | git short SHA | Pass an existing tag to redeploy without rebuilding |
| `-WithRouteLLM` | off | Deploy the RouteLLM sidecar — see the section below; it bills continuously |
| `-SidecarMinReplicas` | `1` | `0` scales the sidecar to zero at the cost of multi-minute warm-ups |
| `-SubscriptionId` | current | Target a specific subscription |

## What gets created

| Resource | Purpose |
|---|---|
| Container Registry (Basic) | Holds the image. Admin account **disabled** — the app pulls with a managed identity. |
| Log Analytics workspace | Container stdout/stderr, 30-day retention |
| Application Insights | Backend for the Azure Monitor OTel exporter the app already supports |
| User-assigned managed identity | `AcrPull` on the registry, so no registry credentials exist to leak |
| Container Apps environment | Runtime, wired to Log Analytics |
| Container App | The router: external ingress, HTTPS only, probes on `/healthz` |

## How the pieces fit

`deploy.ps1` runs three independently re-runnable phases:

1. **`infra.bicep`** — everything except the app. Separate because the app
   cannot be created until an image exists, and the registry is created here.
2. **`az acr build`** — builds the image *in Azure* from this source tree and
   tags it with the git short SHA, so a deployed revision is traceable to a commit.
3. **`app.bicep`** — the container app, wired to the image and to secrets.

Re-running is safe. To ship a code change, re-run `deploy.ps1`: it builds a new
tag and rolls a new revision.

## Secrets

Read from `.env` at deploy time and passed as `@secure()` parameters, so they
land in Container Apps secrets and are referenced by `secretRef` rather than
being inlined as environment values. They are never written to a parameters
file and never printed — the script reports only whether each key was *found*.

`.env` itself stays gitignored. Nothing in this folder contains a credential.

Provider keys are optional individually. A vendor whose key is absent simply is
not wired in; its models stay in the catalog **for inspection** but cannot be
forwarded to. This is exactly what makes `-DemoOnly` work: the inspector ranks
all 32 models and explains the decision without any ability to act on it.

## Config overrides

`config/*.yaml` is baked into the image, so the deployment flips the few
switches that legitimately differ from local dev via environment variables
(handled centrally in `src/config.ts`):

| Variable | Set to | Why |
|---|---|---|
| `AZURE_MONITOR_ENABLED` | `true` | Turn on the App Insights exporter |
| `OTEL_CONSOLE_EXPORT` | `false` | Otherwise every span is duplicated into container stdout |
| `DEMO_ENABLED` | `-DemoEnabled` | Inspector off unless asked for |
| `ROUTELLM_ENABLED` | `-WithRouteLLM` | Off unless the sidecar is deployed |
| `ROUTELLM_URL` | sidecar internal URL | Only set when the sidecar is deployed |

## Operating it

```powershell
# tail logs
az containerapp logs show -n llmrouter-app -g rg-llm-router --follow

# revisions
az containerapp revision list -n llmrouter-app -g rg-llm-router -o table

# roll back
az containerapp ingress traffic set -n llmrouter-app -g rg-llm-router --revision-weight <older-revision>=100
```

Traces, request metrics, and per-model cost attribution land in Application
Insights — see [docs/help/observability.md](../../docs/help/observability.md).

## Cost

With `-MinReplicas 0` the app scales to zero and the compute bill at rest is
nil; you pay for the registry (Basic, a few dollars a month), Log Analytics
ingestion, and App Insights ingestion.

The variable cost is **provider tokens**, which is why the shape you pick
matters more than the Azure bill. Under `-DemoOnly` the ceiling is one
`gpt-4.1-nano` classifier call per inspection — fractions of a cent, and no
model call is even possible. Under the full proxy with `-DemoEnabled`, an
unauthenticated caller can trigger classifier calls at whatever rate
`maxReplicas` allows.

## Teardown

```powershell
./teardown.ps1 -ResourceGroup rg-llm-router
```

Deletes the whole resource group — registry, images, logs and App Insights
history included. It prints the contents and prompts before doing it.

## The RouteLLM sidecar (optional, off by default)

`sidecar.bicep` deploys the RouteLLM signal service ([ADR 0006](../../docs/decisions/0006-leveraging-learned-routing.md))
as a second container app with **internal-only ingress**, so nothing outside the
environment can reach it. The router addresses it over the environment's
internal DNS at `http://llmrouter-sidecar`, which is why the app name is part of
the contract rather than cosmetic.

```powershell
./deploy.ps1 -ResourceGroup rg-llmrouter-demo -Location eastus2 -DemoOnly -WithRouteLLM
```

**It is off by default for two reasons, both worth understanding before turning
it on.**

**1. It bills continuously.** The sidecar loads PyTorch and downloads a
checkpoint from HuggingFace at startup, which takes minutes. That makes
scale-to-zero self-defeating: after an idle period the next visitor gets
"RouteLLM unavailable" while the model reloads, so on a public demo most
visitors would see it broken. Keeping it resident (`-SidecarMinReplicas 1`, the
default) means 1 vCPU / 2 GiB running 24/7 — on the order of **$60–80/month**
whether or not anyone visits, against roughly $5/month for the demo-only
deployment. `-SidecarMinReplicas 0` trades that bill for the cold-start problem.

**2. It needs an OpenAI key.** The `mf` router embeds prompts through OpenAI, so
the sidecar container requires `OPENAI_API_KEY` even though it never runs a
completion. In a `-DemoOnly` deployment the *router* container deliberately has
no provider keys at all; adding the sidecar puts one into the environment for
the first time. It lives only in the sidecar, which has no external ingress, so
`/v1/chat/completions` remains incapable of forwarding — but it is a real change
to the deployment's exposure, and each inspection then costs a classifier call
*plus* an embedding call.

Resourcing note: 2 GiB is not generous padding. Under-provisioning memory shows
up as the container being killed part-way through loading the model, which reads
like a crash loop rather than an OOM.

## Not included

- Custom domain / TLS certificate (Container Apps gives you a `*.azurecontainerapps.io`
  hostname with a managed certificate). Worth noting the generated hostname
  changes if you tear down and redeploy, which breaks any published link.
- A CI/CD pipeline — this is a scripted manual deploy. GitHub Actions with OIDC
  federation to Azure would be the natural next step.
