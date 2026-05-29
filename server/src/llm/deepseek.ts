/**
 * DeepSeek V4 Provider for Server-Side LLM Client
 *
 * DeepSeek exposes an OpenAI-compatible Chat Completions API
 * (https://api.deepseek.com/chat/completions, Bearer auth). The server uses
 * Anthropic's content-block format internally, so this module converts to/from
 * the OpenAI shape at the API boundary — the same role `vertex.ts` plays for Gemini.
 *
 * Enabled by setting DEEPSEEK_API_KEY. Model defaults to `deepseek-v4-pro` and can be
 * overridden with DEEPSEEK_MODEL.
 *
 * Note on images: the hosted DeepSeek API (api.deepseek.com) is text-only — its content
 * arrays reject `image_url`. Screenshots from tool results are replaced with a text
 * placeholder, so the agent runs on the read_page DOM / accessibility-tree text.
 */

import { ProxyAgent } from "undici";
import type {
  CallLLMParams,
  LLMResponse,
  ContentBlock,
  ContentBlockText,
  ContentBlockToolUse,
  Message,
  Tool,
} from "./client.js";

const PROXY_URL =
  process.env.https_proxy ||
  process.env.HTTPS_PROXY ||
  process.env.http_proxy ||
  process.env.HTTP_PROXY;
const proxyDispatcher = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined;

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL = "deepseek-v4-pro";
const DEFAULT_MAX_TOKENS = 8192;
const MAX_RETRIES = 5;

/** DeepSeek is active only when an API key is present (explicit opt-in). */
export function isDeepSeekConfigured(): boolean {
  return !!process.env.DEEPSEEK_API_KEY;
}

// --- Format Conversion: Anthropic → OpenAI ---

// The hosted DeepSeek API (api.deepseek.com) is text-only — its content arrays accept
// only `{type:"text"}` and reject `image_url` (400 "unknown variant image_url"). Screenshots
// are therefore replaced with this placeholder; the agent runs on the read_page DOM /
// accessibility-tree text instead of vision.
const IMAGE_PLACEHOLDER = "[screenshot omitted — image input is not supported by this model]";

/**
 * Convert Anthropic-format system blocks + messages into OpenAI chat messages.
 * `cache_control` markers are dropped (DeepSeek auto-caches context server-side).
 */
function convertMessages(system: ContentBlockText[], messages: Message[]): any[] {
  const out: any[] = [];

  const systemText = system.map((s) => s.text).join("\n\n");
  if (systemText) out.push({ role: "system", content: systemText });

  const toolUseIdToName: Record<string, string> = {};

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: any[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push((block as ContentBlockText).text);
        } else if (block.type === "tool_use") {
          const tu = block as ContentBlockToolUse;
          toolUseIdToName[tu.id] = tu.name;
          toolCalls.push({
            id: tu.id,
            type: "function",
            function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
          });
        }
      }
      const assistantMsg: any = { role: "assistant", content: textParts.join("") || null };
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      out.push(assistantMsg);
      continue;
    }

    // role === "user": may hold text, images, and/or tool_result blocks
    const userTextChunks: string[] = [];

    for (const block of msg.content) {
      if (block.type === "text") {
        userTextChunks.push((block as ContentBlockText).text);
      } else if (block.type === "image") {
        userTextChunks.push(IMAGE_PLACEHOLDER);
      } else if (block.type === "tool_result") {
        const tr = block as any;
        const textChunks: string[] = [];
        let hadImage = false;
        if (typeof tr.content === "string") {
          textChunks.push(tr.content);
        } else if (Array.isArray(tr.content)) {
          for (const c of tr.content) {
            if (c.type === "text") textChunks.push(c.text);
            else if (c.type === "image") hadImage = true;
          }
        }
        if (hadImage) textChunks.push(IMAGE_PLACEHOLDER);
        out.push({
          role: "tool",
          tool_call_id: tr.tool_use_id,
          content: textChunks.join("\n") || "(no text output)",
        });
      }
    }

    // Remaining (non-tool_result) user content goes as a single text message.
    if (userTextChunks.length > 0) {
      out.push({ role: "user", content: userTextChunks.join("\n") });
    }
  }

  return out;
}

function convertTools(tools: Tool[]): any[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

// --- Streaming ---

interface ToolCallAccumulator {
  id: string;
  name: string;
  args: string;
}

/**
 * Parse an OpenAI-compatible SSE stream into an Anthropic-format LLMResponse.
 */
async function parseStream(
  response: Response,
  model: string,
  onText?: (chunk: string) => void,
  signal?: AbortSignal
): Promise<LLMResponse> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let currentText = "";
  const toolCalls: ToolCallAccumulator[] = [];
  let finishReason: string | null = null;
  let usage = { input_tokens: 0, output_tokens: 0 };

  try {
    while (true) {
      if (signal?.aborted) {
        reader.cancel();
        throw new DOMException("Aborted", "AbortError");
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;

        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }

        const choice = chunk.choices?.[0];
        if (choice) {
          const delta = choice.delta || {};
          if (delta.content) {
            currentText += delta.content;
            onText?.(delta.content);
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCalls[idx]) {
                toolCalls[idx] = { id: tc.id || `call_${idx}`, name: "", args: "" };
              }
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function?.name) toolCalls[idx].name = tc.function.name;
              if (tc.function?.arguments) toolCalls[idx].args += tc.function.arguments;
            }
          }
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }

        if (chunk.usage) {
          usage.input_tokens = chunk.usage.prompt_tokens || 0;
          usage.output_tokens = chunk.usage.completion_tokens || 0;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const content: ContentBlock[] = [];
  if (currentText) content.push({ type: "text", text: currentText });
  for (const tc of toolCalls) {
    if (!tc) continue;
    let input: Record<string, any> = {};
    if (tc.args) {
      try {
        input = JSON.parse(tc.args);
      } catch {
        input = {};
      }
    }
    content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  let stopReason = "end_turn";
  if (toolCalls.some(Boolean)) stopReason = "tool_use";
  else if (finishReason === "length") stopReason = "max_tokens";

  return { content, stop_reason: stopReason, usage, model };
}

// --- Main Call ---

/**
 * Call DeepSeek. Returns an Anthropic-format LLMResponse — a drop-in replacement
 * for the Anthropic `callLLM`, same params and response shape.
 */
export async function callDeepSeekLLM(params: CallLLMParams): Promise<LLMResponse> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DeepSeek not configured. Set DEEPSEEK_API_KEY.");
  }

  const {
    messages,
    system,
    tools,
    model = process.env.DEEPSEEK_MODEL || DEFAULT_MODEL,
    maxTokens = DEFAULT_MAX_TOKENS,
    signal,
    onText,
  } = params;

  const convertedTools = convertTools(tools);
  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    messages: convertMessages(system, messages),
    ...(convertedTools && { tools: convertedTools }),
    stream: true,
    stream_options: { include_usage: true },
    // Thinking mode (on by default for v4-pro) requires echoing reasoning_content back on
    // every subsequent turn. The agent loop here doesn't round-trip reasoning (mirrors the
    // non-thinking Claude flow), so disable it to avoid 400 "reasoning_content must be passed back".
    thinking: { type: "disabled" },
  });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const response = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body,
      signal,
      ...(proxyDispatcher && { dispatcher: proxyDispatcher }),
    } as any);

    if (response.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = response.headers.get("retry-after");
      const delay = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : Math.min(1000 * Math.pow(2, attempt), 30000) + Math.random() * 1000;
      console.error(
        `[DeepSeek] 429 rate limited, retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(delay)}ms`
      );
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`DeepSeek error ${response.status}: ${errorText.slice(0, 300)}`);
    }

    return parseStream(response, model, onText, signal);
  }

  throw new Error("DeepSeek: max retries exceeded (429 rate limit)");
}
