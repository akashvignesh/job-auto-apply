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
export {};
