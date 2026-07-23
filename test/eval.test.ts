/**
 * Eval harness sanity — heuristic determinism, cost math, and that the harness
 * differentiates easy vs. hard prompts (invariant: signals must vary).
 */

import { describe, expect, it } from "vitest";
import { estimateCost } from "../eval/src/cost.js";
import { aggregate } from "../eval/src/report.js";
import { runEval } from "../eval/src/runner.js";
import type { Scenario } from "../eval/src/types.js";
import { HeuristicSignalProvider } from "../src/core/signal.js";
import { defaultClassifierResult } from "../src/types.js";
import { makeModel, makeRequest } from "./helpers.js";

describe("heuristic signal provider", () => {
  it("is deterministic", async () => {
    const p = new HeuristicSignalProvider();
    const req = makeRequest({ body: { messages: [{ role: "user", content: "Prove the pigeonhole principle" }] } });
    const a = await p.analyze(req);
    const b = await p.analyze(req);
    expect(a).toEqual(b);
  });

  it("scores a hard prompt above an easy one", async () => {
    const p = new HeuristicSignalProvider();
    const hard = await p.analyze(
      makeRequest({ body: { messages: [{ role: "user", content: "Optimize this algorithm and derive the complexity" }] } }),
    );
    const easy = await p.analyze(
      makeRequest({ body: { messages: [{ role: "user", content: "Say hi" }] } }),
    );
    expect(hard.complexity).toBeGreaterThan(easy.complexity);
  });
});

describe("cost estimate", () => {
  it("combines input and output pricing", () => {
    const model = makeModel("m", { costIn: 2, costOut: 8 });
    const analysis = {
      inputTokens: 1000,
      classifier: { ...defaultClassifierResult(), expectedOutputTokens: 500 },
      features: {},
      signalProvider: "stub",
    };
    // 1.0*2 + 0.5*8 = 6
    expect(estimateCost(model, analysis)).toBeCloseTo(6, 6);
  });
});

describe("runEval", () => {
  const dataset: Scenario[] = [
    { id: "easy", request: { messages: [{ role: "user", content: "Say hi" }] }, expectedTier: 2 },
    {
      id: "hard",
      request: { messages: [{ role: "user", content: "Design a distributed rate limiter and analyze the trade-offs" }] },
      expectedTier: 5,
    },
  ];

  it("produces results for every strategy and baseline, hermetically", async () => {
    const results = await runEval(dataset);
    const groups = new Set(results.map((r) => r.group));
    expect(groups.has("strategy:value")).toBe(true);
    expect(groups.has("strategy:best")).toBe(true);
    expect(groups.has("baseline:always-cheapest")).toBe(true);
    expect(groups.has("baseline:always-strongest")).toBe(true);
    // Every result is a real catalog model with a numeric cost.
    for (const r of results) expect(r.estCost).toBeGreaterThanOrEqual(0);
  });

  it("best strategy picks a higher tier for the hard prompt than the easy one", async () => {
    const results = await runEval(dataset, { strategies: ["best"] });
    const easy = results.find((r) => r.id === "easy" && r.group === "strategy:best")!;
    const hard = results.find((r) => r.id === "hard" && r.group === "strategy:best")!;
    expect(hard.tier).toBeGreaterThan(easy.tier);
  });

  it("value strategy is never more expensive on average than always-strongest", async () => {
    const results = await runEval(dataset);
    const stats = aggregate(results);
    const cost = stats.find((s) => s.group === "strategy:value")!;
    const strongest = stats.find((s) => s.group === "baseline:always-strongest")!;
    expect(cost.meanCost).toBeLessThanOrEqual(strongest.meanCost);
  });
});
