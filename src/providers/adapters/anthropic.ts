/**
 * Anthropic native adapter (Messages API) — the reference native transformer
 * (ADR 0001). Translates OpenAI chat-completions <-> Anthropic /v1/messages:
 * system-prompt hoisting, message/content mapping (incl. images + tools), and
 * SSE stream translation. Verified via fixtures (no live Anthropic key here).
 */

import type { BuildRequestArgs, ProviderAdapter, UpstreamRequest } from "../adapter.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: Any) => p && p.type === "text" && typeof p.text === "string")
      .map((p: Any) => p.text)
      .join("");
  }
  return "";
}

function translateContent(content: unknown): Any {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const blocks: Any[] = [];
  for (const part of content as Any[]) {
    if (part?.type === "text") {
      blocks.push({ type: "text", text: part.text });
    } else if (part?.type === "image_url") {
      const url: string = part.image_url?.url ?? "";
      const m = /^data:(.+?);base64,(.*)$/.exec(url);
      if (m) {
        blocks.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
      } else {
        blocks.push({ type: "image", source: { type: "url", url } });
      }
    }
  }
  return blocks;
}

function safeParse(s: unknown): Any {
  if (typeof s !== "string") return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function translateMessages(openaiMessages: Any[]): { system?: string; messages: Any[] } {
  const systemParts: string[] = [];
  const messages: Any[] = [];

  for (const m of openaiMessages ?? []) {
    if (m.role === "system") {
      systemParts.push(textOf(m.content));
      continue;
    }
    if (m.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: m.tool_call_id,
        content: textOf(m.content) || String(m.content ?? ""),
      };
      const last = messages[messages.length - 1];
      if (last && last.role === "user" && last.__toolResult) {
        last.content.push(block);
      } else {
        messages.push({ role: "user", content: [block], __toolResult: true });
      }
      continue;
    }
    if (m.role === "assistant") {
      const blocks: Any[] = [];
      const t = textOf(m.content);
      if (t) blocks.push({ type: "text", text: t });
      for (const tc of m.tool_calls ?? []) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function?.name,
          input: safeParse(tc.function?.arguments),
        });
      }
      messages.push({ role: "assistant", content: blocks.length ? blocks : t });
      continue;
    }
    // user (default)
    messages.push({ role: "user", content: translateContent(m.content) });
  }

  for (const m of messages) delete m.__toolResult;
  return { system: systemParts.join("\n\n") || undefined, messages };
}

function toAnthropicRequest(body: Any, stream: boolean): Any {
  const { system, messages } = translateMessages(body.messages ?? []);
  const req: Any = {
    model: body.model,
    messages,
    max_tokens: num(body.max_tokens) ?? num(body.max_completion_tokens) ?? 4096,
    stream,
  };
  if (system) req.system = system;
  if (num(body.temperature) !== undefined) req.temperature = body.temperature;
  if (num(body.top_p) !== undefined) req.top_p = body.top_p;
  if (body.stop) req.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (Array.isArray(body.tools)) {
    req.tools = body.tools
      .filter((t: Any) => t?.type === "function" && t.function)
      .map((t: Any) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters ?? { type: "object" },
      }));
  }
  return req;
}

const STOP_REASON: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
};

function toOpenAIResponse(msg: Any, fallbackModel: string): Any {
  const textParts: string[] = [];
  const toolCalls: Any[] = [];
  for (const block of msg.content ?? []) {
    if (block.type === "text") textParts.push(block.text);
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  const message: Any = { role: "assistant", content: textParts.join("") || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: msg.id ?? "chatcmpl-anthropic",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: msg.model ?? fallbackModel,
    choices: [
      { index: 0, message, finish_reason: STOP_REASON[msg.stop_reason] ?? "stop" },
    ],
    usage: {
      prompt_tokens: msg.usage?.input_tokens ?? 0,
      completion_tokens: msg.usage?.output_tokens ?? 0,
      total_tokens: (msg.usage?.input_tokens ?? 0) + (msg.usage?.output_tokens ?? 0),
    },
  };
}

export const anthropicAdapter: ProviderAdapter = {
  name: "anthropic",

  buildRequest({ baseUrl, apiKey, body, stream }: BuildRequestArgs): UpstreamRequest {
    return {
      url: `${baseUrl.replace(/\/$/, "")}/messages`,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(toAnthropicRequest(body, stream)),
    };
  },

  parseResponse(status, bodyText) {
    let data: Any;
    try {
      data = JSON.parse(bodyText);
    } catch {
      return bodyText;
    }
    if (status >= 400 || data?.type === "error") {
      return JSON.stringify({
        error: {
          message: data?.error?.message ?? "upstream error",
          type: data?.error?.type ?? "api_error",
          code: null,
        },
      });
    }
    return JSON.stringify(toOpenAIResponse(data, ""));
  },

  transformStream(stream) {
    return anthropicSseToOpenAI(stream);
  },
};

/**
 * Translate Anthropic Messages SSE -> OpenAI chat.completion.chunk SSE. Handles
 * text deltas, tool_use (start + input_json_delta), stop reason, and [DONE].
 */
function anthropicSseToOpenAI(
  source: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let id = "chatcmpl-anthropic";
  let model = "";
  const toolIndexByBlock = new Map<number, number>();
  let toolCounter = 0;

  const chunk = (delta: Any, finish: string | null = null): Uint8Array => {
    const payload = {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = source.getReader();

      const handle = (evt: Any) => {
        switch (evt?.type) {
          case "message_start":
            id = evt.message?.id ?? id;
            model = evt.message?.model ?? model;
            controller.enqueue(chunk({ role: "assistant" }));
            break;
          case "content_block_start":
            if (evt.content_block?.type === "tool_use") {
              const ti = toolCounter++;
              toolIndexByBlock.set(evt.index, ti);
              controller.enqueue(
                chunk({
                  tool_calls: [
                    {
                      index: ti,
                      id: evt.content_block.id,
                      type: "function",
                      function: { name: evt.content_block.name, arguments: "" },
                    },
                  ],
                }),
              );
            }
            break;
          case "content_block_delta":
            if (evt.delta?.type === "text_delta") {
              controller.enqueue(chunk({ content: evt.delta.text }));
            } else if (evt.delta?.type === "input_json_delta") {
              const ti = toolIndexByBlock.get(evt.index) ?? 0;
              controller.enqueue(
                chunk({
                  tool_calls: [{ index: ti, function: { arguments: evt.delta.partial_json } }],
                }),
              );
            }
            break;
          case "message_delta":
            if (evt.delta?.stop_reason) {
              controller.enqueue(chunk({}, STOP_REASON[evt.delta.stop_reason] ?? "stop"));
            }
            break;
          case "message_stop":
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            break;
          default:
            break; // ping, content_block_stop, etc.
        }
      };

      const pump = (): Promise<void> =>
        reader.read().then(({ done, value }) => {
          if (done) {
            controller.close();
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";
          for (const raw of events) {
            for (const line of raw.split("\n")) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const json = trimmed.slice(5).trim();
              if (!json || json === "[DONE]") continue;
              try {
                handle(JSON.parse(json));
              } catch {
                // ignore malformed event
              }
            }
          }
          return pump();
        });

      pump().catch((err) => controller.error(err));
    },
  });
}
