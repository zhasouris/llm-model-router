/**
 * Provider adapters — the vendor "transformer" layer (ADR 0001).
 *
 * The router and client always speak the OpenAI chat-completions shape. An
 * adapter translates that to a provider's API and back:
 *
 *   buildRequest    OpenAI request  -> native HTTP request
 *   parseResponse   native response -> OpenAI response       (non-streaming)
 *   transformStream native SSE       -> OpenAI SSE            (streaming)
 *
 * `passthrough` is the identity adapter for OpenAI + all OpenAI-compatible
 * vendors (today's default). Native adapters (e.g. Anthropic Messages) plug in
 * per-provider via the `adapter` field in server.yaml — additive, no router
 * changes. See docs/transformers.md for what's built vs. planned.
 */

export interface UpstreamRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface BuildRequestArgs {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** OpenAI-shaped request body (model already rewritten by the router). */
  body: Record<string, unknown>;
  stream: boolean;
  /** Incoming client headers (control headers already stripped). */
  incomingHeaders: Record<string, string>;
}

export interface ProviderAdapter {
  readonly name: string;
  buildRequest(args: BuildRequestArgs): UpstreamRequest;
  /** Translate a non-streaming native response to the OpenAI shape. */
  parseResponse(status: number, bodyText: string): string;
  /** Translate a native SSE stream to an OpenAI SSE stream. */
  transformStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>;
}
