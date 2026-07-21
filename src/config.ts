/**
 * Configuration loading and validation.
 *
 * Secrets come from the environment (.env); non-secret config comes from
 * config/*.yaml. Everything is validated at startup so misconfiguration fails
 * fast (testing invariant #18) rather than at request time.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { CAPABILITIES, STRATEGIES, type Capability, type ModelDescriptor } from "./types.js";

// Resolved at call time (not import time) so tests can point at fixtures.
function configDir(): string {
  return process.env.ROUTER_CONFIG_DIR ?? join(process.cwd(), "config");
}

const providerSchema = z.object({
  base_url: z.string().url(),
  api_key_env: z.string(),
});

const serverSchema = z.object({
  default_strategy: z.enum(STRATEGIES).default("balanced"),
  auth: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  classifier: z
    .object({
      enabled: z.boolean().default(true),
      provider: z.string().default("openai"),
      model: z.string().default("gpt-4.1-nano"),
      timeout_seconds: z.number().default(8),
      max_input_chars: z.number().int().default(8000),
    })
    .default({}),
  providers: z.record(providerSchema),
  // The /demo decision-inspector page + /v1/router/explain endpoint.
  demo: z.object({ enabled: z.boolean().default(true) }).default({}),
  // RouteLLM sidecar (ADR 0006) — surfaced as a shadow signal in the demo.
  routellm: z
    .object({
      enabled: z.boolean().default(false),
      url: z.string().default("http://localhost:8001"),
    })
    .default({}),
  telemetry: z
    .object({
      service_name: z.string().default("llm-model-router"),
      console_export: z.boolean().default(true),
      otlp: z
        .object({
          enabled: z.boolean().default(false),
          endpoint: z.string().default("http://localhost:4318/v1/traces"),
        })
        .default({}),
      // App Insights / Azure Monitor. Connection string from
      // APPLICATIONINSIGHTS_CONNECTION_STRING (secret, in .env).
      azure_monitor: z.object({ enabled: z.boolean().default(false) }).default({}),
      // Which OTel signals to emit (each exports to whatever backends are on).
      metrics: z.object({ enabled: z.boolean().default(true) }).default({}),
      logs: z.object({ enabled: z.boolean().default(true) }).default({}),
    })
    .default({}),
});

const strategiesSchema = z.object({
  strategies: z.record(z.record(z.number())),
});

const modelSchema = z.object({
  id: z.string(),
  provider: z.string(),
  tier: z.number().int(),
  context_window: z.number().int(),
  max_output_tokens: z.number().int(),
  cost_per_1k_input: z.number(),
  cost_per_1k_output: z.number(),
  avg_latency_ms: z.number().int(),
  capabilities: z.array(z.enum(CAPABILITIES)).default([]),
  api_key_env: z.string().optional(),
});

const catalogSchema = z.object({ models: z.array(modelSchema).min(1) });

export type ServerConfig = z.infer<typeof serverSchema>;

export interface AppConfig {
  server: ServerConfig;
  strategies: Record<string, Record<string, number>>;
  catalog: ModelDescriptor[];
  secrets: {
    routerApiKeys: Set<string>;
    classifierApiKey?: string;
  };
  providerApiKey(provider: string): string | undefined;
  /** Resolve the API key to use for a call: the model's own key (if its
   *  `api_key_env` is set and present) else the provider default. Per-model
   *  keys give the vendor billing dashboard a per-model cost breakdown. */
  resolveApiKey(provider: string, modelId?: string): string | undefined;
}

function loadYaml(name: string): unknown {
  const path = join(configDir(), name);
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    throw new Error(`required config file not found: ${path}`);
  }
  return parseYaml(text);
}

function toDescriptor(m: z.infer<typeof modelSchema>): ModelDescriptor {
  return {
    id: m.id,
    provider: m.provider,
    tier: m.tier,
    contextWindow: m.context_window,
    maxOutputTokens: m.max_output_tokens,
    costPer1kInput: m.cost_per_1k_input,
    costPer1kOutput: m.cost_per_1k_output,
    avgLatencyMs: m.avg_latency_ms,
    capabilities: new Set<Capability>(m.capabilities),
    apiKeyEnv: m.api_key_env,
  };
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;

  const server = serverSchema.parse(loadYaml("server.yaml"));
  const strategyBook = strategiesSchema.parse(loadYaml("strategies.yaml"));
  const catalogRaw = catalogSchema.parse(loadYaml("models.yaml"));

  // Cross-validation (fail fast).
  for (const s of STRATEGIES) {
    if (!strategyBook.strategies[s]) {
      throw new Error(`strategies.yaml missing weight vector for: ${s}`);
    }
  }
  const ids = catalogRaw.models.map((m) => m.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) throw new Error(`duplicate model ids in catalog: ${dupes.join(", ")}`);

  const providerNames = new Set(Object.keys(server.providers));
  for (const m of catalogRaw.models) {
    if (!providerNames.has(m.provider)) {
      throw new Error(`model '${m.id}' references unknown provider '${m.provider}'`);
    }
  }
  if (server.classifier.enabled && !providerNames.has(server.classifier.provider)) {
    throw new Error(`classifier provider '${server.classifier.provider}' is not configured`);
  }

  const routerApiKeys = new Set(
    (process.env.ROUTER_API_KEYS ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );

  const catalog = catalogRaw.models.map(toDescriptor);
  const byId = new Map(catalog.map((m) => [m.id, m]));

  cached = {
    server,
    strategies: strategyBook.strategies,
    catalog,
    secrets: {
      routerApiKeys,
      // `|| undefined` so an empty env var (e.g. `CLASSIFIER_API_KEY=`) is
      // treated as absent — otherwise `?? fallback` would keep the empty string.
      classifierApiKey: process.env.CLASSIFIER_API_KEY || undefined,
    },
    providerApiKey(provider: string): string | undefined {
      const p = server.providers[provider];
      if (!p) return undefined;
      return process.env[p.api_key_env] || undefined;
    },
    resolveApiKey(provider: string, modelId?: string): string | undefined {
      if (modelId) {
        const model = byId.get(modelId);
        if (model?.apiKeyEnv) {
          const key = process.env[model.apiKeyEnv];
          if (key) return key;
        }
      }
      return this.providerApiKey(provider);
    },
  };
  return cached;
}

/** Test helper — clear the memoized config. */
export function resetConfigCache(): void {
  cached = null;
}
