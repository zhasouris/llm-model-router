/**
 * Passthrough adapter — identity translation for OpenAI and every
 * OpenAI-compatible vendor (the default). Forwards the OpenAI-shaped body
 * unchanged to `<base_url>/chat/completions`.
 */

import type { BuildRequestArgs, ProviderAdapter, UpstreamRequest } from "../adapter.js";

// Hop-by-hop / client-auth headers, plus ones undici's fetch refuses.
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

export const passthroughAdapter: ProviderAdapter = {
  name: "passthrough",

  buildRequest({ baseUrl, apiKey, body, incomingHeaders }: BuildRequestArgs): UpstreamRequest {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(incomingHeaders)) {
      if (!DROP_REQUEST_HEADERS.has(k.toLowerCase())) headers[k] = v;
    }
    headers["Authorization"] = `Bearer ${apiKey}`;
    headers["Content-Type"] = "application/json";
    return {
      url: `${baseUrl.replace(/\/$/, "")}/chat/completions`,
      headers,
      body: JSON.stringify(body),
    };
  },

  parseResponse(_status, bodyText) {
    return bodyText;
  },

  transformStream(stream) {
    return stream;
  },
};
