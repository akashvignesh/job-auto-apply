/**
 * Canonical LLM types — Anthropic-shaped content blocks.
 *
 * All Claude transports (Anthropic API, OAuth, Bedrock) use this format
 * natively, so no conversion is needed at the boundary.
 */
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
