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
/** Default capabilities used as a starting point when authoring a new adapter. */
export const DEFAULT_CAPABILITIES = {
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
