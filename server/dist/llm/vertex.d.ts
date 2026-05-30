/**
 * Vertex AI Gemini Provider for Server-Side LLM Client
 *
 * Handles:
 * - Service account JWT → OAuth token exchange
 * - Gemini API request/response format
 * - Streaming SSE parsing
 * - Anthropic ↔ Gemini format conversion (canonical internal format is Anthropic)
 *
 * The server uses Anthropic's content block format internally.
 * This module converts to/from Gemini's format at the API boundary.
 */
import type { CallLLMParams, LLMResponse } from "./client.js";
import type { Capabilities } from "./capabilities.js";
/** Phase 7.6 — Vertex AI (Gemini) capability flags. */
export declare const VERTEX_CAPABILITIES: Capabilities;
/**
 * Initialize Vertex AI with a service account JSON file path or object.
 */
export declare function initVertex(serviceAccountPathOrJson: string | object, region?: string): void;
/**
 * Check if Vertex AI is configured.
 */
export declare function isVertexConfigured(): boolean;
export declare function callVertexLLM(params: CallLLMParams): Promise<LLMResponse>;
