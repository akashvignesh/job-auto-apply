/**
 * LLM provider capability flags.
 *
 * The agent loop should branch on these instead of provider names. This keeps
 * the loop transport-agnostic: when a new provider is added, the loop only
 * needs to consult capabilities, not hard-code "is this DeepSeek?".
 *
 * The canonical request/response format is Anthropic-shaped (see types.ts).
 * Adapters convert at the API boundary; non-Anthropic adapters silently
 * ignore Anthropic-specific hints like `cache_control` on text blocks.
 */

export type PromptCacheKind =
  | "anthropic"   // cache_control: {type: 'ephemeral'} on text blocks; 5-min TTL
  | "openai"     // implicit caching on identical prefixes
  | "gemini"     // explicit cachedContent resource
  | "none";

export type ImageSupport =
  | "native"   // provider accepts image content blocks directly
  | "placeholder" // adapter strips images, replaces with a text placeholder
  | "none";

export interface Capabilities {
  /** Provider id — purely informational; logic should branch on the flags below. */
  name: string;

  /** Supports structured function/tool calls (i.e. `tools` parameter in request). */
  toolCalling: boolean;

  /** Tool calls are emitted incrementally during streaming (vs. only at finalize). */
  streamingToolCalls: boolean;

  /** Multiple tool_use blocks may appear in a single assistant message. */
  parallelToolCalls: boolean;

  /** Whether the provider can process images / screenshots inline. */
  vision: ImageSupport;

  /** Whether tool input_schema must conform strictly to JSON Schema. */
  strictJsonSchema: boolean;

  /** Whether the provider supports prompt caching, and what API to use. */
  promptCacheType: PromptCacheKind;

  /** Whether the provider exposes a Claude-style computer-use tool natively. */
  computerUse: boolean;

  /** Whether usage tokens (input/output) are reported in responses. */
  reportsUsage: boolean;

  /** Whether streaming text events are produced (for onText callbacks). */
  streamingText: boolean;
}

/** Default capabilities used as a starting point when authoring a new adapter. */
export const DEFAULT_CAPABILITIES: Capabilities = {
  name: "unknown",
  toolCalling: false,
  streamingToolCalls: false,
  parallelToolCalls: false,
  vision: "none",
  strictJsonSchema: false,
  promptCacheType: "none",
  computerUse: false,
  reportsUsage: false,
  streamingText: false,
};
