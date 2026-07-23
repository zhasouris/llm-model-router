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
import { CAPABILITIES, OBJECTIVES, STRATEGIES, TASK_TYPES, type Capability, type CompetencyEntry, type ModelDescriptor, type Objective } from "./types.js";

// Resolved at call time (not import time) so tests can point at fixtures.
function configDir(): string {
  return process.env.ROUTER_CONFIG_DIR ?? join(process.cwd(), "config");
}

const providerSchema = z.object({
  base_url: z.string().url(),
  api_key_env: z.string(),
  // Vendor transformer (ADR 0001). Defaults to `openai` (passthrough — OpenAI +
  // all OpenAI-compatible vendors). Native adapters: e.g. `anthropic`.
  adapter: z.string().default("openai"),
});

const serverSchema = z.object({
  default_strategy: z.enum(STRATEGIES).default("value"),
  // OAuth 2.0 client-credentials resource-server validation (ADR 0015).
  // `enabled: false` opens /v1 for local dev. When enabled, every /v1 request
  // must carry a valid JWT: signed by the issuer's JWKS, `iss`/`aud` matching,
  // unexpired, and (if set) carrying `required_scope`. Fail-closed — no issuer
  // configured means nothing validates, so /v1 answers 401 (the demo-only
  // deployment's closed posture).
  auth: z
    .object({
      enabled: z.boolean().default(true),
      issuer: z.string().default(""),
      audience: z.string().default(""),
      required_scope: z.string().default(""),
      // Optional explicit JWKS URL; otherwise derived from the issuer's
      // OIDC discovery document.
      jwks_uri: z.string().default(""),
    })
    .default({}),
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
  demo: z
    .object({
      enabled: z.boolean().default(true),
      // Show a "first request may be slow" banner. Set by deployments that
      // scale to zero (Azure `minReplicas: 0`), where a cold start adds a few
      // seconds to the first request after idle. Off for always-on runtimes.
      cold_start_hint: z.boolean().default(false),
    })
    .default({}),
  // RouteLLM sidecar (ADR 0006) — surfaced as a shadow signal in the demo.
  routellm: z
    .object({
      enabled: z.boolean().default(false),
      url: z.string().default("http://localhost:8001"),
    })
    .default({}),
  telemetry: z
    .object({
      service_name: z.string().default("corgi-ai-gateway"),
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

// Frontier-then-optimize routing config (ADR 0017): shared capability weights,
// the frontier width, and each strategy's objective.
const strategiesSchema = z.object({
  capability_weights: z.record(z.number()),
  frontier_delta: z.number().min(0).max(1).default(0.12),
  strategies: z.record(z.enum(OBJECTIVES)),
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

// Per-task competency (ADR 0010). Optional, sparse, keyed by model id then task.
// `source` and `updated` are required so a number's provenance is never lost.
const competencyEntrySchema = z.object({
  score: z.number().min(0).max(1),
  source: z.string().min(1),
  updated: z.union([z.string(), z.date()]),
  confidence: z.string().optional(),
});
const competencySchema = z.object({
  models: z.record(z.record(competencyEntrySchema)).default({}),
});

export type ServerConfig = z.infer<typeof serverSchema>;

export interface RoutingConfig {
  /** Capability-score (Q) weights, shared across strategies (ADR 0017). */
  capabilityWeights: Record<string, number>;
  /** Frontier width: a model is in the frontier when Q >= Q_max * (1 - delta). */
  frontierDelta: number;
  /** Each strategy's objective within the frontier. */
  objectives: Record<string, Objective>;
}

export interface AppConfig {
  server: ServerConfig;
  routing: RoutingConfig;
  catalog: ModelDescriptor[];
  secrets: {
    classifierApiKey?: string;
  };
  providerApiKey(provider: string): string | undefined;
  /** Resolve the API key to use for a call: the model's own key (if its
   *  `api_key_env` is set and present) else the provider default. Per-model
   *  keys give the vendor billing dashboard a per-model cost breakdown. */
  resolveApiKey(provider: string, modelId?: string): string | undefined;
}

const TRUTHY_ENV = new Set(["1", "true", "yes", "on"]);

/** Read a boolean env var. Returns undefined when unset/blank so the YAML wins. */
function boolEnv(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return undefined;
  return TRUTHY_ENV.has(raw.trim().toLowerCase());
}

/**
 * Deployment-time overrides. config/*.yaml is baked into the container image, so
 * a hosted environment has no way to edit it — these let a deployment flip the
 * handful of switches that legitimately differ from local dev (console tracing
 * off, Azure Monitor on, inspector page closed) without rebuilding the image.
 * Only set values override; anything unset leaves the file value alone.
 */
function applyEnvOverrides(server: ServerConfig): ServerConfig {
  const demo = boolEnv("DEMO_ENABLED");
  if (demo !== undefined) server.demo.enabled = demo;

  const coldStart = boolEnv("DEMO_COLD_START_HINT");
  if (coldStart !== undefined) server.demo.cold_start_hint = coldStart;

  const consoleExport = boolEnv("OTEL_CONSOLE_EXPORT");
  if (consoleExport !== undefined) server.telemetry.console_export = consoleExport;

  const azureMonitor = boolEnv("AZURE_MONITOR_ENABLED");
  if (azureMonitor !== undefined) server.telemetry.azure_monitor.enabled = azureMonitor;

  const routellm = boolEnv("ROUTELLM_ENABLED");
  if (routellm !== undefined) server.routellm.enabled = routellm;
  if (process.env.ROUTELLM_URL) server.routellm.url = process.env.ROUTELLM_URL;

  // OAuth resource-server config (ADR 0015) — non-secret, so it can come from
  // the environment on a hosted deployment. Issuer/audience/scope are public.
  const authEnabled = boolEnv("AUTH_ENABLED");
  if (authEnabled !== undefined) server.auth.enabled = authEnabled;
  if (process.env.AUTH_ISSUER) server.auth.issuer = process.env.AUTH_ISSUER;
  if (process.env.AUTH_AUDIENCE) server.auth.audience = process.env.AUTH_AUDIENCE;
  if (process.env.AUTH_REQUIRED_SCOPE) server.auth.required_scope = process.env.AUTH_REQUIRED_SCOPE;
  if (process.env.AUTH_JWKS_URI) server.auth.jwks_uri = process.env.AUTH_JWKS_URI;

  return server;
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

/** Like loadYaml but returns null when the file is absent (optional configs). */
function loadYamlOptional(name: string): unknown {
  const path = join(configDir(), name);
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  return parseYaml(text);
}

function toDescriptor(
  m: z.infer<typeof modelSchema>,
  competency?: Record<string, CompetencyEntry>,
): ModelDescriptor {
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
    competency,
  };
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;

  const server = applyEnvOverrides(serverSchema.parse(loadYaml("server.yaml")));
  const strategyBook = strategiesSchema.parse(loadYaml("strategies.yaml"));
  const catalogRaw = catalogSchema.parse(loadYaml("models.yaml"));

  // Cross-validation (fail fast): every strategy needs a frontier objective.
  for (const s of STRATEGIES) {
    if (!strategyBook.strategies[s]) {
      throw new Error(`strategies.yaml missing objective for strategy: ${s}`);
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

  // Competency (ADR 0010) — optional, sparse. Validate ids/tasks so a typo fails
  // fast rather than silently never matching.
  const competencyRaw = competencySchema.parse(loadYamlOptional("competency.yaml") ?? { models: {} });
  const catalogIds = new Set(catalogRaw.models.map((m) => m.id));
  const validTasks = new Set<string>(TASK_TYPES);
  const competencyByModel: Record<string, Record<string, CompetencyEntry>> = {};
  for (const [modelId, tasks] of Object.entries(competencyRaw.models)) {
    if (!catalogIds.has(modelId)) {
      throw new Error(`competency.yaml references unknown model id '${modelId}'`);
    }
    const entries: Record<string, CompetencyEntry> = {};
    for (const [task, entry] of Object.entries(tasks)) {
      if (!validTasks.has(task)) {
        throw new Error(`competency.yaml: model '${modelId}' has unknown task '${task}'`);
      }
      entries[task] = {
        score: entry.score,
        source: entry.source,
        updated: String(entry.updated),
        confidence: entry.confidence,
      };
    }
    competencyByModel[modelId] = entries;
  }

  const catalog = catalogRaw.models.map((m) => toDescriptor(m, competencyByModel[m.id]));
  const byId = new Map(catalog.map((m) => [m.id, m]));

  cached = {
    server,
    routing: {
      capabilityWeights: strategyBook.capability_weights,
      frontierDelta: strategyBook.frontier_delta,
      objectives: strategyBook.strategies,
    },
    catalog,
    secrets: {
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
