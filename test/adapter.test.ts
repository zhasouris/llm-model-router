/**
 * Provider adapters / vendor transformers (ADR 0001). Fixture-based — verifies
 * OpenAI <-> native translation without any live provider calls.
 */

import { describe, expect, it } from "vitest";
import { getAdapter } from "../src/providers/adapters/index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("passthrough adapter", () => {
  const a = getAdapter("openai");

  it("forwards to /chat/completions with bearer auth and unchanged body", () => {
    const req = a.buildRequest({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-x",
      model: "gpt-4.1",
      body: { model: "gpt-4.1", messages: [{ role: "user", content: "hi" }] },
      stream: false,
      incomingHeaders: { "x-custom": "1", authorization: "should-be-dropped" },
    });
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(req.headers["Authorization"]).toBe("Bearer sk-x");
    expect(req.headers["x-custom"]).toBe("1");
    expect(JSON.parse(req.body).model).toBe("gpt-4.1");
  });

  it("is identity for responses and streams", () => {
    expect(a.parseResponse(200, '{"ok":true}')).toBe('{"ok":true}');
  });
});

describe("anthropic adapter — request", () => {
  const a = getAdapter("anthropic");

  it("hoists system, maps messages, requires max_tokens, sets native headers", () => {
    const req = a.buildRequest({
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-ant",
      model: "claude-sonnet-5",
      body: {
        model: "claude-sonnet-5",
        messages: [
          { role: "system", content: "Be terse." },
          { role: "user", content: "hi" },
        ],
        temperature: 0.5,
      },
      stream: false,
      incomingHeaders: {},
    });
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
    expect(req.headers["x-api-key"]).toBe("sk-ant");
    expect(req.headers["anthropic-version"]).toBeDefined();
    const body = JSON.parse(req.body);
    expect(body.system).toBe("Be terse.");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.temperature).toBe(0.5);
  });

  it("translates tools and a data-URI image", () => {
    const req = a.buildRequest({
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "k",
      model: "claude-sonnet-5",
      body: {
        model: "claude-sonnet-5",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            ],
          },
        ],
        tools: [
          { type: "function", function: { name: "get_weather", description: "w", parameters: { type: "object" } } },
        ],
      },
      stream: false,
      incomingHeaders: {},
    });
    const body = JSON.parse(req.body);
    expect(body.tools[0]).toEqual({ name: "get_weather", description: "w", input_schema: { type: "object" } });
    const img = body.messages[0].content.find((b: { type: string }) => b.type === "image");
    expect(img.source).toEqual({ type: "base64", media_type: "image/png", data: "AAAA" });
  });
});

describe("anthropic adapter — response", () => {
  const a = getAdapter("anthropic");

  it("maps a Messages response to OpenAI shape", () => {
    const out = JSON.parse(
      a.parseResponse(
        200,
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          content: [{ type: "text", text: "Hello there" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 3 },
        }),
      ),
    );
    expect(out.object).toBe("chat.completion");
    expect(out.choices[0].message.content).toBe("Hello there");
    expect(out.choices[0].finish_reason).toBe("stop");
    expect(out.usage).toEqual({ prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
  });

  it("maps tool_use to tool_calls with finish_reason tool_calls", () => {
    const out = JSON.parse(
      a.parseResponse(
        200,
        JSON.stringify({
          id: "msg_2",
          content: [{ type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "SF" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 5, output_tokens: 5 },
        }),
      ),
    );
    expect(out.choices[0].finish_reason).toBe("tool_calls");
    const tc = out.choices[0].message.tool_calls[0];
    expect(tc.function.name).toBe("get_weather");
    expect(JSON.parse(tc.function.arguments)).toEqual({ city: "SF" });
  });

  it("maps an error body to an OpenAI error", () => {
    const out = JSON.parse(
      a.parseResponse(401, JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad key" } })),
    );
    expect(out.error.message).toBe("bad key");
    expect(out.error.type).toBe("authentication_error");
  });
});

describe("anthropic adapter — stream", () => {
  const a = getAdapter("anthropic");

  const EVENTS = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-5"}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
  ];

  function sourceStream(): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(c) {
        for (const e of EVENTS) c.enqueue(enc.encode(e + "\n\n"));
        c.close();
      },
    });
  }

  it("translates Anthropic SSE to OpenAI chunks + [DONE]", async () => {
    const reader = a.transformStream(sourceStream()).getReader();
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value);
    }
    expect(out).toContain('"object":"chat.completion.chunk"');
    expect(out).toContain('"content":"Hello"');
    expect(out).toContain('"content":" world"');
    expect(out).toContain('"finish_reason":"stop"');
    expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });
});
