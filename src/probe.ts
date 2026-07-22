/**
 * Provider probes — does this key actually work?
 *
 * `/v1/router/models` reports whether a key is *present*. That is not the same
 * as usable, and the difference is not academic: a catalog can hold a model id
 * the vendor has since retired, in which case the key authenticates perfectly
 * and every request 404s. Availability cannot see that. Only a real call can.
 *
 * So this sends the smallest possible completion through the normal forwarding
 * path — including the vendor adapter (ADR 0001) — and classifies the result.
 * It SPENDS, so it is authenticated, cached, and deliberately not wired into
 * anything that runs on its own.
 */

import type { AppConfig } from "./config.js";
import type { ForwarderLike } from "./providers/forwarder.js";

export type ProbeOutcome = "ok" | "no_key" | "bad_key" | "model_gone" | "provider_error" | "unreachable";

export interface ProbeResult {
  provider: string;
  /** Cheapest catalog model for the provider — least spend to prove the path. */
  model: string | null;
  outcome: ProbeOutcome;
  /** Upstream HTTP status, when we got one. */
  status?: number;
  latencyMs?: number;
  /** Upstream error text, truncated. Never contains the key. */
  detail?: string;
}

const PROBE_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 60_000;
const DETAIL_MAX = 300;

interface CacheEntry {
  at: number;
  result: ProbeResult;
}
const cache = new Map<string, CacheEntry>();

/** Exposed for tests; also worth having when a key is rotated mid-process. */
export function clearProbeCache(): void {
  cache.clear();
}

/**
 * Map an upstream status onto something actionable. The distinction that
 * matters most is 401 (the credential is wrong) versus 404 (the credential is
 * fine and the *catalog* is wrong) — they look identical from the outside and
 * have completely different fixes.
 */
function classify(status: number): ProbeOutcome {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403) return "bad_key";
  if (status === 404) return "model_gone";
  return "provider_error";
}

function extractDetail(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    const node = Array.isArray(parsed) ? parsed[0] : parsed;
    const err = (node as { error?: { message?: string } } | null)?.error;
    if (err?.message) return err.message.slice(0, DETAIL_MAX);
  } catch {
    /* fall through to raw text */
  }
  return body.slice(0, DETAIL_MAX);
}

/** Cheapest model for a provider — probing should cost as little as possible. */
function cheapestModel(config: AppConfig, provider: string): string | null {
  const candidates = config.catalog.filter((m) => m.provider === provider);
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) =>
    a.costPer1kInput + a.costPer1kOutput <= b.costPer1kInput + b.costPer1kOutput ? a : b,
  ).id;
}

async function probeOne(
  config: AppConfig,
  forwarder: ForwarderLike,
  provider: string,
): Promise<ProbeResult> {
  const model = cheapestModel(config, provider);
  if (!model) return { provider, model: null, outcome: "no_key", detail: "no catalog models" };
  if (!config.resolveApiKey(provider, model)) {
    return { provider, model, outcome: "no_key" };
  }

  const started = Date.now();
  try {
    const upstream = await Promise.race([
      forwarder.forward({
        provider,
        model,
        // One token is enough to prove auth, routing, and translation.
        body: { model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 },
        incomingHeaders: {},
        stream: false,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out after ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS),
      ),
    ]);

    const outcome = classify(upstream.status);
    return {
      provider,
      model,
      outcome,
      status: upstream.status,
      latencyMs: Date.now() - started,
      detail: outcome === "ok" ? undefined : extractDetail(upstream.body),
    };
  } catch (err) {
    return {
      provider,
      model,
      outcome: "unreachable",
      latencyMs: Date.now() - started,
      detail: (err as Error).message.slice(0, DETAIL_MAX),
    };
  }
}

export interface ProbeOptions {
  /** Probe a single provider instead of all of them. */
  provider?: string;
  /** Ignore the cache and call upstream again. */
  force?: boolean;
}

export async function probeProviders(
  config: AppConfig,
  forwarder: ForwarderLike,
  opts: ProbeOptions = {},
): Promise<{ results: ProbeResult[]; summary: Record<ProbeOutcome, number> }> {
  const names = opts.provider
    ? [opts.provider].filter((p) => p in config.server.providers)
    : Object.keys(config.server.providers);

  const now = Date.now();
  const results = await Promise.all(
    names.map(async (provider) => {
      const hit = cache.get(provider);
      if (!opts.force && hit && now - hit.at < CACHE_TTL_MS) return hit.result;
      const result = await probeOne(config, forwarder, provider);
      cache.set(provider, { at: Date.now(), result });
      return result;
    }),
  );

  const summary = {
    ok: 0,
    no_key: 0,
    bad_key: 0,
    model_gone: 0,
    provider_error: 0,
    unreachable: 0,
  } as Record<ProbeOutcome, number>;
  for (const r of results) summary[r.outcome] += 1;

  return { results, summary };
}
