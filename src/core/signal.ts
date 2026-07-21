/**
 * SignalProvider — the pluggable source of the subjective/predictive signal
 * (ADR 0006). Two implementations ship today:
 *
 *   - LlmClassifierProvider : a chat-LLM call (runtime default; needs network)
 *   - HeuristicSignalProvider: deterministic, offline (eval dry-run + fallback)
 *
 * A future RouteLLMProvider (Python sidecar over HTTP) implements the same
 * interface, so it drops in without touching the router or scorer.
 */

import OpenAI from "openai";
import type { AppConfig } from "../config.js";
import {
  defaultClassifierResult,
  type ChatMessage,
  type ClassifierResult,
  type RoutingRequest,
} from "../types.js";
import { clamp01 } from "./extractors/types.js";
import { logWarn } from "../logger.js";

export interface SignalProvider {
  readonly name: string;
  analyze(req: RoutingRequest): Promise<ClassifierResult>;
}

export function promptText(req: RoutingRequest, maxChars: number): string {
  const parts: string[] = [];
  for (const msg of (req.body.messages ?? []) as ChatMessage[]) {
    if (typeof msg.content === "string") parts.push(msg.content);
    else if (Array.isArray(msg.content)) {
      for (const p of msg.content) if (typeof p.text === "string") parts.push(p.text);
    }
  }
  return parts.join("\n").slice(0, maxChars);
}

// --- LLM classifier (runtime default) --------------------------------------

const CLASSIFIER_SYSTEM =
  "You are a routing classifier. Analyze the user's request and respond with a " +
  "single JSON object and nothing else, with keys: complexity (0..1 float), " +
  "expected_output_tokens (int), reasoning_depth (0..1 float), task_type (one of: " +
  "coding, math, reasoning, analysis, summarization, extraction, creative, " +
  "translation, conversation), data_sensitivity (0..1 float). No explanations.";

function parseClassifier(raw: string): ClassifierResult {
  const data = JSON.parse(raw) as Record<string, unknown>;
  const num = (v: unknown, d: number) => (typeof v === "number" ? v : d);
  return {
    complexity: num(data.complexity, 0.5),
    expectedOutputTokens: Math.round(num(data.expected_output_tokens, 512)),
    reasoningDepth: num(data.reasoning_depth, 0.0),
    taskType: typeof data.task_type === "string" ? data.task_type : "conversation",
    dataSensitivity: num(data.data_sensitivity, 0.0),
    degraded: false,
  };
}

export class LlmClassifierProvider implements SignalProvider {
  readonly name = "llm-classifier";
  constructor(private readonly config: AppConfig) {}

  async analyze(req: RoutingRequest): Promise<ClassifierResult> {
    const cfg = this.config.server.classifier;
    if (!cfg.enabled) return defaultClassifierResult(true);

    const provider = this.config.server.providers[cfg.provider];
    if (!provider) return defaultClassifierResult(true);

    const apiKey =
      this.config.secrets.classifierApiKey ??
      this.config.resolveApiKey(cfg.provider, cfg.model);
    const client = new OpenAI({
      baseURL: provider.base_url,
      apiKey: apiKey ?? "missing",
      timeout: cfg.timeout_seconds * 1000,
      maxRetries: 0,
    });

    try {
      const resp = await client.chat.completions.create({
        model: cfg.model,
        messages: [
          { role: "system", content: CLASSIFIER_SYSTEM },
          { role: "user", content: promptText(req, cfg.max_input_chars) },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
      });
      return parseClassifier(resp.choices[0]?.message?.content ?? "{}");
    } catch (err) {
      logWarn("classifier failed, degrading to defaults", {
        provider: cfg.provider,
        model: cfg.model,
        error: (err as Error).message,
      });
      return defaultClassifierResult(true);
    }
  }
}

// --- Heuristic provider (deterministic, offline) ---------------------------

const HARD = [
  "prove", "proof", "algorithm", "optimize", "race condition", "concurren",
  "architect", "refactor", "debug", "derive", "theorem", "complexity",
  "analyze", "analysis", "o(n", "distributed", "trade-off", "tradeoff",
];
const EASY = [
  "rephrase", "summar", "translate", "hello", "greeting", "what is", "list ",
  "format", "typo", "spelling", "capital of", "say hi",
];
const CODE = ["code", "function", "typescript", "python", "bug", "compile", "stack trace", "regex", "sql", "api"];
const MATH = ["integral", "equation", "derivative", "probability", "matrix", "calculus", "solve for", "prime"];
const CREATIVE = ["poem", "haiku", "story", "song", "creative", "imagine"];
const REASON = ["why", "step by step", "reason", "plan", "prove", "explain how", "strategy"];
const LONG = ["write", "essay", "generate", "draft", "implement", "explain", "guide", "tutorial", "report"];
const SHORT = ["yes or no", "classify", "which", "extract", "label", "one word", "true or false"];
const SENSITIVE = ["password", "ssn", "social security", "credit card", "medical", "patient", "confidential", "api key", "private key"];

const has = (t: string, ks: string[]) => ks.some((k) => t.includes(k));

/**
 * A cheap, deterministic signal derived from the prompt text. Used for the eval
 * harness dry-run (hermetic) and as a fallback provider. Not as good as a
 * trained model or an LLM — just consistent and free.
 */
export class HeuristicSignalProvider implements SignalProvider {
  readonly name = "heuristic";
  constructor(private readonly maxChars = 8000) {}

  async analyze(req: RoutingRequest): Promise<ClassifierResult> {
    const t = promptText(req, this.maxChars).toLowerCase();
    const len = t.length;

    // Count keyword hits so genuinely hard prompts clear the 0.5 midpoint that
    // the complexity rule pivots on.
    const hardHits = HARD.filter((k) => t.includes(k)).length;
    const easyHits = EASY.filter((k) => t.includes(k)).length;
    let complexity = clamp01(0.25 + 0.15 * hardHits - 0.2 * easyHits + Math.min(0.2, len / 8000));

    let taskType = "conversation";
    if (has(t, CODE)) taskType = "coding";
    else if (has(t, MATH)) taskType = "math";
    else if (has(t, CREATIVE)) taskType = "creative";
    else if (has(t, EASY)) taskType = "summarization";

    if (taskType === "coding" || taskType === "math") complexity = clamp01(complexity + 0.1);

    const reasoningDepth = has(t, REASON) ? clamp01(0.3 + complexity * 0.5) : complexity * 0.3;

    let expectedOutputTokens = 512;
    if (has(t, LONG)) expectedOutputTokens = 1200;
    if (has(t, SHORT)) expectedOutputTokens = 128;
    expectedOutputTokens = Math.round(expectedOutputTokens * (0.7 + complexity));

    const dataSensitivity = has(t, SENSITIVE) ? 0.8 : 0.0;

    return {
      complexity,
      expectedOutputTokens,
      reasoningDepth,
      taskType,
      dataSensitivity,
      degraded: false,
    };
  }
}

// --- RouteLLM provider (trained difficulty signal via Python sidecar) -------

/**
 * Difficulty signal from a RouteLLM sidecar (ADR 0006). RouteLLM answers a
 * binary strong-vs-weak win-rate, which we map onto `complexity`; the other
 * signals (task type, expected output, sensitivity) are backfilled from the
 * heuristic provider — the "fast-path completeness" answer. Falls back entirely
 * to the heuristic if the sidecar is unreachable (graceful degradation).
 */
export interface RouteLLMScore {
  winRate: number;
  confidence: number;
}

/** Fetch the raw RouteLLM win-rate from the sidecar. Returns null if the sidecar
 *  is unreachable, times out, or replies unexpectedly (graceful). */
export async function fetchRouteLLMScore(
  url: string,
  prompt: string,
  timeoutMs = 5000,
): Promise<RouteLLMScore | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(`${url.replace(/\/$/, "")}/score`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
      signal: ac.signal,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { winRate?: number; confidence?: number };
    if (typeof data.winRate !== "number") return null;
    return {
      winRate: data.winRate,
      confidence:
        typeof data.confidence === "number" ? data.confidence : Math.abs(data.winRate - 0.5) * 2,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export class RouteLLMProvider implements SignalProvider {
  readonly name = "routellm";
  private readonly heuristic: HeuristicSignalProvider;

  constructor(
    private readonly url: string,
    private readonly maxChars = 8000,
    private readonly timeoutMs = 5000,
  ) {
    this.heuristic = new HeuristicSignalProvider(this.maxChars);
  }

  async analyze(req: RoutingRequest): Promise<ClassifierResult> {
    const base = await this.heuristic.analyze(req);
    const score = await fetchRouteLLMScore(this.url, promptText(req, this.maxChars), this.timeoutMs);
    if (!score) {
      logWarn("routellm sidecar unavailable, using heuristic", { url: this.url });
      return { ...base, degraded: true };
    }
    // Win-rate = P(strong model needed) → our difficulty signal.
    return {
      ...base,
      complexity: clamp01(score.winRate),
      reasoningDepth: clamp01(score.winRate * 0.8),
    };
  }
}
