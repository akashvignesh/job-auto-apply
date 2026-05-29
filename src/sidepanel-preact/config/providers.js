// Claude-only build (forked from Hanzi Browse, all non-Claude providers stripped).
// Two paths to Claude:
//   1. Anthropic direct (api.anthropic.com) — OAuth or API key
//   2. Amazon Bedrock — Bedrock API key, default us-east-1 cross-region inference profile
export const LOCAL_MODELS = [];
export const CODEX_MODELS = [];

export const PROVIDERS = {
  anthropic: {
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1/messages',
    models: [
      { id: 'claude-opus-4-5-20251101', name: 'Opus 4.5' },
      { id: 'claude-sonnet-4-20250514', name: 'Sonnet 4' },
      { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5' },
    ],
  },
  bedrock: {
    name: 'Amazon Bedrock',
    // Region-specific root. The model ID (with us. prefix for cross-region inference)
    // is appended by BedrockProvider.buildUrl() at request time.
    baseUrl: 'https://bedrock-runtime.us-east-2.amazonaws.com',
    // Cross-region inference profile IDs (the "us." prefix). These auto-route across
    // US regions for availability. If a model doesn't exist in your account yet, request
    // access in the Bedrock console.
    models: [
      { id: 'us.anthropic.claude-opus-4-5-20251101-v1:0', name: 'Opus 4.5 (Bedrock)' },
      { id: 'us.anthropic.claude-sonnet-4-20250514-v1:0', name: 'Sonnet 4 (Bedrock)' },
      { id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', name: 'Haiku 4.5 (Bedrock)' },
      // Moonshot Kimi K2.5 — multimodal (text + vision). Uses the OpenAI request/response
      // shape on Bedrock (handled by BedrockProvider). Serverless, no manual enablement.
      { id: 'moonshotai.kimi-k2.5', name: 'Kimi K2.5 (Bedrock, vision)' },
    ],
  },
  deepseek: {
    name: 'DeepSeek',
    // OpenAI-compatible Chat Completions endpoint. DeepSeekProvider converts the
    // Anthropic-format messages/tools to/from the OpenAI shape at request time.
    baseUrl: 'https://api.deepseek.com/chat/completions',
    // The hosted DeepSeek API is text-only (no image input); v4-flash is faster/cheaper.
    models: [
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    ],
  },
};
