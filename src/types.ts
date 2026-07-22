/**
 * Domain types for the routing pipeline.
 *
 * The router operates on these internal types, never on raw vendor payloads
 * (the seam promised in ADR 0001). In v1 the wire format is OpenAI-shaped, so
 * the request is kept loose and forwarded near-verbatim.
 */

export const STRATEGIES = ["cost", "quality", "latency", "balanced"] as const;
export type Strategy = (typeof STRATEGIES)[number];

export function isStrategy(v: string): v is Strategy {
  return (STRATEGIES as readonly string[]).includes(v);
}

export const CAPABILITIES = [
  "vision",
  "tools",
  "structured_output",
  "audio",
  "reasoning",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Loose view of an OpenAI chat.completions request; forwarded unchanged
 *  except for `model` (testing invariant #14). */
export interface ChatCompletionRequest {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  tools?: unknown[];
  functions?: unknown[];
  response_format?: { type?: string } & Record<string, unknown>;
  modalities?: string[];
  max_tokens?: number;
  max_completion_tokens?: number;
  [key: string]: unknown;
}

export interface ChatMessage {
  role: string;
  content?: string | ContentPart[];
  [key: string]: unknown;
}

export interface ContentPart {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

/** Router controls derived from request headers (ADR 0002). */
export interface RouterOptions {
  strategy: Strategy;
  bypass: boolean;
  maxCost: number | null;
  warnings: string[];
}

export interface RoutingRequest {
  body: ChatCompletionRequest;
  options: RouterOptions;
  requiresVision: boolean;
  requiresTools: boolean;
  requiresStructuredOutput: boolean;
  requiresAudio: boolean;
}

/** Structured output from the single classifier call (ADR 0003). */
export interface ClassifierResult {
  complexity: number;
  expectedOutputTokens: number;
  reasoningDepth: number;
  taskType: string;
  dataSensitivity: number;
  /** True when the classifier was skipped/failed and defaults were used. */
  degraded: boolean;
}

export function defaultClassifierResult(degraded = false): ClassifierResult {
  return {
    complexity: 0.5,
    expectedOutputTokens: 512,
    reasoningDepth: 0.0,
    taskType: "conversation",
    dataSensitivity: 0.0,
    degraded,
  };
}

/** A normalized 0..1 signal from one extractor, plus its raw value. */
export interface FeatureScore {
  name: string;
  value: number;
  raw?: number | string | null;
  metadata?: Record<string, unknown>;
}

export interface RequestAnalysis {
  inputTokens: number;
  classifier: ClassifierResult;
  features: Record<string, FeatureScore>;
}

export interface ModelDescriptor {
  id: string;
  provider: string;
  tier: number;
  contextWindow: number;
  maxOutputTokens: number;
  costPer1kInput: number;
  costPer1kOutput: number;
  avgLatencyMs: number;
  capabilities: Set<Capability>;
  /** Optional env var holding this model's own API key (for per-model billing);
   *  falls back to the provider default key when unset. */
  apiKeyEnv?: string;
}

export function supports(model: ModelDescriptor, cap: Capability): boolean {
  return model.capabilities.has(cap);
}

export interface ScoredModel {
  model: ModelDescriptor;
  score: number;
  breakdown: Record<string, number>;
}

export interface RoutingDecision {
  modelId: string;
  provider: string;
  reason: string;
  strategy: Strategy;
  bypassed: boolean;
  ranked: ScoredModel[];
  warnings: string[];
  /** Wall-clock ms spent deciding — detection, signal, filtering, scoring.
   *  Excludes the upstream call, so it measures the overhead the proxy adds. */
  routingMs: number;
}
