/**
 * Hono application factory. Dependencies are injected so tests can supply a
 * fake forwarder (and a router with a stubbed classifier).
 */

import { swaggerUI } from "@hono/swagger-ui";
import { Hono } from "hono";
import { makeAuth } from "./auth.js";
import { getConfig, type AppConfig } from "./config.js";
import { NoEligibleModelError, Router } from "./core/router.js";
import { fetchRouteLLMScore, promptText } from "./core/signal.js";
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
import { Forwarder, type ForwarderLike } from "./providers/forwarder.js";
import type { RoutingDecision, RoutingRequest } from "./types.js";

export interface AppDeps {
  config: AppConfig;
  router: Router;
  forwarder: ForwarderLike;
}

function buildDeps(): AppDeps {
  const config = getConfig();
  return { config, router: new Router(config), forwarder: new Forwarder(config) };
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

  // Decision-inspector demo (page + explain endpoint). Registered BEFORE the
  // /v1 auth guard so it works with only the server-side classifier key — no
  // proxy key needed. It runs the pipeline for inspection but NEVER forwards a
  // completion, and is gated by demo.enabled (turn off in production).
  if (config.server.demo.enabled) {
    const cls = config.server.classifier;
    const hasClassifierKey =
      config.secrets.classifierApiKey ?? config.resolveApiKey(cls.provider, cls.model);
    if (cls.enabled && !hasClassifierKey) {
      logWarn("demo enabled but no classifier API key configured — signals will be degraded", {
        hint: "set CLASSIFIER_API_KEY",
      });
    }

    const presets = loadPresets();
    const modelIds = config.catalog.map((m) => m.id);
    app.get("/demo", (c) => c.html(demoHtml(presets, modelIds)));

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
      // Enable via server.yaml or the ROUTELLM_ENABLED env override.
      const rl = config.server.routellm;
      const rlEnabled = rl.enabled || process.env.ROUTELLM_ENABLED === "true";
      let routellm: {
        enabled: boolean;
        available: boolean;
        winRate?: number;
        confidence?: number;
      } = { enabled: rlEnabled, available: false };
      if (rlEnabled && !result.bypassed) {
        const url = process.env.ROUTELLM_URL ?? rl.url;
        const score = await fetchRouteLLMScore(url, promptText(req, 8000));
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
  }

  // Auth guards the rest of the /v1 surface (models, chat completions).
  app.use("/v1/*", makeAuth(config));

  app.get("/v1/models", (c) =>
    c.json({
      object: "list",
      data: config.catalog.map((m) => ({ id: m.id, object: "model", owned_by: m.provider })),
    }),
  );

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
