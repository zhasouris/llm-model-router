/**
 * Upstream forwarding via the global fetch (undici).
 *
 * The forward path is thin: it selects the provider's adapter (ADR 0001), which
 * translates the OpenAI-shaped request to the provider's API and the response
 * back. The default `passthrough` adapter is identity (OpenAI + all
 * OpenAI-compatible vendors); native adapters (e.g. Anthropic) translate.
 * Streaming responses are relayed as a ReadableStream without buffering (#15).
 */

import { trace } from "@opentelemetry/api";
import type { AppConfig } from "../config.js";
import { recordUpstream } from "../metrics.js";
import { getAdapter } from "./adapters/index.js";

const tracer = trace.getTracer("router.forwarder");

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  /** Present for non-streaming responses. */
  body?: string;
  /** Present for streaming responses. */
  stream?: ReadableStream<Uint8Array> | null;
}

export interface ForwardArgs {
  provider: string;
  body: Record<string, unknown>;
  incomingHeaders: Record<string, string>;
  stream: boolean;
  /** Chosen model id — used to resolve a per-model API key (ADR 0007). */
  model?: string;
}

export interface ForwarderLike {
  forward(args: ForwardArgs): Promise<UpstreamResponse>;
}

export class Forwarder implements ForwarderLike {
  constructor(private readonly config: AppConfig) {}

  async forward(args: ForwardArgs): Promise<UpstreamResponse> {
    const { provider, body, incomingHeaders, stream, model } = args;
    const providerCfg = this.config.server.providers[provider]!;
    const adapter = getAdapter(providerCfg.adapter);
    const apiKey = this.config.resolveApiKey(provider, model) ?? "missing";

    const req = adapter.buildRequest({
      baseUrl: providerCfg.base_url,
      apiKey,
      model: model ?? String(body.model ?? ""),
      body,
      stream,
      incomingHeaders,
    });

    return tracer.startActiveSpan("router.forward", async (span) => {
      span.setAttribute("router.provider", provider);
      span.setAttribute("router.adapter", adapter.name);
      span.setAttribute("router.stream", stream);
      span.setAttribute("http.url", req.url);

      const started = Date.now();
      const resp = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body });
      recordUpstream({ provider, status: resp.status, durationMs: Date.now() - started });

      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => (headers[k] = v));
      span.setAttribute("http.status_code", resp.status);

      if (stream) {
        span.end();
        return {
          status: resp.status,
          headers,
          stream: resp.body ? adapter.transformStream(resp.body) : resp.body,
        };
      }
      const text = await resp.text();
      span.end();
      return { status: resp.status, headers, body: adapter.parseResponse(resp.status, text) };
    });
  }
}
