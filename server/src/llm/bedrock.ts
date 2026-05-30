/**
 * AWS Bedrock Provider — Bearer Token Auth
 *
 * Set BEDROCK_API_KEY to a "bedrock-api-key-{base64}" token (12hr temporary token).
 * Region is auto-extracted from the token. Model defaults to Nova Pro.
 *
 * Usage:
 *   BEDROCK_API_KEY="bedrock-api-key-..." node dist/local-runner/cli.js --task ...
 *   BEDROCK_MODEL=amazon.nova-lite-v1:0  # optional override
 */

import type {
  CallLLMParams,
  LLMResponse,
  ContentBlock,
  ContentBlockText,
  ContentBlockToolUse,
  Message,
  Tool,
} from "./client.js";
import type { Capabilities } from "./capabilities.js";

/**
 * Phase 7.6 — Bedrock capability flags. Nova Pro accepts images natively but
 * the adapter currently strips them via IMAGE_PLACEHOLDER (text-only path).
 * If the model is swapped to a vision-native one, flip `vision` to "native"
 * and stop stripping in convertToBedrock().
 */
export const BEDROCK_CAPABILITIES: Capabilities = {
  name: "bedrock",
  toolCalling: true,
  streamingToolCalls: false,
  parallelToolCalls: true,
  vision: "placeholder",
  strictJsonSchema: true,
  promptCacheType: "none",
  computerUse: false,
  reportsUsage: true,
  streamingText: false,
};

const DEFAULT_MODEL = "amazon.nova-pro-v1:0";
const DEFAULT_MAX_TOKENS = 4096;
const IMAGE_PLACEHOLDER = "[screenshot omitted]";

export function isBedrockConfigured(): boolean {
  return !!process.env.BEDROCK_API_KEY;
}

// ─── Extract region from bedrock-api-key-{base64} ────────────────────────────

function extractRegion(apiKey: string): string {
  try {
    const b64 = apiKey.replace(/^bedrock-api-key-/, "");
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    const url = new URL(decoded.startsWith("http") ? decoded : `https://${decoded}`);
    const cred = url.searchParams.get("X-Amz-Credential") || "";
    // AKID/YYYYMMDD/{region}/bedrock/aws4_request
    const m = cred.match(/\/\d{8}\/([^/]+)\/bedrock\//);
    return m ? m[1] : "us-east-1";
  } catch {
    return process.env.AWS_REGION || "us-east-1";
  }
}

// ─── Format conversion: Anthropic → Bedrock Converse ─────────────────────────

function buildRequestBody(
  system: ContentBlockText[],
  messages: Message[],
  tools: Tool[],
  maxTokens: number
): Record<string, any> {
  const systemText = system.map((s) => s.text).join("\n\n");

  const bedrockMessages = convertMessages(messages);

  const body: Record<string, any> = {
    messages: bedrockMessages,
    inferenceConfig: { maxTokens },
  };

  if (systemText) body.system = [{ text: systemText }];

  if (tools && tools.length > 0) {
    body.toolConfig = {
      tools: tools.map((t) => ({
        toolSpec: {
          name: t.name,
          description: t.description,
          inputSchema: { json: t.input_schema },
        },
      })),
    };
  }

  return body;
}

function convertMessages(messages: Message[]): any[] {
  const out: any[] = [];

  for (const msg of messages) {
    const content: any[] = [];

    if (typeof msg.content === "string") {
      content.push({ text: msg.content });
      out.push({ role: msg.role, content });
      continue;
    }

    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "text") {
          const t = (block as ContentBlockText).text;
          if (t) content.push({ text: t });
        } else if (block.type === "tool_use") {
          const tu = block as ContentBlockToolUse;
          content.push({ toolUse: { toolUseId: tu.id, name: tu.name, input: tu.input ?? {} } });
        }
      }
      if (content.length > 0) out.push({ role: "assistant", content });
      continue;
    }

    // role === "user"
    const textChunks: string[] = [];
    const toolResults: any[] = [];

    for (const block of msg.content) {
      if (block.type === "text") {
        textChunks.push((block as ContentBlockText).text);
      } else if (block.type === "image") {
        textChunks.push(IMAGE_PLACEHOLDER);
      } else if (block.type === "tool_result") {
        const tr = block as any;
        const parts: any[] = [];
        if (typeof tr.content === "string") {
          parts.push({ text: tr.content || "(empty)" });
        } else if (Array.isArray(tr.content)) {
          for (const c of tr.content) {
            if (c.type === "text") parts.push({ text: c.text || "(empty)" });
            else if (c.type === "image") parts.push({ text: IMAGE_PLACEHOLDER });
          }
        }
        if (parts.length === 0) parts.push({ text: "(no output)" });
        toolResults.push({ toolResult: { toolUseId: tr.tool_use_id, content: parts } });
      }
    }

    if (textChunks.length > 0) content.push({ text: textChunks.join("\n") });
    content.push(...toolResults);
    if (content.length > 0) out.push({ role: "user", content });
  }

  return out;
}

// ─── Main call ────────────────────────────────────────────────────────────────

export async function callBedrockLLM(params: CallLLMParams): Promise<LLMResponse> {
  const apiKey = process.env.BEDROCK_API_KEY;
  if (!apiKey) throw new Error("BEDROCK_API_KEY not set.");

  const {
    messages,
    system,
    tools,
    model = process.env.BEDROCK_MODEL || DEFAULT_MODEL,
    maxTokens = DEFAULT_MAX_TOKENS,
    signal,
    onText,
  } = params;

  const region = extractRegion(apiKey);
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`;

  const body = buildRequestBody(system, messages, tools, maxTokens);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  } as any);

  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(`Bedrock ${response.status}: ${err.slice(0, 300)}`);
  }

  const data = await response.json() as any;

  // Parse Converse API response → Anthropic ContentBlock[]
  const content: ContentBlock[] = [];
  const output = data.output?.message?.content ?? [];

  for (const block of output) {
    if (block.text) {
      content.push({ type: "text", text: block.text });
      onText?.(block.text);
    } else if (block.toolUse) {
      content.push({
        type: "tool_use",
        id: block.toolUse.toolUseId,
        name: block.toolUse.name,
        input: block.toolUse.input ?? {},
      });
    }
  }

  if (content.length === 0) content.push({ type: "text", text: "" });

  const stopReason = data.stopReason === "tool_use" ? "tool_use"
    : data.stopReason === "max_tokens" ? "max_tokens"
    : "end_turn";

  return {
    content,
    stop_reason: stopReason,
    usage: {
      input_tokens: data.usage?.inputTokens ?? 0,
      output_tokens: data.usage?.outputTokens ?? 0,
    },
    model,
  };
}
