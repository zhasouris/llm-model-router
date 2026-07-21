/**
 * Routing orchestrator — the pipeline from ADR 0003.
 *
 *   detect -> (bypass?) -> analyze -> filter -> score -> decision
 *
 * `decide()` returns the decision plus the analysis trace (used by the eval
 * harness for costing); `route()` is the thin wrapper the API uses.
 */

import { trace } from "@opentelemetry/api";
import type { AppConfig } from "../config.js";
import { recordDecision } from "../metrics.js";
import type {
  ClassifierResult,
  FeatureScore,
  ModelDescriptor,
  RequestAnalysis,
  RoutingDecision,
  RoutingRequest,
  Strategy,
} from "../types.js";
import { makeAnalyze, type AnalyzeFn } from "./analysis.js";
import { ALL_CONSTRAINTS } from "./constraints.js";
import { detectRequirements } from "./detect.js";
import { ALL_RULES } from "./extractors/rules.js";
import { filterCandidates, scoreModels, topReason } from "./scoring.js";
import { LlmClassifierProvider } from "./signal.js";

const tracer = trace.getTracer("router.core");

export class NoEligibleModelError extends Error {}

/** Decision plus the analysis that produced it (analysis absent when bypassed). */
export interface RouteTrace {
  decision: RoutingDecision;
  analysis?: RequestAnalysis;
}

export class Router {
  private readonly catalog: ModelDescriptor[];
  private readonly byId: Map<string, ModelDescriptor>;
  private readonly analyzeFn: AnalyzeFn;

  constructor(
    private readonly config: AppConfig,
    analyzeFn?: AnalyzeFn,
  ) {
    this.catalog = config.catalog;
    this.byId = new Map(this.catalog.map((m) => [m.id, m]));
    this.analyzeFn = analyzeFn ?? makeAnalyze(new LlmClassifierProvider(config));
  }

  private providerFor(modelId: string): string {
    const model = this.byId.get(modelId);
    if (model) return model.provider;
    return modelId.startsWith("claude") ? "anthropic" : "openai";
  }

  async decide(req: RoutingRequest): Promise<RouteTrace> {
    const started = Date.now();
    Object.assign(req, detectRequirements(req.body));

    if (req.options.bypass) {
      const modelId = req.body.model ?? "";
      const provider = this.providerFor(modelId);
      recordDecision({
        strategy: req.options.strategy,
        model: modelId,
        provider,
        bypassed: true,
        degraded: false,
        durationMs: Date.now() - started,
      });
      return {
        decision: {
          modelId,
          provider,
          reason: "bypass",
          strategy: req.options.strategy,
          bypassed: true,
          ranked: [],
          warnings: req.options.warnings,
        },
      };
    }

    const analysis = await this.analyzeFn(req);

    return tracer.startActiveSpan("router.score", (span) => {
      let candidates = filterCandidates(this.catalog, ALL_CONSTRAINTS, req, analysis);
      if (req.options.maxCost != null) {
        const ceiling = req.options.maxCost;
        candidates = candidates.filter(
          (m) => m.costPer1kInput + m.costPer1kOutput <= ceiling,
        );
      }

      if (candidates.length === 0) {
        span.end();
        throw new NoEligibleModelError(
          "no model satisfies the request's capability/context constraints",
        );
      }

      const weights = this.config.strategies[req.options.strategy] ?? {};
      const ranked = scoreModels(candidates, ALL_RULES, analysis.features, weights);
      const top = ranked[0]!;

      const warnings = [...req.options.warnings];
      if (analysis.classifier.degraded) {
        warnings.push("classifier degraded; used deterministic defaults");
      }

      span.setAttribute("router.model", top.model.id);
      span.setAttribute("router.provider", top.model.provider);
      span.setAttribute("router.strategy", req.options.strategy);
      span.setAttribute("router.candidates", candidates.length);
      span.end();

      const estimatedCost =
        (analysis.inputTokens / 1000) * top.model.costPer1kInput +
        (analysis.classifier.expectedOutputTokens / 1000) * top.model.costPer1kOutput;
      recordDecision({
        strategy: req.options.strategy,
        model: top.model.id,
        provider: top.model.provider,
        bypassed: false,
        degraded: analysis.classifier.degraded,
        durationMs: Date.now() - started,
        estimatedCost,
      });

      return {
        decision: {
          modelId: top.model.id,
          provider: top.model.provider,
          reason: topReason(top, req.options.strategy),
          strategy: req.options.strategy,
          bypassed: false,
          ranked,
          warnings,
        },
        analysis,
      };
    });
  }

  async route(req: RoutingRequest): Promise<RoutingDecision> {
    return (await this.decide(req)).decision;
  }

  /**
   * Run the full pipeline for inspection WITHOUT forwarding — returns every
   * intermediate the router determined (detected requirements, signals, which
   * models were eligible/excluded and why, the ranked scores, and the pick).
   * Powers the /demo decision-inspector page.
   */
  async explain(req: RoutingRequest): Promise<ExplainResult> {
    Object.assign(req, detectRequirements(req.body));
    const analysis = await this.analyzeFn(req);

    const eligibleModels = filterCandidates(this.catalog, ALL_CONSTRAINTS, req, analysis);
    const eligibleSet = new Set(eligibleModels.map((m) => m.id));
    const excluded = this.catalog
      .filter((m) => !eligibleSet.has(m.id))
      .map((m) => ({
        model: m.id,
        failedConstraints: ALL_CONSTRAINTS.filter((c) => !c.admits(m, req, analysis)).map(
          (c) => c.name,
        ),
      }));

    const weights = this.config.strategies[req.options.strategy] ?? {};
    const scored = scoreModels(eligibleModels, ALL_RULES, analysis.features, weights);
    const outTokens = analysis.classifier.expectedOutputTokens;
    const ranked = scored.map((s) => ({
      model: s.model.id,
      provider: s.model.provider,
      tier: s.model.tier,
      score: Number(s.score.toFixed(4)),
      breakdown: s.breakdown,
      estimatedCost: Number(
        (
          (analysis.inputTokens / 1000) * s.model.costPer1kInput +
          (outTokens / 1000) * s.model.costPer1kOutput
        ).toFixed(6),
      ),
    }));

    const warnings = [...req.options.warnings];
    if (analysis.classifier.degraded) {
      warnings.push("signal degraded; used deterministic defaults");
    }

    const top = scored[0];
    return {
      strategy: req.options.strategy,
      detected: {
        requiresVision: req.requiresVision,
        requiresTools: req.requiresTools,
        requiresStructuredOutput: req.requiresStructuredOutput,
        requiresAudio: req.requiresAudio,
      },
      inputTokens: analysis.inputTokens,
      classifier: analysis.classifier,
      features: analysis.features,
      eligible: eligibleModels.map((m) => m.id),
      excluded,
      ranked,
      decision: top
        ? {
            model: top.model.id,
            provider: top.model.provider,
            reason: topReason(top, req.options.strategy),
          }
        : null,
      warnings,
    };
  }
}

export interface ExplainResult {
  strategy: Strategy;
  detected: {
    requiresVision: boolean;
    requiresTools: boolean;
    requiresStructuredOutput: boolean;
    requiresAudio: boolean;
  };
  inputTokens: number;
  classifier: ClassifierResult;
  features: Record<string, FeatureScore>;
  eligible: string[];
  excluded: { model: string; failedConstraints: string[] }[];
  ranked: {
    model: string;
    provider: string;
    tier: number;
    score: number;
    breakdown: Record<string, number>;
    estimatedCost: number;
  }[];
  decision: { model: string; provider: string; reason: string } | null;
  warnings: string[];
}
