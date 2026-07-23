/**
 * Header contract — control parsing, fail-soft, stripping (invariants #11, #13).
 */

import { describe, expect, it } from "vitest";
import { CONTROL_HEADERS, parseOptions, stripControlHeaders } from "../src/headers.js";

function getter(headers: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return (name: string) => lower[name.toLowerCase()];
}

describe("header contract", () => {
  it("unknown strategy fails soft", () => {
    const opts = parseOptions(getter({ "X-Router-Strategy": "bogus" }), "value");
    expect(opts.strategy).toBe("value");
    expect(opts.warnings.some((w) => w.includes("unknown strategy"))).toBe(true);
  });

  it("known strategy parses", () => {
    const opts = parseOptions(getter({ "x-router-strategy": "value" }), "value");
    expect(opts.strategy).toBe("value");
    expect(opts.warnings).toHaveLength(0);
  });

  it("bypass truthiness", () => {
    expect(parseOptions(getter({ "X-Router-Bypass": "true" }), "value").bypass).toBe(true);
    expect(parseOptions(getter({ "X-Router-Bypass": "no" }), "value").bypass).toBe(false);
  });

  it("control headers are stripped", () => {
    const out = stripControlHeaders({
      Authorization: "Bearer x",
      "X-Router-Strategy": "value",
      "X-Router-Bypass": "true",
      "Content-Type": "application/json",
    });
    const lowerKeys = Object.keys(out).map((k) => k.toLowerCase());
    expect(lowerKeys.some((k) => CONTROL_HEADERS.has(k))).toBe(false);
    expect(out["Authorization"]).toBeDefined();
    expect(out["Content-Type"]).toBeDefined();
  });
});
