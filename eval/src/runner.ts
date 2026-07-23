import { getConfig } from "../../src/config.js";
import { makeAnalyze } from "../../src/core/analysis.js";
import { ALL_CONSTRAINTS } from "../../src/core/constraints.js";
import { Router } from "../../src/core/router.js";
import { filterCandidates } from "../../src/core/scoring.js";
import { HeuristicSignalProvider, type SignalProvider } from "../../src/core/signal.js";
import {
  STRATEGIES,
  type ModelDescriptor,
  type RoutingRequest,
  type Strategy,
} from "../../src/types.js";
import { baselines } from "./baselines.js";
import { estimateCost } from "./cost.js";
import type { RunResult, Scenario } from "./types.js";

export interface RunOptions {
  strategies?: Strategy[];
  /** Signal source under test. Defaults to the deterministic heuristic (hermetic). */
  provider?: SignalProvider;
}

function buildRequest(sc: Scenario, strategy: Strategy): RoutingRequest {
  return {
    body: sc.request,
    options: { strategy, bypass: false, maxCost: null, warnings: [] },
    requiresVision: false,
    requiresTools: false,
    requiresStructuredOutput: false,
    requiresAudio: false,
  };
}

function record(
  sc: Scenario,
  group: string,
  providerName: string,
  model: ModelDescriptor,
  estCost: number,
  degraded: boolean,
): RunResult {
  const expectedTier = sc.expectedTier ?? null;
  return {
    id: sc.id,
    group,
    provider: providerName,
    model: model.id,
    tier: model.tier,
    estCost,
    expectedTier,
    correct: expectedTier == null ? null : model.tier === expectedTier,
    degraded,
  };
}

/** Dry-run: route every scenario under every strategy and baseline, no network. */
export async function runEval(dataset: Scenario[], opts: RunOptions = {}): Promise<RunResult[]> {
  const config = getConfig();
  const byId = new Map(config.catalog.map((m) => [m.id, m]));
  const provider = opts.provider ?? new HeuristicSignalProvider();
  const strategies = opts.strategies ?? [...STRATEGIES];
  const router = new Router(config, makeAnalyze(provider));

  const results: RunResult[] = [];

  for (let i = 0; i < dataset.length; i++) {
    const sc = dataset[i]!;

    // Strategy runs (the real router).
    for (const strategy of strategies) {
      const req = buildRequest(sc, strategy);
      const { decision, analysis } = await router.decide(req);
      const a = analysis!; // non-bypass always has analysis
      const model = byId.get(decision.modelId)!;
      results.push(
        record(sc, `strategy:${strategy}`, provider.name, model, estimateCost(model, a), a.classifier.degraded),
      );
    }

    // Baselines over the same constraint-filtered candidate set.
    const breq = buildRequest(sc, "value");
    const { analysis } = await router.decide(breq); // mutates breq with detected requirements
    const a = analysis!;
    const candidates = filterCandidates(config.catalog, ALL_CONSTRAINTS, breq, a);
    for (const b of baselines) {
      const model = b.pick(candidates, i);
      results.push(
        record(sc, `baseline:${b.name}`, provider.name, model, estimateCost(model, a), a.classifier.degraded),
      );
    }
  }

  return results;
}
