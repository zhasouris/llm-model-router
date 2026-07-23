/**
 * Hono application factory. Dependencies are injected so tests can supply a
 * fake forwarder (and a router with a stubbed classifier).
 */

import { swaggerUI } from "@hono/swagger-ui";
import { Hono, type Context } from "hono";
import { makeAuth, type KeyResolver } from "./auth.js";
import { getConfig, type AppConfig } from "./config.js";
import { makeAnalyze, type AnalyzeFn } from "./core/analysis.js";
import { NoEligibleModelError, Router } from "./core/router.js";
import {
  fetchRouteLLMScore,
  HeuristicSignalProvider,
  promptText,
  RouteLLMProvider,
} from "./core/signal.js";
import { demoHtml, loadPresets } from "./demo.js";
import { logWarn } from "./logger.js";
import {
  H_DURATION,
  H_MODEL,
  H_REASON,
  H_WARNING,
  parseOptions,
  stripControlHeaders,
} from "./headers.js";
import { openApiSpec } from "./openapi.js";
import { probeProviders } from "./probe.js";
import { Forwarder, type ForwarderLike } from "./providers/forwarder.js";
import type { RoutingDecision, RoutingRequest } from "./types.js";

export interface AppDeps {
  config: AppConfig;
  router: Router;
  forwarder: ForwarderLike;
  /** Optional JWT key resolver — tests inject a local JWKS (ADR 0015). */
  authKeyResolver?: KeyResolver;
}

function buildDeps(): AppDeps {
  const config = getConfig();
  return { config, router: buildRouter(config), forwarder: new Forwarder(config) };
}

/**
 * Wire the signal provider per strategy (ADR 0012).
 *
 * `fast` deliberately does NOT pay for the ~1s LLM classifier: it optimizes for
 * latency within the frontier (ADR 0017), so shaving ~1s off the routing decision
 * matters more than a marginally sharper capability signal. It uses RouteLLM when
 * a sidecar is configured (a real difficulty signal at ~250ms) and otherwise the
 * offline heuristic (~0ms) — never the classifier. Every other strategy keeps the
 * classifier default, where complexity/reasoning carry real weight.
 */
function buildRouter(config: AppConfig): Router {
  const rl = config.server.routellm;
  const fast: AnalyzeFn = rl.enabled
    ? makeAnalyze(new RouteLLMProvider(rl.url))
    : makeAnalyze(new HeuristicSignalProvider(config.server.classifier.max_input_chars));
  return new Router(config, undefined, { fast });
}

function errorResponse(message: string, status: 400 | 401, type: string): Response {
  return new Response(JSON.stringify({ error: { message, type, code: null } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * HTTP header values must be Latin-1. Routing reasons and warnings are
 * human-facing prose and may contain typographic punctuation (an em dash, say),
 * which makes the runtime reject the entire response — so fold anything outside
 * printable ASCII before it reaches a header. The body keeps the original text.
 */
function headerSafe(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "-");
}

function decisionHeaders(decision: RoutingDecision): Record<string, string> {
  const headers: Record<string, string> = {
    [H_MODEL]: headerSafe(decision.modelId),
    [H_REASON]: headerSafe(decision.reason),
    [H_DURATION]: String(decision.routingMs),
  };
  if (decision.warnings.length) headers[H_WARNING] = headerSafe(decision.warnings.join("; "));
  return headers;
}

export function createApp(deps: AppDeps = buildDeps()): Hono {
  const app = new Hono();
  const { config, router, forwarder } = deps;

  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/openapi.json", (c) => c.json(openApiSpec));
  app.get("/docs", swaggerUI({ url: "/openapi.json" }));

  // Landing route. The inspector is the human-facing face of a deployment, so
  // send the root there when it's on and fall back to the API docs when it
  // isn't. 302 rather than 301 on purpose: the target depends on config, and a
  // permanent redirect would stay cached in browsers after the demo is turned
  // off — leaving visitors pinned to a route that no longer exists.
  app.get("/", (c) => c.redirect(config.server.demo.enabled ? "/demo" : "/docs", 302));

  // Which catalog models this deployment can actually reach. A model is
  // *routable* only if a key resolves for it — its own `api_key_env` if set,
  // else the provider default (ADR 0007). Without this, a caller has no way to
  // tell a model that will answer from one that will 401 at forward time.
  const modelAvailability = () =>
    config.catalog.map((m) => ({
      id: m.id,
      provider: m.provider,
      tier: m.tier,
      capabilities: [...m.capabilities],
      available: Boolean(config.resolveApiKey(m.provider, m.id)),
    }));

  const availabilityHandler = (c: Context) => {
    const data = modelAvailability();
    const providers: Record<string, boolean> = {};
    for (const m of data) providers[m.provider] = providers[m.provider] || m.available;
    return c.json({
      object: "list",
      data,
      summary: {
        total: data.length,
        available: data.filter((m) => m.available).length,
        providers,
      },
    });
  };

  // Registered before the auth guard only when the inspector is public, since
  // the demo page needs it unauthenticated. Otherwise it goes behind auth with
  // the rest of /v1 — which vendors a deployment holds keys for is not secret,
  // but it is not something to volunteer to anonymous callers in production.
  if (config.server.demo.enabled) {
    app.get("/v1/router/models", availabilityHandler);
  }

  // Standard decision-explanation endpoint (ADR 0016). Always registered, ahead
  // of the /v1 bearer guard, and anonymous — any caller, no credentials. Runs
  // the full routing pipeline and returns the decision trace, but NEVER forwards
  // a completion; it needs the server-side classifier key for real signals.
  {
    const cls = config.server.classifier;
    const hasClassifierKey =
      config.secrets.classifierApiKey ?? config.resolveApiKey(cls.provider, cls.model);
    if (cls.enabled && !hasClassifierKey) {
      logWarn("classifier API key not configured — /v1/router/explain signals will be degraded", {
        hint: "set CLASSIFIER_API_KEY",
      });
    }
  }

  app.post("/v1/router/explain", async (c) => {
    let raw: Record<string, unknown>;
    try {
      raw = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return errorResponse("invalid JSON body", 400, "invalid_request_error");
    }
    const options = parseOptions((n) => c.req.header(n), config.server.default_strategy);
    const req: RoutingRequest = {
      body: raw,
      options,
      requiresVision: false,
      requiresTools: false,
      requiresStructuredOutput: false,
      requiresAudio: false,
    };
    const result = await router.explain(req);

    // Shadow RouteLLM signal (best-effort; shown alongside the classifier).
    // Enable via server.yaml or the ROUTELLM_ENABLED env override (config.ts).
    const rl = config.server.routellm;
    let routellm: {
      enabled: boolean;
      available: boolean;
      winRate?: number;
      confidence?: number;
    } = { enabled: rl.enabled, available: false };
    if (rl.enabled && !result.bypassed) {
      const score = await fetchRouteLLMScore(rl.url, promptText(req, 8000));
      if (score) {
        routellm = { enabled: true, available: true, winRate: score.winRate, confidence: score.confidence };
      }
    }

    // Mirror the proxy path's response headers (ADR 0002). /v1/router/explain
    // returns the decision as a body, but emitting the same headers lets the
    // demo show exactly what a real client reads off /v1/chat/completions.
    const headers: Record<string, string> = { [H_DURATION]: String(result.routingMs) };
    if (result.decision) {
      headers[H_MODEL] = headerSafe(result.decision.model);
      headers[H_REASON] = headerSafe(result.decision.reason);
    }
    if (result.warnings.length) headers[H_WARNING] = headerSafe(result.warnings.join("; "));

    return c.json({ ...result, routellm }, 200, headers);
  });

  // Decision-inspector demo PAGE. Human-facing; gated by demo.enabled. Its
  // JavaScript calls the anonymous /v1/router/explain above. (Sign-in gate for
  // this page is ADR 0016; not yet implemented.)
  if (config.server.demo.enabled) {
    const presets = loadPresets();
    // Recomputed per request: keys come from the environment, so availability
    // can change on a container restart without the page being rebuilt.
    app.get("/demo", (c) =>
      c.html(
        demoHtml(presets, modelAvailability(), {
          coldStartHint: config.server.demo.cold_start_hint,
        }),
      ),
    );
  }

  // Auth guards the rest of the /v1 surface (models, chat completions).
  app.use("/v1/*", makeAuth(config, deps.authKeyResolver));

  // Kept in the strict OpenAI shape — it is the drop-in compatibility surface,
  // so routing metadata belongs on /v1/router/models rather than here.
  app.get("/v1/models", (c) =>
    c.json({
      object: "list",
      data: config.catalog.map((m) => ({ id: m.id, object: "model", owned_by: m.provider })),
    }),
  );

  if (!config.server.demo.enabled) {
    app.get("/v1/router/models", availabilityHandler);
  }

  // Does each key actually work? Sends the smallest possible completion to the
  // cheapest model of each provider, through the real adapter path.
  //
  // Always behind auth, including on a demo deployment: it spends money on
  // every call, so an anonymous caller must not be able to trigger it. Results
  // are cached for a minute; ?force=true re-probes, ?provider=x narrows.
  app.get("/v1/router/providers", async (c) => {
    const { results, summary } = await probeProviders(config, forwarder, {
      provider: c.req.query("provider"),
      force: c.req.query("force") === "true",
    });
    // 503 when something is configured but broken — a key that is simply absent
    // is a deployment choice, not a fault.
    const broken = summary.bad_key + summary.model_gone + summary.provider_error + summary.unreachable;
    return c.json({ results, summary }, broken > 0 ? 503 : 200);
  });

  app.post("/v1/chat/completions", async (c) => {
    let raw: Record<string, unknown>;
    try {
      raw = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return errorResponse("invalid JSON body", 400, "invalid_request_error");
    }

    const options = parseOptions((n) => c.req.header(n), config.server.default_strategy);
    const req: RoutingRequest = {
      body: raw,
      options,
      requiresVision: false,
      requiresTools: false,
      requiresStructuredOutput: false,
      requiresAudio: false,
    };

    let decision: RoutingDecision;
    try {
      decision = await router.route(req);
    } catch (err) {
      if (err instanceof NoEligibleModelError) {
        return errorResponse(err.message, 400, "invalid_request_error");
      }
      throw err;
    }

    // Rewrite only the model; everything else in the body is untouched.
    const forwardBody = { ...raw, model: decision.modelId };

    const incoming: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => (incoming[k] = v));
    const upstreamHeaders = stripControlHeaders(incoming);

    const stream = raw.stream === true;
    const upstream = await forwarder.forward({
      provider: decision.provider,
      body: forwardBody,
      incomingHeaders: upstreamHeaders,
      stream,
      model: decision.modelId,
    });

    const respHeaders = decisionHeaders(decision);

    if (upstream.stream !== undefined) {
      respHeaders["content-type"] = upstream.headers["content-type"] ?? "text/event-stream";
      return new Response(upstream.stream, { status: upstream.status, headers: respHeaders });
    }

    respHeaders["content-type"] = upstream.headers["content-type"] ?? "application/json";
    return new Response(upstream.body ?? "", { status: upstream.status, headers: respHeaders });
  });

  return app;
}
