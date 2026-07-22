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

export function topReason(top: ScoredModel, strategy: Strategy): string {
  const entries = Object.entries(top.breakdown);
  if (entries.length === 0) return `${strategy}: default`;
  const dominant = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
  return `${strategy}: ${dominant[0]} (score ${top.score.toFixed(2)})`;
}
