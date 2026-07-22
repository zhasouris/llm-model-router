/**
 * OpenAPI 3.1 spec for the Swagger UI at /docs.
 *
 * The value of documenting a proxy is the X-Router-* control headers — this
 * spec surfaces them so /docs is directly usable for testing (ADR 0002).
 */

export const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "llm-model-router",
    version: "0.1.0",
    description:
      "OpenAI-compatible routing proxy. Routing is on by default; steer it with " +
      "X-Router-* headers. See docs/decisions for design rationale.",
  },
  servers: [{ url: "/" }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", description: "A token from ROUTER_API_KEYS" },
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
            schema: { type: "string", enum: ["cost", "quality", "latency", "balanced"] },
            description: "Optimization to favor. Unknown values fail soft to the default.",
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
    "/healthz": {
      get: {
        summary: "Liveness check",
        security: [],
        responses: { "200": { description: "OK" } },
      },
    },
  },
} as const;
