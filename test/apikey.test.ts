/**
 * Per-model API key resolution (ADR 0007): model key -> provider default.
 * Uses a fixture catalog where one model has its own api_key_env.
 */

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig, resetConfigCache } from "../src/config.js";
import { Forwarder } from "../src/providers/forwarder.js";

const SAVED = { ...process.env };
const FIXTURE_DIR = join(process.cwd(), "test", "fixtures", "config");

describe("resolveApiKey", () => {
  beforeEach(() => {
    process.env.ROUTER_CONFIG_DIR = FIXTURE_DIR;
    process.env.OPENAI_API_KEY = "provider-default";
    resetConfigCache();
  });
  afterEach(() => {
    process.env = { ...SAVED };
    resetConfigCache();
  });

  it("uses the model's own key when its api_key_env is set and present", () => {
    process.env.FIXTURE_MODEL_KEY = "per-model-key";
    resetConfigCache();
    expect(getConfig().resolveApiKey("openai", "fixture-with-key")).toBe("per-model-key");
  });

  it("falls back to the provider default when the per-model env is unset", () => {
    delete process.env.FIXTURE_MODEL_KEY;
    resetConfigCache();
    expect(getConfig().resolveApiKey("openai", "fixture-with-key")).toBe("provider-default");
  });

  it("uses the provider default for a model with no api_key_env", () => {
    process.env.FIXTURE_MODEL_KEY = "per-model-key";
    resetConfigCache();
    expect(getConfig().resolveApiKey("openai", "fixture-no-key")).toBe("provider-default");
  });

  it("uses the provider default when no model id is given", () => {
    expect(getConfig().resolveApiKey("openai")).toBe("provider-default");
  });

  it("forwards the per-model key in the upstream Authorization header", async () => {
    process.env.FIXTURE_MODEL_KEY = "per-model-key";
    resetConfigCache();

    let sentAuth: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sentAuth = (init.headers as Record<string, string>)["Authorization"];
        return new Response("{}", { status: 200 });
      }),
    );

    const forwarder = new Forwarder(getConfig());
    await forwarder.forward({
      provider: "openai",
      body: { model: "fixture-with-key" },
      incomingHeaders: {},
      stream: false,
      model: "fixture-with-key",
    });

    expect(sentAuth).toBe("Bearer per-model-key");
    vi.unstubAllGlobals();
  });
});
