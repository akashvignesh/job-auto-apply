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
import type { CallLLMParams, LLMResponse } from "./client.js";
import type { Capabilities } from "./capabilities.js";
/**
 * Phase 7.6 — Bedrock capability flags. Nova Pro accepts images natively but
 * the adapter currently strips them via IMAGE_PLACEHOLDER (text-only path).
 * If the model is swapped to a vision-native one, flip `vision` to "native"
 * and stop stripping in convertToBedrock().
 */
export declare const BEDROCK_CAPABILITIES: Capabilities;
export declare function isBedrockConfigured(): boolean;
export declare function callBedrockLLM(params: CallLLMParams): Promise<LLMResponse>;
