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
 * env var to re-enable it. Otherwise the project runs entirely on Claude.
 */
export interface ContentBlockText {
    type: "text";
    text: string;
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
/**
 * Call the LLM using the Anthropic SDK.
 *
 * Routes to Vertex AI (Gemini) only if VERTEX_SERVICE_ACCOUNT_JSON is set.
 * Otherwise always uses Claude via SDK + Claude Code credentials.
 */
export declare function callLLM(params: CallLLMParams): Promise<LLMResponse>;
/**
 * Reset the cached credential source (e.g. after a manual credential update).
 */
export declare function resetCredentialCache(): void;
