/**
 * Canonical LLM types — Anthropic-shaped content blocks.
 *
 * All Claude transports (Anthropic API, OAuth, Bedrock) use this format
 * natively, so no conversion is needed at the boundary.
 *
 * Phase 7.6 — Provider portability contract:
 *   `cache_control` on a ContentBlockText is an OPT-IN hint to Anthropic-family
 *   transports (capabilities.promptCacheType === "anthropic"). Non-Anthropic
 *   adapters (Gemini, DeepSeek, Nova) MUST silently ignore it when converting
 *   to their wire format. Callers populate it freely and let capability flags
 *   decide whether it's honored — never branch on provider name.
 *
 *   Images: providers with capabilities.vision === "placeholder" strip
 *   ContentBlockImage entries and replace them with a text placeholder before
 *   sending. Callers can still attach images; the adapter handles fallback.
 */
export interface ContentBlockText {
    type: "text";
    text: string;
    /**
     * Anthropic-family prompt-cache hint. Other adapters ignore this — see
     * Phase 7.6 portability contract in the file header.
     */
    cache_control?: {
        type: "ephemeral";
    };
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
export type ContentBlock = ContentBlockText | ContentBlockImage | ContentBlockToolUse | ContentBlockToolResult;
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
    usage: {
        input_tokens: number;
        output_tokens: number;
    };
    model?: string;
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
