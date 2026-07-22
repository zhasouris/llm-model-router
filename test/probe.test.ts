/**
 * Provider probes (`/v1/router/providers`).
 *
 * The point of this endpoint is a distinction `/v1/router/models` cannot make:
 * a key that is present versus a key that works. It exists because a real
 * deployment hit the case where Google authenticated fine and every catalog
 * model id returned 404 — availability showed green, every request would have
 * failed. So the classification of upstream statuses is what these tests pin.
 */

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

process.env.ROUTER_API_KEYS = "test-key";

import { createApp, type AppDeps } from "../src/app.js";
import { getConfig, resetConfigCache } from "../src/config.js";
import { makeAnalyze } from "../src/core/analysis.js";
import { Router } from "../src/core/router.js";
import { HeuristicSignalProvider } from "../src/core/signal.js";
import { clearProbeCache, probeProviders } from "../src/probe.js";
import type { ForwardArgs, UpstreamResponse } from "../src/providers/forwarder.js";

const SAVED = { ...process.env };
const FIXTURE_DIR = join(process.cwd(), "test", "fixtures", "config");
const AUTH = { Authorization: "Bearer test-key" };

/** Answers with whatever status/body the test asked for, and records calls. */
function fakeForwarder(status: number, body = "{}") {
  const calls: ForwardArgs[] = [];
  return {
    calls,
    async forward(args: ForwardArgs): Promise<UpstreamResponse> {
      calls.push(args);
      return { status, headers: {}, body };
    },
  };
}

function deps(forwarder: { forward(a: ForwardArgs): Promise<UpstreamResponse> }): AppDeps {
  const config = getConfig();
  return { config, router: new Router(config, makeAnalyze(new HeuristicSignalProvider())), forwarder };
}

beforeEach(() => {
  process.env.ROUTER_CONFIG_DIR = FIXTURE_DIR;
  process.env.ROUTER_API_KEYS = "test-key";
  process.env.OPENAI_API_KEY = "present";
  resetConfigCache();
  clearProbeCache();
});

afterEach(() => {
  process.env = { ...SAVED };
  resetConfigCache();
  clearProbeCache();
});

describe("probeProviders", () => {
  it("reports ok when the provider answers", async () => {
    const { results, summary } = await probeProviders(getConfig(), fakeForwarder(200));
    expect(results[0]!.outcome).toBe("ok");
    expect(results[0]!.status).toBe(200);
    expect(summary.ok).toBe(1);
  });

  // The distinction the endpoint exists for: 401 means fix the key, 404 means
  // fix the catalog. They are indistinguishable from the outside.
  it("separates a bad key from a retired model", async () => {
    const bad = await probeProviders(getConfig(), fakeForwarder(401, '{"error":{"message":"invalid x-api-key"}}'));
    expect(bad.results[0]!.outcome).toBe("bad_key");

    clearProbeCache();
    const gone = await probeProviders(
      getConfig(),
      fakeForwarder(404, '{"error":{"message":"model is no longer available"}}'),
    );
    expect(gone.results[0]!.outcome).toBe("model_gone");
    expect(gone.results[0]!.detail).toContain("no longer available");
  });

  it("treats an absent key as a choice, not a fault", async () => {
    delete process.env.OPENAI_API_KEY;
    resetConfigCache();
    const { results, summary } = await probeProviders(getConfig(), fakeForwarder(200));
    expect(results[0]!.outcome).toBe("no_key");
    expect(summary.no_key).toBe(1);
    expect(summary.ok).toBe(0);
  });

  it("does not call upstream at all when there is no key", async () => {
    delete process.env.OPENAI_API_KEY;
    resetConfigCache();
    const fake = fakeForwarder(200);
    await probeProviders(getConfig(), fake);
    expect(fake.calls).toHaveLength(0);
  });

  it("probes the cheapest model, and asks for one token", async () => {
    const fake = fakeForwarder(200);
    await probeProviders(getConfig(), fake);
    // fixture-no-key is cheaper than fixture-with-key.
    expect(fake.calls[0]!.model).toBe("fixture-no-key");
    expect(fake.calls[0]!.body.max_tokens).toBe(1);
    expect(fake.calls[0]!.stream).toBe(false);
  });

  it("surfaces an upstream exception as unreachable rather than throwing", async () => {
    const exploding = {
      async forward(): Promise<UpstreamResponse> {
        throw new Error("ECONNREFUSED");
      },
    };
    const { results } = await probeProviders(getConfig(), exploding);
    expect(results[0]!.outcome).toBe("unreachable");
    expect(results[0]!.detail).toContain("ECONNREFUSED");
  });

  // Probing spends money, so a caller refreshing a page must not re-bill.
  it("caches results and re-probes only when forced", async () => {
    const fake = fakeForwarder(200);
    const config = getConfig();
    await probeProviders(config, fake);
    await probeProviders(config, fake);
    expect(fake.calls).toHaveLength(1);

    await probeProviders(config, fake, { force: true });
    expect(fake.calls).toHaveLength(2);
  });

  it("can narrow to one provider", async () => {
    const fake = fakeForwarder(200);
    const { results } = await probeProviders(getConfig(), fake, { provider: "openai" });
    expect(results).toHaveLength(1);
    expect(results[0]!.provider).toBe("openai");
  });

  it("ignores an unknown provider name", async () => {
    const { results } = await probeProviders(getConfig(), fakeForwarder(200), { provider: "nope" });
    expect(results).toHaveLength(0);
  });
});

describe("GET /v1/router/providers", () => {
  it("requires a proxy key — probing costs money", async () => {
    // The fixture disables auth, so use the real config where it is on.
    delete process.env.ROUTER_CONFIG_DIR;
    resetConfigCache();
    const res = await createApp(deps(fakeForwarder(200))).request("/v1/router/providers");
    expect(res.status).toBe(401);
  });

  it("returns 200 when everything configured works", async () => {
    const res = await createApp(deps(fakeForwarder(200))).request("/v1/router/providers", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { summary: Record<string, number> };
    expect(json.summary.ok).toBe(1);
  });

  it("returns 503 when a configured key is broken", async () => {
    const res = await createApp(deps(fakeForwarder(401))).request("/v1/router/providers", {
      headers: AUTH,
    });
    expect(res.status).toBe(503);
  });

  // A provider with no key is a deployment choice (the demo ships none), so it
  // must not make the endpoint report the service as unhealthy.
  it("stays 200 when a provider simply has no key", async () => {
    delete process.env.OPENAI_API_KEY;
    resetConfigCache();
    const res = await createApp(deps(fakeForwarder(200))).request("/v1/router/providers", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
  });
});
