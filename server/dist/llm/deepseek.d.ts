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
import type { CallLLMParams, LLMResponse } from "./client.js";
import type { Capabilities } from "./capabilities.js";
/**
 * Phase 7.6 — DeepSeek capability flags. The hosted DeepSeek API is text-only
 * (no image_url in content arrays), so vision is `placeholder` — the adapter
 * strips image blocks and inserts a "[screenshot omitted]" text marker.
 */
export declare const DEEPSEEK_CAPABILITIES: Capabilities;
/** DeepSeek is active only when an API key is present (explicit opt-in). */
export declare function isDeepSeekConfigured(): boolean;
/**
 * Call DeepSeek. Returns an Anthropic-format LLMResponse — a drop-in replacement
 * for the Anthropic `callLLM`, same params and response shape.
 */
export declare function callDeepSeekLLM(params: CallLLMParams): Promise<LLMResponse>;
