/**
 * The eight feature rules (ADR 0003). Each extracts a normalized 0..1 signal
 * and scores models against it. Scores may be any monotonic value ("higher is
 * better"); the scoring engine min-max normalizes them across candidates —
 * except for rules marked `fixedScale`, whose output is already 0..1 and whose
 * magnitude would be destroyed by min-max (see FeatureRule.fixedScale).
 */

import { supports, type FeatureScore, type ModelDescriptor } from "../../types.js";
import { clamp01, type FeatureRule } from "./types.js";

const LARGE_PROMPT_TOKENS = 128_000;
const LARGE_OUTPUT_TOKENS = 8_192;
const HARD_TASKS = new Set(["coding", "math", "reasoning", "analysis"]);
const LOCAL_PROVIDERS = new Set(["ollama", "local", "self_hosted"]);

const f = (name: string, value: number, raw?: FeatureScore["raw"], metadata?: Record<string, unknown>): FeatureScore => ({
  name,
  value,
  raw,
  metadata,
});

export const inputTokensRule: FeatureRule = {
  name: "input_tokens",
  extract(_req, analysis) {
    return f("input_tokens", clamp01(analysis.inputTokens / LARGE_PROMPT_TOKENS), analysis.inputTokens);
  },
  scoreModel(model, signal) {
    // Larger prompts weight cheap input pricing more heavily.
    return -model.costPer1kInput * (0.5 + signal.value);
  },
};

export const expectedOutputRule: FeatureRule = {
  name: "expected_output",
  extract(_req, analysis) {
    const tokens = analysis.classifier.expectedOutputTokens;
    return f("expected_output", clamp01(tokens / LARGE_OUTPUT_TOKENS), tokens);
  },
  scoreModel(model, signal) {
    return -model.costPer1kOutput * (0.5 + signal.value);
  },
};

export const complexityRule: FeatureRule = {
  name: "complexity",
  extract(_req, analysis) {
    const v = clamp01(analysis.classifier.complexity);
    return f("complexity", v, v);
  },
  scoreModel(model, signal) {
    // High complexity -> favor higher tier; low complexity -> favor lower tier.
    return model.tier * (2 * signal.value - 1);
  },
};

export const reasoningDepthRule: FeatureRule = {
  name: "reasoning_depth",
  // Already 0..1, and the magnitude matters: a prompt needing 10% reasoning
  // should hand a reasoning-capable model a tenth of the bonus, not all of it.
  fixedScale: true,
  extract(_req, analysis) {
    const v = clamp01(analysis.classifier.reasoningDepth);
    return f("reasoning_depth", v, v);
  },
  scoreModel(model, signal) {
    return signal.value * (supports(model, "reasoning") ? 1 : 0);
  },
};

export const taskTypeRule: FeatureRule = {
  name: "task_type",
  extract(_req, analysis) {
    const task = analysis.classifier.taskType;
    return f("task_type", HARD_TASKS.has(task) ? 1 : 0, task, { task });
  },
  scoreModel(model, signal) {
    return model.tier * signal.value;
  },
};

export const dataSensitivityRule: FeatureRule = {
  name: "data_sensitivity",
  // Same shape as reasoning_depth: 0..1, magnitude meaningful.
  fixedScale: true,
  extract(_req, analysis) {
    const v = clamp01(analysis.classifier.dataSensitivity);
    return f("data_sensitivity", v, v);
  },
  scoreModel(model, signal) {
    // Sensitive data biases toward local providers (none in v1 -> neutral).
    return signal.value * (LOCAL_PROVIDERS.has(model.provider) ? 1 : 0);
  },
};

export const costRule: FeatureRule = {
  name: "cost",
  extract() {
    return f("cost", 0.5, null);
  },
  scoreModel(model: ModelDescriptor) {
    return -(model.costPer1kInput + model.costPer1kOutput);
  },
};

export const latencyRule: FeatureRule = {
  name: "latency",
  extract() {
    return f("latency", 0.5, null);
  },
  scoreModel(model: ModelDescriptor) {
    return -model.avgLatencyMs;
  },
};

export const ALL_RULES: FeatureRule[] = [
  inputTokensRule,
  expectedOutputRule,
  complexityRule,
  reasoningDepthRule,
  taskTypeRule,
  dataSensitivityRule,
  costRule,
  latencyRule,
];
