/**
 * RouteLLMProvider — win-rate mapping and graceful fallback (ADR 0006).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { RouteLLMProvider } from "../src/core/signal.js";
import { makeRequest } from "./helpers.js";

describe("RouteLLMProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps the sidecar win-rate onto complexity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ winRate: 0.9, confidence: 0.8 }))),
    );
    const p = new RouteLLMProvider("http://sidecar:8001");
    const r = await p.analyze(makeRequest({ body: { messages: [{ role: "user", content: "hi" }] } }));
    expect(r.complexity).toBeCloseTo(0.9, 6);
    expect(r.degraded).toBe(false);
  });

  it("falls back to the heuristic when the sidecar is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const p = new RouteLLMProvider("http://sidecar:8001", 8000, 50);
    const r = await p.analyze(makeRequest({ body: { messages: [{ role: "user", content: "hi" }] } }));
    // Degraded, but still a usable signal (from the heuristic backfill).
    expect(r.degraded).toBe(true);
    expect(r.taskType).toBeDefined();
    expect(r.complexity).toBeGreaterThanOrEqual(0);
    expect(r.complexity).toBeLessThanOrEqual(1);
  });
});
