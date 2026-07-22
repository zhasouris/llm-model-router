/**
 * /v1/router/models — which catalog models this deployment can actually reach.
 *
 * The router scores on capability and price and has no notion of whether a key
 * exists, so it will happily rank a model whose provider is unkeyed and only
 * discover the problem as a 401 at forward time. This endpoint is how a client
 * (and the demo page) can tell the two apart up front.
 */

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

process.env.ROUTER_API_KEYS = "test-key";

import { createApp, type AppDeps } from "../src/app.js";
import { getConfig, resetConfigCache } from "../src/config.js";
import { makeAnalyze } from "../src/core/analysis.js";
import { Router } from "../src/core/router.js";
import { HeuristicSignalProvider } from "../src/core/signal.js";
import type { UpstreamResponse } from "../src/providers/forwarder.js";

const SAVED = { ...process.env };
const FIXTURE_DIR = join(process.cwd(), "test", "fixtures", "config");

interface AvailabilityBody {
  data: { id: string; provider: string; available: boolean; capabilities: string[] }[];
  summary: { total: number; available: number; providers: Record<string, boolean> };
}

function deps(): AppDeps {
  const config = getConfig();
  return {
    config,
    router: new Router(config, makeAnalyze(new HeuristicSignalProvider())),
    forwarder: {
      async forward(): Promise<UpstreamResponse> {
        return { status: 200, headers: {}, body: "{}" };
      },
    },
  };
}

async function fetchAvailability(headers: Record<string, string> = {}) {
  const res = await createApp(deps()).request("/v1/router/models", { headers });
  return { res, body: res.status === 200 ? ((await res.json()) as AvailabilityBody) : null };
}

beforeEach(() => {
  process.env.ROUTER_CONFIG_DIR = FIXTURE_DIR;
  process.env.ROUTER_API_KEYS = "test-key";
  delete process.env.OPENAI_API_KEY;
  delete process.env.FIXTURE_MODEL_KEY;
  resetConfigCache();
});

afterEach(() => {
  process.env = { ...SAVED };
  resetConfigCache();
});

describe("/v1/router/models", () => {
  it("marks a model unavailable when its provider has no key", async () => {
    const { res, body } = await fetchAvailability();
    expect(res.status).toBe(200);
    expect(body!.data.length).toBeGreaterThan(0);
    expect(body!.data.every((m) => m.available === false)).toBe(true);
    expect(body!.summary.available).toBe(0);
  });

  it("marks it available once the provider key is present", async () => {
    process.env.OPENAI_API_KEY = "provider-default";
    resetConfigCache();

    const { body } = await fetchAvailability();
    expect(body!.summary.available).toBe(body!.summary.total);
    expect(body!.summary.providers.openai).toBe(true);
  });

  it("honours a per-model key even when the provider default is absent", async () => {
    // The fixture catalog has a model whose api_key_env is FIXTURE_MODEL_KEY.
    process.env.FIXTURE_MODEL_KEY = "per-model-key";
    resetConfigCache();

    const { body } = await fetchAvailability();
    const withOwnKey = body!.data.find((m) => m.id === "fixture-with-key");
    expect(withOwnKey?.available).toBe(true);
    // A sibling model relying on the (absent) provider default is not routable.
    expect(body!.data.some((m) => m.id !== "fixture-with-key" && !m.available)).toBe(true);
  });

  it("reports the catalog even when nothing is routable, so models stay inspectable", async () => {
    const { body } = await fetchAvailability();
    expect(body!.summary.total).toBe(getConfig().catalog.length);
  });

  it("is reachable without a proxy key while the inspector is public", async () => {
    // No Authorization header — the demo page needs this unauthenticated.
    const { res } = await fetchAvailability();
    expect(res.status).toBe(200);
  });

  // Uses the real config rather than the fixture, which disables auth entirely
  // and so cannot show the difference this test is about.
  it("moves behind auth when the inspector is disabled", async () => {
    delete process.env.ROUTER_CONFIG_DIR;
    process.env.DEMO_ENABLED = "false";
    resetConfigCache();
    expect(getConfig().server.auth.enabled).toBe(true);

    const { res } = await fetchAvailability();
    expect(res.status).toBe(401);

    const authed = await createApp(deps()).request("/v1/router/models", {
      headers: { Authorization: "Bearer test-key" },
    });
    expect(authed.status).toBe(200);
  });

  it("is public when the inspector is enabled, on the real config too", async () => {
    delete process.env.ROUTER_CONFIG_DIR;
    resetConfigCache();
    const { res } = await fetchAvailability();
    expect(res.status).toBe(200);
  });

  it("leaves /v1/models in the strict OpenAI shape", async () => {
    const res = await createApp(deps()).request("/v1/models", {
      headers: { Authorization: "Bearer test-key" },
    });
    const json = (await res.json()) as { data: Record<string, unknown>[] };
    expect(Object.keys(json.data[0]!).sort()).toEqual(["id", "object", "owned_by"]);
  });
});
