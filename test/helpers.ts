import { ALL_RULES } from "../src/core/extractors/rules.js";
import {
  defaultClassifierResult,
  type Capability,
  type ChatCompletionRequest,
  type ClassifierResult,
  type ModelDescriptor,
  type RequestAnalysis,
  type RoutingRequest,
  type Strategy,
} from "../src/types.js";

export function makeModel(
  id: string,
  opts: Partial<{
    provider: string;
    tier: number;
    contextWindow: number;
    maxOutputTokens: number;
    costIn: number;
    costOut: number;
    latency: number;
    caps: Capability[];
  }> = {},
): ModelDescriptor {
  return {
    id,
    provider: opts.provider ?? "openai",
    tier: opts.tier ?? 3,
    contextWindow: opts.contextWindow ?? 200_000,
    maxOutputTokens: opts.maxOutputTokens ?? 16_000,
    costPer1kInput: opts.costIn ?? 1.0,
    costPer1kOutput: opts.costOut ?? 2.0,
    avgLatencyMs: opts.latency ?? 1000,
    capabilities: new Set<Capability>(opts.caps ?? ["tools", "structured_output"]),
  };
}

export function fixtureCatalog(): ModelDescriptor[] {
  return [
    makeModel("cheap-nano", { tier: 2, costIn: 0.1, costOut: 0.4, latency: 400 }),
    makeModel("mid-mini", { tier: 3, costIn: 0.4, costOut: 1.6, latency: 800 }),
    makeModel("strong-max", { tier: 5, costIn: 5.0, costOut: 15.0, latency: 3000 }),
    makeModel("vision-only", {
      tier: 4,
      costIn: 2.0,
      costOut: 8.0,
      latency: 1500,
      caps: ["vision", "tools", "structured_output"],
    }),
  ];
}

export function makeRequest(
  opts: Partial<{ bypass: boolean; strategy: Strategy; body: ChatCompletionRequest }> = {},
): RoutingRequest {
  return {
    body: opts.body ?? { messages: [{ role: "user", content: "hi" }] },
    options: {
      strategy: opts.strategy ?? "value",
      bypass: opts.bypass ?? false,
      maxCost: null,
      warnings: [],
    },
    requiresVision: false,
    requiresTools: false,
    requiresStructuredOutput: false,
    requiresAudio: false,
  };
}

export function makeAnalysis(
  opts: Partial<{ inputTokens: number; classifier: ClassifierResult }> = {},
): RequestAnalysis {
  const analysis: RequestAnalysis = {
    inputTokens: opts.inputTokens ?? 100,
    classifier: opts.classifier ?? defaultClassifierResult(),
    features: {},
    signalProvider: "test",
  };
  const req = makeRequest();
  for (const rule of ALL_RULES) analysis.features[rule.name] = rule.extract(req, analysis);
  return analysis;
}
