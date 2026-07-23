/**
 * Per-strategy signal provider selection (ADR 0012).
 *
 * `latency` must not pay the ~1s LLM classifier tax for a signal it barely
 * weights; every other strategy keeps the default provider. These tests assert
 * the routing of that choice, not the providers themselves — a distinct fake
 * per strategy makes it observable which one ran.
 */

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig, resetConfigCache } from "../src/config.js";
import { Router } from "../src/core/router.js";
import type { AnalyzeFn } from "../src/core/analysis.js";
import { ALL_RULES } from "../src/core/extractors/rules.js";
import { defaultClassifierResult, type RequestAnalysis, type RoutingRequest, type Strategy } from "../src/types.js";

const SAVED = { ...process.env };
const FIXTURE_DIR = join(process.cwd(), "test", "fixtures", "config");

function request(strategy: Strategy): RoutingRequest {
  return {
    body: { messages: [{ role: "user", content: "hi" }] },
    options: { strategy, bypass: false, maxCost: null, warnings: [] },
    requiresVision: false,
    requiresTools: false,
    requiresStructuredOutput: false,
    requiresAudio: false,
  };
}

/** An analyze fn that tags the analysis with a name and records that it ran. */
function tagged(name: string): { fn: AnalyzeFn; calls: () => number } {
  let count = 0;
  const fn: AnalyzeFn = async (req) => {
    count += 1;
    const analysis: RequestAnalysis = {
      inputTokens: 5,
      classifier: defaultClassifierResult(),
      features: {},
      signalProvider: name,
    };
    for (const rule of ALL_RULES) analysis.features[rule.name] = rule.extract(req, analysis);
    return analysis;
  };
  return { fn, calls: () => count };
}

beforeEach(() => {
  process.env.ROUTER_CONFIG_DIR = FIXTURE_DIR;
  process.env.OPENAI_API_KEY = "present";
  resetConfigCache();
});
afterEach(() => {
  process.env = { ...SAVED };
  resetConfigCache();
});

describe("per-strategy signal selection", () => {
  it("uses the strategy override for fast and the default for the rest", async () => {
    const def = tagged("default");
    const fast = tagged("fast");
    const router = new Router(getConfig(), def.fn, { fast: fast.fn });

    const lat = await router.decide(request("fast"));
    expect(lat.analysis?.signalProvider).toBe("fast");
    expect(fast.calls()).toBe(1);
    expect(def.calls()).toBe(0);

    for (const s of ["best", "value"] as Strategy[]) {
      const r = await router.decide(request(s));
      expect(r.analysis?.signalProvider).toBe("default");
    }
    expect(fast.calls()).toBe(1); // never called again
    expect(def.calls()).toBe(2);
  });

  it("falls back to the default when a strategy has no override", async () => {
    const def = tagged("default");
    const router = new Router(getConfig(), def.fn); // no overrides at all
    const r = await router.decide(request("fast"));
    expect(r.analysis?.signalProvider).toBe("default");
  });

  it("surfaces the provider that ran on the inspection path too", async () => {
    const def = tagged("default");
    const fast = tagged("fast");
    const router = new Router(getConfig(), def.fn, { fast: fast.fn });

    const explained = await router.explain(request("fast"));
    expect(explained.signalProvider).toBe("fast");

    const quality = await router.explain(request("best"));
    expect(quality.signalProvider).toBe("default");
  });

  it("does not run any signal provider when bypassed", async () => {
    const def = tagged("default");
    const fast = tagged("fast");
    const router = new Router(getConfig(), def.fn, { fast: fast.fn });

    const req = request("fast");
    req.options.bypass = true;
    req.body.model = "fixture-with-key";
    await router.decide(req);
    expect(def.calls()).toBe(0);
    expect(fast.calls()).toBe(0);
  });
});
