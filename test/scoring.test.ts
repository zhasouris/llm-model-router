/**
 * Scoring & strategy bias (invariants #7, #8, #9).
 */

import { describe, expect, it } from "vitest";
import { ALL_RULES } from "../src/core/extractors/rules.js";
import { scoreModels } from "../src/core/scoring.js";
import { defaultClassifierResult, type ClassifierResult, type ModelDescriptor } from "../src/types.js";
import { fixtureCatalog, makeAnalysis, makeModel } from "./helpers.js";

function rank(
  catalog: ModelDescriptor[],
  weights: Record<string, number>,
  classifier?: ClassifierResult,
) {
  const analysis = makeAnalysis({ classifier: classifier ?? defaultClassifierResult() });
  return scoreModels(catalog, ALL_RULES, analysis.features, weights);
}

describe("scoring", () => {
  it("cost strategy prefers the cheapest", () => {
    const ranked = rank(fixtureCatalog(), { cost: 3.0, input_tokens: 1.0, expected_output: 1.0 });
    expect(ranked[0]!.model.id).toBe("cheap-nano");
  });

  it("quality strategy prefers the strongest on complex work", () => {
    const ranked = rank(
      fixtureCatalog(),
      { complexity: 3.0, reasoning_depth: 2.0, task_type: 1.5 },
      { ...defaultClassifierResult(), complexity: 0.95 },
    );
    expect(ranked[0]!.model.tier).toBe(5);
  });

  it("latency strategy prefers the fastest", () => {
    const ranked = rank(fixtureCatalog(), { latency: 3.0 });
    expect(ranked[0]!.model.id).toBe("cheap-nano");
  });

  it("extractors emit normalized 0..1 signals for extreme inputs", () => {
    const analysis = makeAnalysis({
      inputTokens: 10_000_000,
      classifier: { ...defaultClassifierResult(), complexity: 5.0, reasoningDepth: -3.0 },
    });
    for (const score of Object.values(analysis.features)) {
      expect(score.value).toBeGreaterThanOrEqual(0);
      expect(score.value).toBeLessThanOrEqual(1);
    }
  });

  // A fixedScale rule (reasoning_depth, data_sensitivity) is already 0..1 and
  // its magnitude is meaningful. Min-max normalizing it would stretch whatever
  // spread exists to fill 0..1, so "needs 10% reasoning" and "needs 100%" would
  // hand a reasoning-capable model exactly the same bonus — collapsing a graded
  // preference into a capability flag.
  describe("fixedScale rules keep their magnitude", () => {
    const catalog = [
      makeModel("reasoner", { tier: 3, caps: ["reasoning", "tools"] }),
      makeModel("plain", { tier: 3, caps: ["tools"] }),
    ];
    const withDepth = (reasoningDepth: number) => ({
      ...defaultClassifierResult(),
      reasoningDepth,
    });

    function reasoningContribution(depth: number): number {
      const ranked = rank(catalog, { reasoning_depth: 1.0 }, withDepth(depth));
      return ranked.find((r) => r.model.id === "reasoner")!.breakdown.reasoning_depth!;
    }

    it("scales the bonus with the signal instead of saturating it", () => {
      expect(reasoningContribution(0.1)).toBeCloseTo(0.1, 6);
      expect(reasoningContribution(0.5)).toBeCloseTo(0.5, 6);
      expect(reasoningContribution(1.0)).toBeCloseTo(1.0, 6);
    });

    it("gives nothing to a model without the capability", () => {
      const ranked = rank(catalog, { reasoning_depth: 1.0 }, withDepth(1.0));
      expect(ranked.find((r) => r.model.id === "plain")!.breakdown.reasoning_depth).toBe(0);
    });

    // The regression this was written for: a barely-reasoning prompt must not
    // let a slower, pricier reasoning model outrank a faster, cheaper one.
    it("does not let a trivial prompt flip a latency decision", () => {
      const speed = [
        makeModel("fast-plain", { tier: 2, latency: 500, costIn: 0.1, costOut: 0.4, caps: ["tools"] }),
        makeModel("slow-reasoner", {
          tier: 2,
          latency: 700,
          costIn: 0.3,
          costOut: 0.5,
          caps: ["tools", "reasoning"],
        }),
      ];
      const latencyWeights = { latency: 3.0, cost: 0.5, reasoning_depth: 0.3 };
      const ranked = scoreModels(
        speed,
        ALL_RULES,
        makeAnalysis({ classifier: withDepth(0.1) }).features,
        latencyWeights,
      );
      expect(ranked[0]!.model.id).toBe("fast-plain");
    });
  });

  it("ties break deterministically by cost then id", () => {
    const a = makeModel("bbb", { costIn: 1.0, costOut: 1.0 });
    const b = makeModel("aaa", { costIn: 1.0, costOut: 1.0 });
    const ranked = rank([a, b], { cost: 1.0 });
    expect(ranked[0]!.model.id).toBe("aaa");
  });
});
