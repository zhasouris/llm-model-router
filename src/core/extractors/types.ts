import type {
  FeatureScore,
  ModelDescriptor,
  RequestAnalysis,
  RoutingRequest,
} from "../../types.js";

/**
 * A scoring rule (ADR 0003): extracts a normalized signal from the request
 * (Stage 1), then scores a candidate model against that signal (Stage 2).
 * Option (b) — each rule owns both halves, so adding a criterion is one drop-in.
 */
export interface FeatureRule {
  readonly name: string;
  extract(req: RoutingRequest, analysis: RequestAnalysis): FeatureScore;
  scoreModel(model: ModelDescriptor, signal: FeatureScore): number;
  /**
   * Set when `scoreModel` already returns a value on a fixed 0..1 scale, where
   * the *magnitude* carries meaning — 0.1 means "barely relevant", not merely
   * "least of this candidate set".
   *
   * Such rules are used as-is instead of being min-max normalized across
   * candidates. Min-max would stretch whatever spread happens to exist to fill
   * 0..1, so a signal of 0.1 against a signal of 1.0 would contribute exactly
   * the same amount — turning a graded preference into a flat capability flag.
   *
   * Rules whose raw units are unbounded (dollars, milliseconds, tier products)
   * must leave this unset: they have no meaningful absolute scale, so relative
   * comparison across the candidate set is the only thing available.
   */
  readonly fixedScale?: boolean;
}

/** Clamp to the 0..1 range weighted scoring requires (invariant #8). */
export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
