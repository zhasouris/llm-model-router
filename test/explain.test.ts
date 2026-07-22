/**
 * Decision inspector — Router.explain(), the /v1/router/explain endpoint, and
 * the /demo page. Hermetic (heuristic signal, no network).
 */

import { beforeAll, describe, expect, it } from "vitest";

process.env.ROUTER_API_KEYS = "test-key";

import { createApp, type AppDeps } from "../src/app.js";
import { getConfig, resetConfigCache } from "../src/config.js";
import { makeAnalyze } from "../src/core/analysis.js";
import { Router } from "../src/core/router.js";
import { HeuristicSignalProvider } from "../src/core/signal.js";
import type { RoutingRequest } from "../src/types.js";
import type { UpstreamResponse } from "../src/providers/forwarder.js";

function router(): Router {
  return new Router(getConfig(), makeAnalyze(new HeuristicSignalProvider()));
}

function request(body: RoutingRequest["body"], strategy: RoutingRequest["options"]["strategy"] = "balanced"): RoutingRequest {
  return {
    body,
    options: { strategy, bypass: false, maxCost: null, warnings: [] },
    requiresVision: false,
    requiresTools: false,
    requiresStructuredOutput: false,
    requiresAudio: false,
  };
}

beforeAll(() => resetConfigCache());

describe("Router.explain", () => {
  it("returns the full decision trace for a text request", async () => {
    const r = await router().explain(request({ messages: [{ role: "user", content: "Say hi" }] }));
    expect(r.decision).not.toBeNull();
    expect(r.ranked.length).toBeGreaterThan(0);
    expect(r.classifier).toBeDefined();
    expect(r.eligible.length).toBe(getConfig().catalog.length); // text-only: all eligible
    expect(r.excluded).toHaveLength(0);
  });

  it("forces a model when bypass is set (routing skipped)", async () => {
    const req = request({ messages: [{ role: "user", content: "hi" }], model: "claude-sonnet-5" });
    req.options.bypass = true;
    const r = await router().explain(req);
    expect(r.bypassed).toBe(true);
    expect(r.decision?.model).toBe("claude-sonnet-5");
    expect(r.decision?.provider).toBe("anthropic");
    expect(r.ranked).toHaveLength(0);
    expect(r.classifier).toBeNull();
  });

  it("excludes non-vision models with a reason for an image request", async () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
          ],
        },
      ],
    };
    const r = await router().explain(request(body));
    expect(r.detected.requiresVision).toBe(true);
    // The catalog's non-vision models (gpt-4.1-nano, o4-mini) must be excluded.
    const excludedIds = r.excluded.map((e) => e.model);
    expect(excludedIds).toContain("gpt-4.1-nano");
    const nano = r.excluded.find((e) => e.model === "gpt-4.1-nano")!;
    expect(nano.failedConstraints).toContain("vision");
    expect(r.eligible).not.toContain("gpt-4.1-nano");
  });
});

describe("/v1/router/explain + /demo", () => {
  function deps(): AppDeps {
    const dummy = {
      async forward(): Promise<UpstreamResponse> {
        return { status: 200, headers: {}, body: "{}" };
      },
    };
    return { config: getConfig(), router: router(), forwarder: dummy };
  }

  it("serves the demo page with gold presets", async () => {
    const res = await createApp(deps()).request("/demo");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Router decision inspector");
    expect(html).toContain("Gold presets");
    // A gold-query id should be embedded as a preset.
    expect(html).toContain("cost-vision");
    // The force-model control + catalog options are present.
    expect(html).toContain("Force model");
    expect(html).toContain("gpt-4.1-nano");
  });

  it("explains a request as JSON WITHOUT a proxy key (demo endpoint is unauthenticated)", async () => {
    const app = createApp(deps());
    const res = await app.request("/v1/router/explain", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Router-Strategy": "cost" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Prove sqrt 2 is irrational" }] }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      decision: unknown;
      ranked: unknown[];
      routellm: { enabled: boolean; available: boolean };
    };
    expect(json.decision).not.toBeNull();
    expect(json.ranked.length).toBeGreaterThan(0);
    // RouteLLM shadow signal is present (disabled by default in config).
    expect(json.routellm).toBeDefined();
    expect(json.routellm.enabled).toBe(false);
  });

  it("emits the same decision headers as the proxy path (ADR 0002)", async () => {
    const res = await createApp(deps()).request("/v1/router/explain", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Router-Strategy": "cost" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Say hi" }] }),
    });
    expect(res.status).toBe(200);
    const model = res.headers.get("X-Router-Model");
    const reason = res.headers.get("X-Router-Reason");
    expect(model).toBeTruthy();
    expect(reason).toBeTruthy();
    // The headers must agree with the body — the demo renders both.
    const json = (await res.json()) as { decision: { model: string; reason: string } };
    expect(model).toBe(json.decision.model);
    expect(reason).toBe(json.decision.reason);
  });

  it("reports a forced model in the headers when bypassed", async () => {
    const res = await createApp(deps()).request("/v1/router/explain", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Router-Bypass": "true",
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], model: "claude-sonnet-5" }),
    });
    expect(res.headers.get("X-Router-Model")).toBe("claude-sonnet-5");
    expect(res.headers.get("X-Router-Reason")).toContain("forced");
  });

  it("reports the routing duration on the explain endpoint", async () => {
    const res = await createApp(deps()).request("/v1/router/explain", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Say hi" }] }),
    });
    const raw = res.headers.get("X-Router-Duration-Ms")!;
    expect(raw).toMatch(/^\d+$/);
    const json = (await res.json()) as { routingMs: number };
    expect(Number(raw)).toBe(json.routingMs);
  });

  // The bypass reason contains an em dash. Header values are Latin-1, so an
  // unsanitised value makes the runtime reject the whole response with a 500.
  it("folds non-ASCII in reasons so the header never breaks the response", async () => {
    const res = await createApp(deps()).request("/v1/router/explain", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Router-Bypass": "true" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], model: "claude-sonnet-5" }),
    });
    expect(res.status).toBe(200);
    const reason = res.headers.get("X-Router-Reason")!;
    expect(reason).toMatch(/^[\x20-\x7e]*$/);
    // The body keeps the original prose — only the header is folded.
    const json = (await res.json()) as { decision: { reason: string } };
    expect(json.decision.reason).toContain("—");
  });

  it("keeps the rest of /v1 auth-guarded (models requires a key)", async () => {
    const res = await createApp(deps()).request("/v1/models");
    expect(res.status).toBe(401);
  });
});
