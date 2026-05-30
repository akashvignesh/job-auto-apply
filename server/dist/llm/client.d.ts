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
import type { Capabilities } from "./capabilities.js";
export declare const ANTHROPIC_CAPABILITIES: Capabilities;
export interface ContentBlockText {
    type: "text";
    text: string;
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
/** Return the capabilities of the provider that callLLM() will dispatch to. */
export declare function getActiveCapabilities(): Capabilities;
/** Convenience: the name of the active provider. */
export declare function getActiveProviderName(): string;
export declare function callLLM(params: CallLLMParams): Promise<LLMResponse>;
/**
 * Reset the cached credential source (e.g. after a manual credential update).
 */
export declare function resetCredentialCache(): void;
