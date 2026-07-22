/**
 * Endpoint contract — response headers (#12), body rewrite (#14), auth (#19).
 * Uses Hono's app.request() with a fake forwarder and a stubbed classifier so
 * the tests stay hermetic (#1).
 */

import { beforeAll, describe, expect, it } from "vitest";

// Auth needs a known proxy key; set before config is read.
process.env.ROUTER_API_KEYS = "test-key";

import { createApp, type AppDeps } from "../src/app.js";
import { getConfig, resetConfigCache } from "../src/config.js";
import { Router } from "../src/core/router.js";
import { defaultClassifierResult, type RequestAnalysis, type RoutingRequest } from "../src/types.js";
import type { UpstreamResponse } from "../src/providers/forwarder.js";

const AUTH = { Authorization: "Bearer test-key" };

class FakeForwarder {
  lastBody: Record<string, unknown> | null = null;
  lastProvider: string | null = null;
  async forward(args: { provider: string; body: Record<string, unknown> }): Promise<UpstreamResponse> {
    this.lastBody = args.body;
    this.lastProvider = args.provider;
    return { status: 200, headers: { "content-type": "application/json" }, body: '{"ok": true}' };
  }
}

async function stubAnalyze(req: RoutingRequest): Promise<RequestAnalysis> {
  const analysis: RequestAnalysis = {
    inputTokens: 10,
    classifier: { ...defaultClassifierResult(), complexity: 0.2, expectedOutputTokens: 200 },
    features: {},
  };
  const { ALL_RULES } = await import("../src/core/extractors/rules.js");
  for (const rule of ALL_RULES) analysis.features[rule.name] = rule.extract(req, analysis);
  return analysis;
}

function makeDeps(): { deps: AppDeps; fake: FakeForwarder } {
  const config = getConfig();
  const fake = new FakeForwarder();
  const deps: AppDeps = { config, router: new Router(config, stubAnalyze), forwarder: fake };
  return { deps, fake };
}

beforeAll(() => {
  resetConfigCache();
});

describe("endpoint", () => {
  it("missing auth is 401", async () => {
    const { deps } = makeDeps();
    const app = createApp(deps);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(401);
  });

  it("bypass forwards the body model verbatim and sets headers", async () => {
    const { deps, fake } = makeDeps();
    const app = createApp(deps);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json", "X-Router-Bypass": "true" },
      body: JSON.stringify({ model: "gpt-4.1", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Router-Model")).toBe("gpt-4.1");
    expect(res.headers.get("X-Router-Reason")).toBeTruthy();
    expect(fake.lastBody?.model).toBe("gpt-4.1");
  });

  it("routed request rewrites model and reports it, keeping other fields", async () => {
    const { deps, fake } = makeDeps();
    const app = createApp(deps);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json", "X-Router-Strategy": "cost" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.7,
      }),
    });
    expect(res.status).toBe(200);
    const chosen = res.headers.get("X-Router-Model");
    expect(chosen).not.toBe("auto");
    expect(fake.lastBody?.model).toBe(chosen);
    expect(fake.lastBody?.temperature).toBe(0.7);
  });

  it("reports how long the routing step took", async () => {
    const { deps } = makeDeps();
    const res = await createApp(deps).request("/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
    });
    const raw = res.headers.get("X-Router-Duration-Ms")!;
    expect(raw).toMatch(/^\d+$/);
    expect(Number(raw)).toBeGreaterThanOrEqual(0);
  });

  // The point of the header is to isolate the proxy's own overhead, so a slow
  // upstream must not inflate it.
  it("excludes upstream time from the routing duration", async () => {
    const config = getConfig();
    const slow = {
      async forward(): Promise<UpstreamResponse> {
        await new Promise((r) => setTimeout(r, 200));
        return { status: 200, headers: { "content-type": "application/json" }, body: "{}" };
      },
    };
    const deps: AppDeps = { config, router: new Router(config, stubAnalyze), forwarder: slow };

    const start = Date.now();
    const res = await createApp(deps).request("/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
    });
    const wallClock = Date.now() - start;

    expect(wallClock).toBeGreaterThanOrEqual(200);
    expect(Number(res.headers.get("X-Router-Duration-Ms"))).toBeLessThan(100);
  });

  it("bypass still reports a routing duration", async () => {
    const { deps } = makeDeps();
    const res = await createApp(deps).request("/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json", "X-Router-Bypass": "true" },
      body: JSON.stringify({ model: "gpt-4.1", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.headers.get("X-Router-Duration-Ms")).toMatch(/^\d+$/);
  });

  it("lists models with auth", async () => {
    const { deps } = makeDeps();
    const app = createApp(deps);
    const res = await app.request("/v1/models", { headers: AUTH });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: unknown[] };
    expect(json.data.length).toBeGreaterThan(0);
  });
});
