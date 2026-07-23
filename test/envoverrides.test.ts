/**
 * Deployment-time env overrides of config/server.yaml (src/config.ts).
 *
 * These exist because the YAML is baked into the container image, so a hosted
 * deployment has no way to edit it. The contract is narrow and worth pinning:
 * a set value wins, an unset or blank one leaves the file value alone.
 */

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getConfig, resetConfigCache } from "../src/config.js";

const SAVED = { ...process.env };
const FIXTURE_DIR = join(process.cwd(), "test", "fixtures", "config");

// The fixture has demo/routellm absent (schema defaults: demo on, routellm off)
// and telemetry.console_export false, azure_monitor absent (default false).
function load() {
  resetConfigCache();
  return getConfig().server;
}

describe("env overrides", () => {
  beforeEach(() => {
    process.env.ROUTER_CONFIG_DIR = FIXTURE_DIR;
    resetConfigCache();
  });
  afterEach(() => {
    process.env = { ...SAVED };
    resetConfigCache();
  });

  it("leaves the file values alone when nothing is set", () => {
    const s = load();
    expect(s.demo.enabled).toBe(true);
    expect(s.telemetry.console_export).toBe(false);
    expect(s.telemetry.azure_monitor.enabled).toBe(false);
    expect(s.routellm.enabled).toBe(false);
  });

  it("turns the inspector off — the deployment default for a public URL", () => {
    process.env.DEMO_ENABLED = "false";
    expect(load().demo.enabled).toBe(false);
  });

  it("cold-start hint is off by default and toggles via env", () => {
    expect(load().demo.cold_start_hint).toBe(false);
    process.env.DEMO_COLD_START_HINT = "true";
    expect(load().demo.cold_start_hint).toBe(true);
  });

  it("turns the Azure Monitor exporter on", () => {
    process.env.AZURE_MONITOR_ENABLED = "true";
    expect(load().telemetry.azure_monitor.enabled).toBe(true);
  });

  it("turns console span export on and off", () => {
    process.env.OTEL_CONSOLE_EXPORT = "true";
    expect(load().telemetry.console_export).toBe(true);
    process.env.OTEL_CONSOLE_EXPORT = "false";
    expect(load().telemetry.console_export).toBe(false);
  });

  it("enables RouteLLM and points it at a different sidecar", () => {
    process.env.ROUTELLM_ENABLED = "1";
    process.env.ROUTELLM_URL = "http://routellm-sidecar:8001";
    const s = load();
    expect(s.routellm.enabled).toBe(true);
    expect(s.routellm.url).toBe("http://routellm-sidecar:8001");
  });

  it.each(["1", "true", "TRUE", "yes", "on"])("treats %s as true", (v) => {
    process.env.DEMO_ENABLED = v;
    expect(load().demo.enabled).toBe(true);
  });

  it.each(["0", "false", "no", "off", "anything-else"])("treats %s as false", (v) => {
    process.env.DEMO_ENABLED = v;
    expect(load().demo.enabled).toBe(false);
  });

  // A blank value is what an unset Container Apps env var or an empty .env line
  // looks like. It must not be read as "false" and silently flip a setting.
  it("ignores a blank value rather than reading it as false", () => {
    process.env.DEMO_ENABLED = "   ";
    expect(load().demo.enabled).toBe(true);
  });
});
