/**
 * Upstream forwarding via the global fetch (undici).
 *
 * The forward path is deliberately thin: the body is passed through unchanged
 * except for `model` (invariant #14), and streaming responses are relayed as a
 * ReadableStream without buffering (invariant #15). In v1 every provider speaks
 * the OpenAI wire format (native for OpenAI; via the OpenAI-compat endpoint for
 * Anthropic — ADR 0001).
 */

import { trace } from "@opentelemetry/api";
import type { AppConfig } from "../config.js";

const tracer = trace.getTracer("router.forwarder");

// Hop-by-hop, client-auth, and headers undici's fetch refuses (e.g. `expect`).
// A proxy should not forward any of these upstream.
const DROP_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "authorization",
  "connection",
  "accept-encoding",
  "expect",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "proxy-connection",
]);

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

  private url(provider: string): string {
    const base = this.config.server.providers[provider]!.base_url.replace(/\/$/, "");
    return `${base}/chat/completions`;
  }

  private headers(
    provider: string,
    incoming: Record<string, string>,
    modelId?: string,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(incoming)) {
      if (!DROP_REQUEST_HEADERS.has(k.toLowerCase())) out[k] = v;
    }
    // Per-model key if configured, else the provider default (ADR 0007).
    out["Authorization"] = `Bearer ${this.config.resolveApiKey(provider, modelId) ?? "missing"}`;
    out["Content-Type"] = "application/json";
    return out;
  }

  async forward(args: ForwardArgs): Promise<UpstreamResponse> {
    const { provider, body, incomingHeaders, stream, model } = args;
    const url = this.url(provider);

    return tracer.startActiveSpan("router.forward", async (span) => {
      span.setAttribute("router.provider", provider);
      span.setAttribute("router.stream", stream);
      span.setAttribute("http.url", url);

      const resp = await fetch(url, {
        method: "POST",
        headers: this.headers(provider, incomingHeaders, model),
        body: JSON.stringify(body),
      });

      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => (headers[k] = v));
      span.setAttribute("http.status_code", resp.status);

      if (stream) {
        span.end();
        return { status: resp.status, headers, stream: resp.body };
      }
      const text = await resp.text();
      span.end();
      return { status: resp.status, headers, body: text };
    });
  }
}
