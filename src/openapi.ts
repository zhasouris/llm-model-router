/**
 * OpenAPI 3.1 spec for the Swagger UI at /docs.
 *
 * The value of documenting a proxy is the X-Router-* control headers — this
 * spec surfaces them so /docs is directly usable for testing (ADR 0002).
 */

export const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "corgi-ai-gateway",
    version: "0.1.0",
    description:
      "OpenAI-compatible routing proxy. Routing is on by default; steer it with " +
      "X-Router-* headers. See docs/decisions for design rationale.",
  },
  servers: [{ url: "/" }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description:
          "OAuth 2.0 client-credentials access token (JWT). Obtain it from your identity " +
          "provider's token endpoint with your client_id/client_secret, then send it as " +
          "`Authorization: Bearer <jwt>`. The gateway validates issuer, audience, signature, " +
          "expiry, and (if configured) a required scope (ADR 0015).",
      },
    },
    schemas: {
      ChatCompletionRequest: {
        type: "object",
        required: ["messages"],
        properties: {
          model: {
            type: "string",
            description: "Ignored when routing (default). Use 'auto' as a placeholder.",
            example: "auto",
          },
          messages: {
            type: "array",
            items: {
              type: "object",
              properties: {
                role: { type: "string", example: "user" },
                content: { type: "string", example: "Write a haiku about routers" },
              },
            },
          },
          stream: { type: "boolean", default: false },
          temperature: { type: "number", example: 0.7 },
        },
      },
      Error: {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: {
              message: { type: "string" },
              type: { type: "string" },
            },
          },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/v1/chat/completions": {
      post: {
        summary: "Route a chat completion to the best model",
        parameters: [
          {
            name: "X-Router-Strategy",
            in: "header",
            required: false,
            schema: { type: "string", enum: ["best", "value", "fast"] },
            description:
              "Objective within the capability frontier (ADR 0017): best = strongest model; " +
              "value (default) = cheapest in the frontier; fast = fastest in it. Unknown values " +
              "fail soft to the default.",
          },
          {
            name: "X-Router-Bypass",
            in: "header",
            required: false,
            schema: { type: "string", enum: ["true", "false"] },
            description: "When true, skip routing and use the body's model verbatim.",
          },
          {
            name: "X-Router-Max-Cost",
            in: "header",
            required: false,
            schema: { type: "number" },
            description: "Ceiling on blended per-1k cost.",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/ChatCompletionRequest" } },
          },
        },
        responses: {
          "200": {
            description: "Upstream completion (streamed if stream=true)",
            headers: {
              "X-Router-Model": { schema: { type: "string" }, description: "Model chosen" },
              "X-Router-Reason": { schema: { type: "string" }, description: "Why it was chosen" },
              "X-Router-Duration-Ms": {
                schema: { type: "integer" },
                description: "Time spent routing (excludes the upstream call)",
              },
              "X-Router-Warning": { schema: { type: "string" }, description: "Soft warnings" },
            },
          },
          "400": {
            description: "No eligible model / invalid request",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "401": { description: "Missing/invalid proxy API key" },
        },
      },
    },
    "/v1/models": {
      get: {
        summary: "List catalog models (OpenAI-shaped)",
        responses: { "200": { description: "Model list" }, "401": { description: "Unauthorized" } },
      },
    },
    "/v1/router/models": {
      get: {
        summary: "Catalog models with routability (which ones this deployment holds a key for)",
        description:
          "The router scores on capability and price and has no notion of credentials, so it can " +
          "rank a model whose provider is unkeyed — the failure would only surface as a 401 from " +
          "the provider at forward time. `available` is true when a key resolves for the model " +
          "(its own `api_key_env`, else the provider default). Unauthenticated while the demo " +
          "inspector is enabled, behind bearer auth otherwise.",
        responses: {
          "200": {
            description: "Model list with availability and a per-provider summary",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    object: { type: "string" },
                    data: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          provider: { type: "string" },
                          tier: { type: "integer" },
                          capabilities: { type: "array", items: { type: "string" } },
                          available: { type: "boolean" },
                        },
                      },
                    },
                    summary: {
                      type: "object",
                      properties: {
                        total: { type: "integer" },
                        available: { type: "integer" },
                        providers: { type: "object", additionalProperties: { type: "boolean" } },
                      },
                    },
                  },
                },
              },
            },
          },
          "401": { description: "Unauthorized (only when the demo inspector is disabled)" },
        },
      },
    },
    "/v1/router/providers": {
      get: {
        summary: "Probe each provider key with a real, minimal call",
        description:
          "`/v1/router/models` reports whether a key is *present*; this reports whether it " +
          "*works*. Sends a 1-token completion to each provider's cheapest catalog model " +
          "through the normal adapter path. Outcomes distinguish `bad_key` (401/403 — fix " +
          "the credential) from `model_gone` (404 — the credential is fine and the catalog " +
          "is stale), which are indistinguishable otherwise. **Spends money**, so it is " +
          "always authenticated and results are cached for 60s. Returns 503 when a " +
          "configured provider is broken; a provider with no key is reported as `no_key` " +
          "and does not affect the status code.",
        parameters: [
          {
            name: "provider",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "Probe a single provider instead of all of them.",
          },
          {
            name: "force",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["true"] },
            description: "Bypass the 60s cache and call upstream again.",
          },
        ],
        responses: {
          "200": { description: "Every configured provider answered" },
          "401": { description: "Unauthorized" },
          "503": { description: "At least one configured provider is broken" },
        },
      },
    },
    "/v1/router/explain": {
      post: {
        summary: "Explain the routing decision for a request (anonymous; no completion)",
        description:
          "Runs the full routing pipeline — classifier signals, constraint filtering, weighted " +
          "scoring — and returns the decision and ranked candidates, but NEVER forwards the " +
          "request to a provider. Anonymous and always available (ADR 0016): no bearer token " +
          "required. The body is the same OpenAI-shaped chat request as /v1/chat/completions, " +
          "steered with the same X-Router-* headers. Costs one classifier call; spends nothing " +
          "on model completions.",
        security: [],
        parameters: [
          {
            name: "X-Router-Strategy",
            in: "header",
            required: false,
            schema: { type: "string", enum: ["best", "value", "fast"] },
            description:
              "Objective within the capability frontier (ADR 0017): best = strongest model; " +
              "value (default) = cheapest in the frontier; fast = fastest in it. Unknown values " +
              "fail soft to the default.",
          },
          {
            name: "X-Router-Bypass",
            in: "header",
            required: false,
            schema: { type: "string", enum: ["true", "false"] },
            description: "When true, report the body's model verbatim instead of routing.",
          },
          {
            name: "X-Router-Max-Cost",
            in: "header",
            required: false,
            schema: { type: "number" },
            description: "Ceiling on blended per-1k cost.",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/ChatCompletionRequest" } },
          },
        },
        responses: {
          "200": {
            description: "The routing decision and ranked candidates (no upstream call made)",
            headers: {
              "X-Router-Model": { schema: { type: "string" }, description: "Model chosen" },
              "X-Router-Reason": { schema: { type: "string" }, description: "Why it was chosen" },
              "X-Router-Duration-Ms": {
                schema: { type: "integer" },
                description: "Time spent routing",
              },
              "X-Router-Warning": { schema: { type: "string" }, description: "Soft warnings" },
            },
          },
          "400": {
            description: "Invalid JSON body",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/healthz": {
      get: {
        summary: "Liveness check",
        security: [],
        responses: { "200": { description: "OK" } },
      },
    },
  },
} as const;
