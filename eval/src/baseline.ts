import { getConfig } from "../../src/config.js";
import { makeAnalyze } from "../../src/core/analysis.js";
import { ALL_CONSTRAINTS } from "../../src/core/constraints.js";
import { Router } from "../../src/core/router.js";
import { filterCandidates } from "../../src/core/scoring.js";
import { HeuristicSignalProvider, type SignalProvider } from "../../src/core/signal.js";
import {
  MAX_TIER,
  STRATEGIES,
  type ModelDescriptor,
  type RoutingRequest,
  type Strategy,
} from "../../src/types.js";
import { taskBenchmark } from "./benchmarks.js";
import { estimateCost } from "./cost.js";
import type { Scenario } from "./types.js";

/** Prompts at/above this complexity are the ones where accuracy actually matters. */
const NEEDS_ACCURACY = 0.5;

export type Change = "unchanged" | "upgrade" | "downgrade" | "forced-upgrade";

export interface PromptDelta {
  id: string;
  strategy: Strategy;
  task: string;
  needsAccuracy: boolean;
  /** Task has a benchmark (competency-eligible) — accuracy is meaningful here. */
  accuracyRelevant: boolean;
  baseServes: boolean;
  routerModel: string;
  change: Change;
  baseCost: number | null;
  routerCost: number;
  competencyBase: number;
  competencyRouter: number;
  benchBase: number | null;
  benchRouter: number | null;
  benchName: string | null;
}

export interface StrategyStat {
  strategy: Strategy;
  n: number;
  counts: Record<Change, number>;
  cost: {
    base: number;
    router: number;
    savedOnDowngrades: number;
    spentOnUpgrades: number;
    netSaved: number;
    netPct: number;
  };
  /** Accuracy KPIs segmented by "needs accuracy" (hard prompts) vs not. */
  accuracy: {
    needN: number;
    easyN: number;
    /** Mean task-benchmark delta (router − base, 0–100) on hard prompts. */
    targetedBenchDelta: number | null;
    targetedCompetencyDelta: number;
    /** Mean deltas on easy prompts — should be ~0 (base was overkill, no real loss). */
    easyBenchDelta: number | null;
    easyCompetencyDelta: number;
  };
}

export interface BaselineReport {
  base: string;
  dataset: string;
  scenarios: number;
  strategies: StrategyStat[];
  deltas: PromptDelta[];
}

const competency = (m: ModelDescriptor, task: string): number =>
  m.competency?.[task]?.score ?? m.tier / MAX_TIER;

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}

/** Route the dataset under every strategy and diff each pick against always-`base`. */
export async function baselineReport(
  dataset: Scenario[],
  base: string,
  datasetName: string,
  opts: { provider?: SignalProvider } = {},
): Promise<BaselineReport> {
  const config = getConfig();
  const byId = new Map(config.catalog.map((m) => [m.id, m]));
  const baseModel = byId.get(base);
  if (!baseModel) throw new Error(`base model '${base}' is not in the catalog`);
  const provider = opts.provider ?? new HeuristicSignalProvider();
  const router = new Router(config, makeAnalyze(provider));

  const deltas: PromptDelta[] = [];

  const build = (sc: Scenario, strategy: Strategy): RoutingRequest => ({
    body: sc.request,
    options: { strategy, bypass: false, maxCost: null, warnings: [] },
    requiresVision: false,
    requiresTools: false,
    requiresStructuredOutput: false,
    requiresAudio: false,
  });

  for (const sc of dataset) {
    // One analysis (strategy-independent) for the task, difficulty, and base cost.
    const probe = build(sc, "value");
    const { analysis } = await router.decide(probe);
    const a = analysis!;
    const task = a.classifier.taskType;
    const needsAccuracy = a.classifier.complexity >= NEEDS_ACCURACY;
    const candidates = filterCandidates(config.catalog, ALL_CONSTRAINTS, probe, a);
    const baseServes = candidates.some((m) => m.id === base);
    const baseCost = baseServes ? estimateCost(baseModel, a) : null;
    const compBase = competency(baseModel, task);
    const benchBaseInfo = taskBenchmark(base, task);

    for (const strategy of STRATEGIES) {
      const { decision, analysis: a2 } = await router.decide(build(sc, strategy));
      const routerModel = byId.get(decision.modelId)!;
      const routerCost = estimateCost(routerModel, a2!);
      const compRouter = competency(routerModel, task);
      const benchRouterInfo = taskBenchmark(routerModel.id, task);

      let change: Change;
      if (!baseServes) change = "forced-upgrade";
      else if (routerModel.id === base) change = "unchanged";
      else if (compRouter > compBase) change = "upgrade";
      else if (compRouter < compBase) change = "downgrade";
      else change = "unchanged";

      deltas.push({
        id: sc.id,
        strategy,
        task,
        needsAccuracy,
        accuracyRelevant: benchBaseInfo != null && benchRouterInfo != null,
        baseServes,
        routerModel: routerModel.id,
        change,
        baseCost,
        routerCost,
        competencyBase: compBase,
        competencyRouter: compRouter,
        benchBase: benchBaseInfo?.score ?? null,
        benchRouter: benchRouterInfo?.score ?? null,
        benchName: benchRouterInfo?.benchmark ?? benchBaseInfo?.benchmark ?? null,
      });
    }
  }

  const strategies = STRATEGIES.map((strategy) => summarize(deltas.filter((d) => d.strategy === strategy), strategy));
  return { base, dataset: datasetName, scenarios: dataset.length, strategies, deltas };
}

function summarize(rows: PromptDelta[], strategy: Strategy): StrategyStat {
  const counts: Record<Change, number> = { unchanged: 0, upgrade: 0, downgrade: 0, "forced-upgrade": 0 };
  for (const r of rows) counts[r.change]++;

  const base = rows.reduce((s, r) => s + (r.baseCost ?? 0), 0);
  const router = rows.reduce((s, r) => s + r.routerCost, 0);
  const savedOnDowngrades = rows
    .filter((r) => r.change === "downgrade")
    .reduce((s, r) => s + ((r.baseCost ?? 0) - r.routerCost), 0);
  const spentOnUpgrades = rows
    .filter((r) => r.change === "upgrade" || r.change === "forced-upgrade")
    .reduce((s, r) => s + (r.routerCost - (r.baseCost ?? 0)), 0);
  const netSaved = base - router;

  // Accuracy is only meaningful where a benchmark applies (not "say hi"). Split
  // those into hard (accuracy needed) vs easy, using the SAME subset for both the
  // benchmark and competency views so they agree.
  const relevant = rows.filter((r) => r.accuracyRelevant);
  const hard = relevant.filter((r) => r.needsAccuracy);
  const easy = relevant.filter((r) => !r.needsAccuracy);
  const benchDelta = (rs: PromptDelta[]) => mean(rs.map((r) => r.benchRouter! - r.benchBase!));
  const compDelta = (rs: PromptDelta[]) => mean(rs.map((r) => r.competencyRouter - r.competencyBase)) ?? 0;

  return {
    strategy,
    n: rows.length,
    counts,
    cost: {
      base,
      router,
      savedOnDowngrades,
      spentOnUpgrades,
      netSaved,
      netPct: base > 0 ? (netSaved / base) * 100 : 0,
    },
    accuracy: {
      needN: hard.length,
      easyN: easy.length,
      targetedBenchDelta: benchDelta(hard),
      targetedCompetencyDelta: compDelta(hard),
      easyBenchDelta: benchDelta(easy),
      easyCompetencyDelta: compDelta(easy),
    },
  };
}
