/**
 * Tent-pole test #5 — a model failing a hard constraint is NEVER selected,
 * across ALL strategies.
 */

import { describe, expect, it } from "vitest";
import { ALL_CONSTRAINTS, contextWindowConstraint } from "../src/core/constraints.js";
import { ALL_RULES } from "../src/core/extractors/rules.js";
import { filterCandidates, scoreModels } from "../src/core/scoring.js";
import { defaultClassifierResult, supports, STRATEGIES } from "../src/types.js";
import { makeAnalysis, makeModel, makeRequest } from "./helpers.js";

// Capability weights (ADR 0017): scoring no longer varies by strategy — the
// strategy only re-orders the frontier — so one weight vector suffices here.
const CAPABILITY_WEIGHTS: Record<string, number> = {
  complexity: 3.0,
  reasoning_depth: 2.0,
  task_type: 3.0,
  data_sensitivity: 0.3,
};

function visionCatalog() {
  return [
    makeModel("no-vision-cheap", { tier: 2, costIn: 0.1, costOut: 0.4 }),
    makeModel("no-vision-strong", { tier: 5, costIn: 5.0, costOut: 15.0 }),
    makeModel("vision-mid", { tier: 3, costIn: 2.0, costOut: 8.0, caps: ["vision", "tools"] }),
  ];
}

describe("constraint safety", () => {
  for (const strategy of STRATEGIES) {
    it(`vision request never routes to a non-vision model (strategy=${strategy})`, () => {
      const req = makeRequest();
      req.requiresVision = true;
      const analysis = makeAnalysis();

      const candidates = filterCandidates(visionCatalog(), ALL_CONSTRAINTS, req, analysis);
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.every((m) => supports(m, "vision"))).toBe(true);

      const ranked = scoreModels(candidates, ALL_RULES, analysis.features, CAPABILITY_WEIGHTS);
      expect(ranked[0]!.model.id).toBe("vision-mid");
    });
  }

  it("context-window filter respects the boundary", () => {
    const model = makeModel("small-ctx", { contextWindow: 1000, maxOutputTokens: 500 });
    const req = makeRequest();

    const fits = makeAnalysis({
      inputTokens: 500,
      classifier: { ...defaultClassifierResult(), expectedOutputTokens: 500 },
    });
    const over = makeAnalysis({
      inputTokens: 501,
      classifier: { ...defaultClassifierResult(), expectedOutputTokens: 500 },
    });

    expect(contextWindowConstraint.admits(model, req, fits)).toBe(true);
    expect(contextWindowConstraint.admits(model, req, over)).toBe(false);
  });
});
