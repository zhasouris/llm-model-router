/**
 * Hono application factory. Dependencies are injected so tests can supply a
 * fake forwarder (and a router with a stubbed classifier).
 */

import { swaggerUI } from "@hono/swagger-ui";
import { Hono } from "hono";
import { makeAuth } from "./auth.js";
import { getConfig, type AppConfig } from "./config.js";
import { NoEligibleModelError, Router } from "./core/router.js";
import { demoHtml, loadPresets } from "./demo.js";
import { logWarn } from "./logger.js";
import {
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

function decisionHeaders(decision: RoutingDecision): Record<string, string> {
  const headers: Record<string, string> = {
    [H_MODEL]: decision.modelId,
    [H_REASON]: decision.reason,
  };
  if (decision.warnings.length) headers[H_WARNING] = decision.warnings.join("; ");
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
    app.get("/demo", (c) => c.html(demoHtml(presets)));

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
      return c.json(await router.explain(req));
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
