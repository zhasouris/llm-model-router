/**
 * Base-model delta report (KPIs: cost saved + targeted accuracy). Hermetic —
 * uses the real catalog/competency but the deterministic heuristic signal.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { resetConfigCache } from "../src/config.js";
import { baselineReport } from "../eval/src/baseline.js";
import type { Scenario } from "../eval/src/types.js";

const dataset: Scenario[] = [
  { id: "easy", request: { messages: [{ role: "user", content: "Say hi." }] } },
  {
    id: "hard-math",
    request: {
      messages: [
        {
          role: "user",
          content:
            "Prove the pigeonhole principle rigorously and derive each step of the argument.",
        },
      ],
    },
  },
  {
    id: "code",
    request: {
      messages: [
        { role: "user", content: "Write and debug a thread-safe LRU cache in Rust with unit tests." },
      ],
    },
  },
];

describe("baseline delta report", () => {
  beforeAll(() => {
    delete process.env.ROUTER_CONFIG_DIR;
    resetConfigCache();
  });

  it("diffs the router against a base model across best/value/fast", async () => {
    const r = await baselineReport(dataset, "gpt-4.1-mini", "test");
    expect(r.strategies.map((s) => s.strategy).sort()).toEqual(["best", "fast", "value"]);

    for (const s of r.strategies) {
      const c = s.counts;
      // every prompt is classified exactly once
      expect(c.unchanged + c.upgrade + c.downgrade + c["forced-upgrade"]).toBe(dataset.length);
      // net saved is exactly base − router
      expect(s.cost.netSaved).toBeCloseTo(s.cost.base - s.cost.router, 5);
    }
  });

  it("value never costs more than always-using a strong base", async () => {
    const r = await baselineReport(dataset, "o3", "test");
    const value = r.strategies.find((s) => s.strategy === "value")!;
    expect(value.cost.router).toBeLessThanOrEqual(value.cost.base);
  });

  it("rejects an unknown base model", async () => {
    await expect(baselineReport(dataset, "not-a-model", "test")).rejects.toThrow(/base model/);
  });
});
