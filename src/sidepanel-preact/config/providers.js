// Pre-configured local models (shown in model picker without any API key setup)
export const LOCAL_MODELS = [
  {
    name: 'Gemma 4 E4B (Local vLLM)',
    modelId: './gemma4-e4b',
    baseUrl: 'http://192.168.1.185:8000/v1/chat/completions',
    apiKey: 'not-needed',
  },
];

// Provider configurations
export const PROVIDERS = {
  anthropic: {
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1/messages',
    models: [
      { id: 'claude-opus-4-5-20251101', name: 'Opus 4.5' },
      { id: 'claude-opus-4-20250514', name: 'Opus 4' },
      { id: 'claude-sonnet-4-20250514', name: 'Sonnet 4' },
      { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5' },
    ],
  },
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-5', name: 'GPT-5' },
      { id: 'gpt-5-mini', name: 'GPT-5 Mini' },
      { id: 'gpt-4.1', name: 'GPT-4.1' },
      { id: 'o3', name: 'o3' },
      { id: 'o4-mini', name: 'o4-mini' },
    ],
  },
  google: {
    name: 'Google (Gemini)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    // Fallback list — "Fetch available models" in Settings replaces this with live API data
    models: [
      // ── Stable text models ────────────────────────────────────────
      { id: 'gemini-2.5-flash',                          name: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-pro',                            name: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash-lite',                     name: 'Gemini 2.5 Flash Lite' },
      { id: 'gemini-2.0-flash',                          name: 'Gemini 2.0 Flash' },
      { id: 'gemini-2.0-flash-lite',                     name: 'Gemini 2.0 Flash Lite' },
      { id: 'gemini-flash-latest',                       name: 'Gemini Flash Latest' },
      { id: 'gemini-flash-lite-latest',                  name: 'Gemini Flash Lite Latest' },
      { id: 'gemini-pro-latest',                         name: 'Gemini Pro Latest' },
      // ── Gemini 3.x preview ────────────────────────────────────────
      { id: 'gemini-3.5-flash',                          name: 'Gemini 3.5 Flash' },
      { id: 'gemini-3.1-pro-preview',                    name: 'Gemini 3.1 Pro Preview' },
      { id: 'gemini-3.1-pro-preview-customtools',        name: 'Gemini 3.1 Pro Preview (Custom Tools)' },
      { id: 'gemini-3.1-flash-lite',                     name: 'Gemini 3.1 Flash Lite' },
      { id: 'gemini-3.1-flash-lite-preview',             name: 'Gemini 3.1 Flash Lite Preview' },
      { id: 'gemini-3-pro-preview',                      name: 'Gemini 3 Pro Preview' },
      { id: 'gemini-3-flash-preview',                    name: 'Gemini 3 Flash Preview' },
      // ── Multi-modal / Image ───────────────────────────────────────
      { id: 'gemini-2.5-flash-image',                    name: 'Gemini 2.5 Flash Image (Nano Banana)' },
      { id: 'gemini-3-pro-image-preview',                name: 'Gemini 3 Pro Image (Nano Banana Pro)' },
      { id: 'gemini-3.1-flash-image-preview',            name: 'Gemini 3.1 Flash Image (Nano Banana 2)' },
      // ── TTS ───────────────────────────────────────────────────────
      { id: 'gemini-2.5-flash-preview-tts',              name: 'Gemini 2.5 Flash TTS' },
      { id: 'gemini-2.5-pro-preview-tts',                name: 'Gemini 2.5 Pro TTS' },
      { id: 'gemini-3.1-flash-tts-preview',              name: 'Gemini 3.1 Flash TTS Preview' },
      // ── Audio / Music ─────────────────────────────────────────────
      { id: 'lyria-3-clip-preview',                      name: 'Lyria 3 Clip Preview' },
      { id: 'lyria-3-pro-preview',                       name: 'Lyria 3 Pro Preview' },
      // ── Gemma ─────────────────────────────────────────────────────
      { id: 'gemma-4-26b-a4b-it',                        name: 'Gemma 4 26B' },
      { id: 'gemma-4-31b-it',                            name: 'Gemma 4 31B' },
      // ── Specialized ───────────────────────────────────────────────
      { id: 'gemini-robotics-er-1.5-preview',            name: 'Gemini Robotics ER 1.5 Preview' },
      { id: 'gemini-robotics-er-1.6-preview',            name: 'Gemini Robotics ER 1.6 Preview' },
      { id: 'gemini-2.5-computer-use-preview-10-2025',   name: 'Computer Use Preview' },
      // ── Agents ───────────────────────────────────────────────────
      { id: 'antigravity-preview-05-2026',               name: 'Antigravity Agent Preview' },
      { id: 'deep-research-pro-preview-12-2025',         name: 'Deep Research Pro Preview' },
      { id: 'deep-research-preview-04-2026',             name: 'Deep Research Preview' },
      { id: 'deep-research-max-preview-04-2026',         name: 'Deep Research Max Preview' },
    ],
  },
  vertex: {
    name: 'Google Vertex AI',
    // baseUrl is built dynamically from the service account's project_id
    baseUrl: 'vertex-ai',
    models: [
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite' },
    ],
  },
  huggingface: {
    name: 'HuggingFace',
    baseUrl: 'https://api-inference.huggingface.co/v1/chat/completions',
    models: [
      // ── Gemma 4 (Google) — verified IDs from Google AI docs ──────
      { id: 'google/gemma-4-26B-A4B-it', name: 'Gemma 4 26B (A4B)' },
      { id: 'google/gemma-4-31B-it',     name: 'Gemma 4 31B' },
      { id: 'google/gemma-4-E4B-it',     name: 'Gemma 4 E4B' },
      { id: 'google/gemma-4-E2B-it',     name: 'Gemma 4 E2B' },
      // ── Llama 4 (Meta) ───────────────────────────────────────────
      { id: 'meta-llama/Llama-4-Scout-17B-16E-Instruct', name: 'Llama 4 Scout 17B' },
      { id: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct', name: 'Llama 4 Maverick 17B' },
      // ── Qwen 3 (Alibaba) ─────────────────────────────────────────
      { id: 'Qwen/Qwen3-8B',             name: 'Qwen3 8B' },
      { id: 'Qwen/Qwen3-30B-A3B',        name: 'Qwen3 30B MoE' },
      { id: 'Qwen/Qwen3-235B-A22B',      name: 'Qwen3 235B MoE' },
      // ── Mistral ──────────────────────────────────────────────────
      { id: 'mistralai/Mistral-7B-Instruct-v0.3', name: 'Mistral 7B Instruct' },
      { id: 'mistralai/Mixtral-8x7B-Instruct-v0.1', name: 'Mixtral 8x7B' },
    ],
  },
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    models: [
      { id: 'qwen/qwen3-vl-8b-instruct', name: 'Qwen3 VL 8B (Self-hostable)' },
      { id: 'qwen/qwen3-vl-32b-instruct', name: 'Qwen3 VL 32B' },
      { id: 'qwen/qwen3-vl-235b-a22b-thinking', name: 'Qwen3 VL 235B (Reasoning)' },
      { id: 'qwen/qwen3-vl-30b-a3b-instruct', name: 'Qwen3 VL 30B MoE (Self-hostable)' },
      { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
      { id: 'moonshotai/kimi-k2.5', name: 'Kimi K2.5 (Reasoning)' },
    ],
  },
};

export const CODEX_MODELS = [
  { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max' },
  { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex' },
  { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini' },
  { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' },
  { id: 'gpt-5-codex', name: 'GPT-5 Codex' },
];
