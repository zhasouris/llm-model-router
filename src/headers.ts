/**
 * Router header contract (ADR 0002).
 *
 * Inbound control headers steer routing; they are stripped before forwarding
 * upstream (invariant #11). Outbound headers report the decision (invariant #12).
 */

import { isStrategy, type RouterOptions, type Strategy } from "./types.js";

export const H_STRATEGY = "x-router-strategy";
export const H_BYPASS = "x-router-bypass";
export const H_MAX_COST = "x-router-max-cost";

export const H_MODEL = "X-Router-Model";
export const H_REASON = "X-Router-Reason";
export const H_WARNING = "X-Router-Warning";
/** Time spent in the routing step only — not the upstream call. Lets a caller
 *  see the overhead the proxy adds without timing the whole request. */
export const H_DURATION = "X-Router-Duration-Ms";

export const CONTROL_HEADERS = new Set([H_STRATEGY, H_BYPASS, H_MAX_COST]);

const TRUTHY = new Set(["1", "true", "yes", "on"]);

type HeaderGet = (name: string) => string | undefined | null;

export function parseOptions(get: HeaderGet, defaultStrategy: Strategy): RouterOptions {
  const warnings: string[] = [];

  let strategy = defaultStrategy;
  const rawStrategy = get(H_STRATEGY);
  if (rawStrategy != null) {
    const v = rawStrategy.trim().toLowerCase();
    if (isStrategy(v)) {
      strategy = v;
    } else {
      warnings.push(`unknown strategy '${rawStrategy}', falling back to '${defaultStrategy}'`);
    }
  }

  const bypass = TRUTHY.has((get(H_BYPASS) ?? "").trim().toLowerCase());

  let maxCost: number | null = null;
  const rawCost = get(H_MAX_COST);
  if (rawCost != null) {
    const parsed = Number(rawCost);
    if (Number.isFinite(parsed)) maxCost = parsed;
    else warnings.push(`invalid max-cost '${rawCost}', ignoring`);
  }

  return { strategy, bypass, maxCost, warnings };
}

export function stripControlHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!CONTROL_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}
