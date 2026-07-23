/**
 * Gold routing tests — requests whose correct target model is *provable*
 * (from hard capability constraints, cost-ordering, or bypass), not a matter
 * of opinion. Run against the deterministic heuristic signal (hermetic).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Use the fixed gold catalog so provability holds as the real catalog grows.
process.env.ROUTER_CONFIG_DIR = join(process.cwd(), "test", "fixtures", "gold");

import { getConfig, resetConfigCache } from "../src/config.js";
import { makeAnalyze } from "../src/core/analysis.js";
import { NoEligibleModelError, Router } from "../src/core/router.js";
import { HeuristicSignalProvider } from "../src/core/signal.js";
import {
  supports,
  type Capability,
  type ChatCompletionRequest,
  type RoutingRequest,
  type Strategy,
} from "../src/types.js";

interface GoldCase {
  id: string;
  strategy?: Strategy;
  bypass?: boolean;
  request: ChatCompletionRequest;
  expect: { model?: string; oneOf?: string[]; capability?: Capability; error?: boolean };
  note?: string;
}

const gold: GoldCase[] = readFileSync("eval/datasets/gold.jsonl", "utf-8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => JSON.parse(l) as GoldCase);

resetConfigCache();
const config = getConfig();
const byId = new Map(config.catalog.map((m) => [m.id, m]));
const router = new Router(config, makeAnalyze(new HeuristicSignalProvider()));

function buildRequest(gc: GoldCase): RoutingRequest {
  return {
    body: gc.request,
    options: {
      strategy: gc.strategy ?? "value",
      bypass: gc.bypass ?? false,
      maxCost: null,
      warnings: [],
    },
    requiresVision: false,
    requiresTools: false,
    requiresStructuredOutput: false,
    requiresAudio: false,
  };
}

describe("gold routing", () => {
  for (const gc of gold) {
    it(`${gc.id}${gc.note ? ` — ${gc.note}` : ""}`, async () => {
      const req = buildRequest(gc);

      if (gc.expect.error) {
        await expect(router.decide(req)).rejects.toBeInstanceOf(NoEligibleModelError);
        return;
      }

      const { decision } = await router.decide(req);

      if (gc.expect.model) expect(decision.modelId).toBe(gc.expect.model);
      if (gc.expect.oneOf) expect(gc.expect.oneOf).toContain(decision.modelId);
      if (gc.expect.capability) {
        const model = byId.get(decision.modelId)!;
        expect(supports(model, gc.expect.capability)).toBe(true);
      }
    });
  }
});
