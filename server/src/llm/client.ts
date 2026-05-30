/**
 * LLM Client — Claude Code CLI mode
 *
 * Uses the official @anthropic-ai/sdk instead of raw fetch.
 * Credentials are resolved from:
 *   1. ANTHROPIC_API_KEY env var  → direct API key
 *   2. ~/.claude/.credentials.json → Claude Code OAuth (reuses `claude login` session)
 *   3. macOS Keychain               → Claude Code OAuth
 *
 * Vertex AI (Gemini) is kept as an optional override: set VERTEX_SERVICE_ACCOUNT_JSON
 * env var to re-enable it. DeepSeek V4 is available as an override too: set
 * DEEPSEEK_API_KEY (and optionally DEEPSEEK_MODEL, default `deepseek-v4-pro`).
 * Otherwise the project runs entirely on Claude.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  resolveCredentials,
  refreshClaudeToken,
  saveClaudeCredentials,
  type CredentialSource,
} from "./credentials.js";
import { callVertexLLM, isVertexConfigured, VERTEX_CAPABILITIES } from "./vertex.js";
import { callDeepSeekLLM, isDeepSeekConfigured, DEEPSEEK_CAPABILITIES } from "./deepseek.js";
import { callBedrockLLM, isBedrockConfigured, BEDROCK_CAPABILITIES } from "./bedrock.js";
import type { Capabilities } from "./capabilities.js";

// Phase 7.6 — Anthropic transport capabilities. The Anthropic SDK call below
// IS the Anthropic adapter for now; when a second Anthropic-compatible transport
// is added this declaration moves into providers/anthropic.ts.
export const ANTHROPIC_CAPABILITIES: Capabilities = {
  name: "anthropic",
  toolCalling: true,
  streamingToolCalls: true,
  parallelToolCalls: true,
  vision: "native",
  strictJsonSchema: false,
  promptCacheType: "anthropic",
  computerUse: true,
  reportsUsage: true,
  streamingText: true,
};

// ─── Re-exported types (unchanged — loop.ts depends on these) ───────────────

export interface ContentBlockText {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface ContentBlockImage {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export interface ContentBlockToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface ContentBlockToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<ContentBlockText | ContentBlockImage>;
}

export type ContentBlock =
  | ContentBlockText
  | ContentBlockImage
  | ContentBlockToolUse
  | ContentBlockToolResult;

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}

export interface LLMResponse {
  content: ContentBlock[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
  model?: string;
  /** Kept for Vertex AI compatibility — unused in Claude mode */
  _rawGeminiParts?: any[];
}

export interface CallLLMParams {
  messages: Message[];
  system: ContentBlockText[];
  tools: Tool[];
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  onText?: (chunk: string) => void;
}

// ─── Config ─────────────────────────────────────────────────────────────────

/** Default model — Claude Haiku 4.5 is fast and cheap; swap to sonnet/opus as needed */
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_MAX_TOKENS = 4096;

let cachedSource: CredentialSource | null = null;

function getSource(): CredentialSource {
  if (!cachedSource) cachedSource = resolveCredentials();
  if (!cachedSource) {
    throw new Error(
      "No credentials found. Set ANTHROPIC_API_KEY or run `claude login`"
    );
  }
  return cachedSource;
}

/**
 * Build an Anthropic SDK client from a resolved credential source.
 * OAuth tokens are passed as Bearer auth; API keys use the standard header.
 */
function buildClient(source: CredentialSource): Anthropic {
  if (source.type === "api_key") {
    return new Anthropic({ apiKey: source.apiKey });
  }

  if (source.type === "claude_oauth") {
    // Use Claude Code's OAuth access token.
    // The extra headers match what the Claude Code CLI sends to Anthropic.
    return new Anthropic({
      authToken: source.credentials.accessToken,
      defaultHeaders: {
        "anthropic-dangerous-direct-browser-access": "true",
        "anthropic-beta":
          "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
        "x-app": "cli",
        "user-agent": "claude-code/2.1.29",
      },
    });
  }

  throw new Error(
    "Codex credentials are not supported in Claude Code CLI mode. " +
      "Set ANTHROPIC_API_KEY or run `claude login` instead."
  );
}

// ─── Main call ───────────────────────────────────────────────────────────────

/**
 * Call the LLM using the Anthropic SDK.
 *
 * Routes to Vertex AI (Gemini) if VERTEX_SERVICE_ACCOUNT_JSON is set, then to
 * DeepSeek if DEEPSEEK_API_KEY is set. Otherwise uses Claude via SDK + Claude Code credentials.
 */
/**
 * Phase 7.6 — provider registry. Ordered by precedence: the first configured
 * provider wins. Keeping this as a single list rather than scattered `if`
 * blocks makes adding a new provider a one-line change and lets callers
 * query the active provider's capabilities via getActiveCapabilities().
 *
 * Anthropic is the default and has no isConfigured gate — when no other
 * provider is set, it falls through to the SDK call below.
 */
interface RegistryEntry {
  isConfigured: () => boolean;
  call: (p: CallLLMParams) => Promise<LLMResponse>;
  capabilities: Capabilities;
}

const PROVIDER_REGISTRY: RegistryEntry[] = [
  { isConfigured: isVertexConfigured,   call: callVertexLLM,   capabilities: VERTEX_CAPABILITIES },
  { isConfigured: isDeepSeekConfigured, call: callDeepSeekLLM, capabilities: DEEPSEEK_CAPABILITIES },
  { isConfigured: isBedrockConfigured,  call: callBedrockLLM,  capabilities: BEDROCK_CAPABILITIES },
];

/** Return the capabilities of the provider that callLLM() will dispatch to. */
export function getActiveCapabilities(): Capabilities {
  for (const p of PROVIDER_REGISTRY) {
    if (p.isConfigured()) return p.capabilities;
  }
  return ANTHROPIC_CAPABILITIES;
}

/** Convenience: the name of the active provider. */
export function getActiveProviderName(): string {
  return getActiveCapabilities().name;
}

export async function callLLM(params: CallLLMParams): Promise<LLMResponse> {
  // Phase 7.6 — dispatch via the provider registry. First configured wins.
  for (const p of PROVIDER_REGISTRY) {
    if (p.isConfigured()) return p.call(params);
  }

  const {
    messages,
    system,
    tools,
    model = DEFAULT_MODEL,
    maxTokens = DEFAULT_MAX_TOKENS,
    signal,
    onText,
  } = params;

  let source = getSource();

  // Pass system blocks as array to preserve cache_control markers for prompt caching
  const systemBlocks: Anthropic.TextBlockParam[] = system.map((s) => ({
    type: "text",
    text: s.text,
    ...(s.cache_control ? { cache_control: s.cache_control } : {}),
  }));

  // Our Message type is structurally identical to Anthropic.MessageParam
  const sdkMessages = messages as Anthropic.MessageParam[];

  // Map our Tool type to the SDK's Tool shape
  const sdkTools: Anthropic.Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool["input_schema"],
  }));

  // Cache all tool definitions as a unit by marking the last tool
  if (sdkTools.length > 0) {
    (sdkTools[sdkTools.length - 1] as any).cache_control = { type: "ephemeral" };
  }

  /**
   * Perform one SDK call. Extracted so we can retry after a token refresh.
   */
  async function attempt(currentSource: CredentialSource): Promise<LLMResponse> {
    const client = buildClient(currentSource);

    const stream = client.messages.stream(
      {
        model,
        max_tokens: maxTokens,
        system: systemBlocks,
        messages: sdkMessages,
        ...(sdkTools.length > 0 && { tools: sdkTools }),
      },
      { signal: signal as any }
    );

    // Stream text deltas to the caller as they arrive
    if (onText) {
      stream.on("text", onText);
    }

    const final = await stream.finalMessage();

    // Convert SDK content blocks → our internal ContentBlock format
    const content: ContentBlock[] = final.content.map((block) => {
      if (block.type === "text") {
        return { type: "text", text: block.text } satisfies ContentBlockText;
      }
      if (block.type === "tool_use") {
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input as Record<string, any>,
        } satisfies ContentBlockToolUse;
      }
      // Fallback — shouldn't happen for our use-case
      return { type: "text", text: "" } satisfies ContentBlockText;
    });

    return {
      content,
      stop_reason: final.stop_reason ?? "end_turn",
      usage: {
        input_tokens: final.usage.input_tokens,
        output_tokens: final.usage.output_tokens,
      },
      model: final.model,
    };
  }

  try {
    return await attempt(source);
  } catch (err: any) {
    // Auto-refresh Claude Code OAuth token on 401 / 403 and retry once
    const status: number | undefined = err?.status ?? err?.statusCode;
    if (
      (status === 401 || status === 403) &&
      source.type === "claude_oauth" &&
      source.credentials.refreshToken
    ) {
      console.error("[LLM] Got 401/403, refreshing Claude Code OAuth token…");
      try {
        const newCreds = await refreshClaudeToken(source.credentials.refreshToken);
        saveClaudeCredentials(newCreds);
        cachedSource = { type: "claude_oauth", credentials: newCreds };
        return await attempt(cachedSource);
      } catch (refreshErr: any) {
        throw new Error(`Token refresh failed: ${refreshErr.message}`);
      }
    }
    throw err;
  }
}

/**
 * Reset the cached credential source (e.g. after a manual credential update).
 */
export function resetCredentialCache(): void {
  cachedSource = null;
}
