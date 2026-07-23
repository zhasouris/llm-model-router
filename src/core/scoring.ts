/**
 * Stage 2 — weighted model scoring (ADR 0003).
 *
 * Each surviving model is scored by every feature rule; the per-rule scores are
 * min-max normalized across the candidate set (so weights are meaningful
 * regardless of a rule's native scale), multiplied by the strategy weight, and
 * summed. Highest total wins; ties break deterministically (invariant #9).
 */

import type {
  FeatureScore,
  ModelDescriptor,
  Objective,
  RequestAnalysis,
  RoutingRequest,
  ScoredModel,
  Strategy,
} from "../types.js";
import type { ConstraintRule } from "./constraints.js";
import { clamp01, type FeatureRule } from "./extractors/types.js";

export function filterCandidates(
  catalog: ModelDescriptor[],
  constraints: ConstraintRule[],
  req: RoutingRequest,
  analysis: RequestAnalysis,
): ModelDescriptor[] {
  return catalog.filter((model) => constraints.every((c) => c.admits(model, req, analysis)));
}

function normalize(raw: Map<string, number>): Map<string, number> {
  const values = [...raw.values()];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const out = new Map<string, number>();
  if (hi - lo < 1e-12) {
    for (const k of raw.keys()) out.set(k, 0.5);
    return out;
  }
  for (const [k, v] of raw) out.set(k, (v - lo) / (hi - lo));
  return out;
}

export function scoreModels(
  candidates: ModelDescriptor[],
  rules: FeatureRule[],
  signals: Record<string, FeatureScore>,
  weights: Record<string, number>,
): ScoredModel[] {
  if (candidates.length === 0) return [];

  const normalizedByRule = new Map<string, Map<string, number>>();
  for (const rule of rules) {
    const signal = signals[rule.name];
    if (!signal) continue;
    const raw = new Map<string, number>();
    for (const m of candidates) raw.set(m.id, rule.scoreModel(m, signal));
    // A fixedScale rule is already on an absolute 0..1 scale; min-max would
    // rescale whatever spread exists to fill the range and lose the magnitude.
    if (rule.fixedScale) {
      const clamped = new Map<string, number>();
      for (const [k, v] of raw) clamped.set(k, clamp01(v));
      normalizedByRule.set(rule.name, clamped);
      continue;
    }
    normalizedByRule.set(rule.name, normalize(raw));
  }

  const scored: ScoredModel[] = candidates.map((m) => {
    const breakdown: Record<string, number> = {};
    let total = 0;
    for (const rule of rules) {
      const weight = weights[rule.name] ?? 0;
      const norm = normalizedByRule.get(rule.name)?.get(m.id) ?? 0.5;
      const contribution = weight * norm;
      breakdown[rule.name] = contribution;
      total += contribution;
    }
    return { model: m, score: total, breakdown };
  });

  // Deterministic ordering: score desc, then cheaper blended cost, then id.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ca = a.model.costPer1kInput + a.model.costPer1kOutput;
    const cb = b.model.costPer1kInput + b.model.costPer1kOutput;
    if (ca !== cb) return ca - cb;
    return a.model.id < b.model.id ? -1 : a.model.id > b.model.id ? 1 : 0;
  });
  return scored;
}

const blended = (m: ModelDescriptor): number => m.costPer1kInput + m.costPer1kOutput;
const byId = (a: ScoredModel, b: ScoredModel): number =>
  a.model.id < b.model.id ? -1 : a.model.id > b.model.id ? 1 : 0;

/**
 * The frontier (top cluster, ADR 0017): model ids whose capability score `Q` is
 * within `delta` of the best. `scored` must be Q-sorted (scoreModels output).
 */
export function frontierIds(scored: ScoredModel[], delta: number): Set<string> {
  if (scored.length === 0) return new Set();
  const qmax = scored[0]!.score;
  const threshold = qmax > 0 ? qmax * (1 - delta) : -Infinity;
  return new Set(scored.filter((s) => s.score >= threshold).map((s) => s.model.id));
}

/**
 * Frontier-then-optimize (ADR 0017): re-order the Q-scored models so the strategy's
 * objective wins WITHIN the frontier, with non-frontier models trailing by `Q`.
 * `best` → frontier top; `value` → cheapest in frontier; `fast` → fastest in frontier.
 */
export function selectByObjective(
  scored: ScoredModel[],
  objective: Objective,
  delta: number,
): ScoredModel[] {
  if (scored.length === 0) return scored;
  const inFront = frontierIds(scored, delta);
  const frontier = scored.filter((s) => inFront.has(s.model.id));
  const rest = scored.filter((s) => !inFront.has(s.model.id)); // already Q-desc
  if (objective === "cost") {
    frontier.sort((a, b) => blended(a.model) - blended(b.model) || b.score - a.score || byId(a, b));
  } else if (objective === "latency") {
    frontier.sort((a, b) => a.model.avgLatencyMs - b.model.avgLatencyMs || b.score - a.score || byId(a, b));
  } else {
    frontier.sort((a, b) => b.score - a.score || blended(a.model) - blended(b.model) || byId(a, b));
  }
  return [...frontier, ...rest];
}

export function topReason(top: ScoredModel, strategy: Strategy, objective: Objective): string {
  const how =
    objective === "cost"
      ? "cheapest in the capability frontier"
      : objective === "latency"
        ? "fastest in the capability frontier"
        : "top of the capability frontier";
  return `${strategy}: ${how} (capability ${top.score.toFixed(2)})`;
}
