/**
 * Routing prefers a model this deployment can actually reach.
 *
 * Credentials are deliberately NOT a hard constraint — the catalog stays
 * complete so an inspector-only deployment with no provider keys can still rank
 * and explain every model. Instead the router walks the ranked list and takes
 * the first routable entry, reporting what it skipped. These tests pin both
 * halves: the useful answer, and the honesty about what scoring preferred.
 */

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getConfig, resetConfigCache } from "../src/config.js";
import { makeAnalyze } from "../src/core/analysis.js";
import { Router } from "../src/core/router.js";
import { HeuristicSignalProvider } from "../src/core/signal.js";
import type { RoutingRequest } from "../src/types.js";

const SAVED = { ...process.env };
const FIXTURE_DIR = join(process.cwd(), "test", "fixtures", "config");

function request(strategy: RoutingRequest["options"]["strategy"] = "value"): RoutingRequest {
  return {
    body: { messages: [{ role: "user", content: "hi" }] },
    options: { strategy, bypass: false, maxCost: null, warnings: [] },
    requiresVision: false,
    requiresTools: false,
    requiresStructuredOutput: false,
    requiresAudio: false,
  };
}

function router(): Router {
  const config = getConfig();
  return new Router(config, makeAnalyze(new HeuristicSignalProvider()));
}

beforeEach(() => {
  process.env.ROUTER_CONFIG_DIR = FIXTURE_DIR;
  // The fixture catalog: `fixture-no-key` is cheaper and outranks
  // `fixture-with-key`, which carries its own api_key_env.
  delete process.env.OPENAI_API_KEY;
  delete process.env.FIXTURE_MODEL_KEY;
  resetConfigCache();
});

afterEach(() => {
  process.env = { ...SAVED };
  resetConfigCache();
});

describe("routing prefers a reachable model", () => {
  it("skips a higher-scoring model with no key and explains the fallback", async () => {
    // Only the per-model key exists, so the cheaper provider-default model is
    // ranked first but unroutable.
    process.env.FIXTURE_MODEL_KEY = "per-model-key";
    resetConfigCache();

    const { decision } = await router().decide(request());

    expect(decision.modelId).toBe("fixture-with-key");
    // The winner is named first, then the fallback is explained.
    expect(decision.reason).toContain("best routable");
    expect(decision.reason).toContain("fixture-no-key");
    expect(decision.reason).toContain("scored higher");
    // The skipped model is still visible in the ranking.
    expect(decision.ranked[0]!.model.id).toBe("fixture-no-key");
    expect(decision.warnings.join(" ")).toContain("no API key");
  });

  it("says nothing about fallbacks when the top pick is reachable", async () => {
    process.env.OPENAI_API_KEY = "provider-default";
    resetConfigCache();

    const { decision } = await router().decide(request());

    expect(decision.modelId).toBe("fixture-no-key");
    expect(decision.reason).not.toContain("best routable");
    expect(decision.reason).not.toContain("no API key");
    expect(decision.warnings.join(" ")).not.toContain("no API key");
  });

  // An inspector-only deployment (the Azure demo) holds no provider keys at
  // all. It must still rank and explain rather than refuse, or the demo breaks.
  it("still decides when nothing is routable, and says so", async () => {
    const { decision } = await router().decide(request());

    expect(decision.modelId).toBe("fixture-no-key");
    expect(decision.reason).toContain("unroutable");
    expect(decision.warnings.join(" ")).toContain("nothing could be forwarded");
  });

  it("applies the same choice on the inspection path", async () => {
    process.env.FIXTURE_MODEL_KEY = "per-model-key";
    resetConfigCache();

    const r = await router().explain(request());

    // The inspector reports what would really be called...
    expect(r.decision?.model).toBe("fixture-with-key");
    expect(r.decision?.reason).toContain("best routable");
    // ...while still listing the higher-scoring model it passed over.
    expect(r.ranked[0]!.model).toBe("fixture-no-key");
  });
});
