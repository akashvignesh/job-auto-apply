/**
 * Amazon Bedrock provider (Claude via AWS).
 *
 * Auth: Bedrock API keys (bearer token) — the simpler 2024+ path that does not require
 * SigV4 signing. The user generates an API key in the Bedrock console, pastes it into
 * Settings, and we send it as `Authorization: Bearer <key>`.
 *
 * Endpoint: `https://bedrock-runtime.{region}.amazonaws.com/model/{modelId}/invoke`.
 * The model ID lives in the URL (not the request body), and the body uses
 * `anthropic_version: "bedrock-2023-05-31"` instead of the `anthropic-version` header.
 *
 * Streaming: NOT implemented. Bedrock streams use AWS Event Stream binary framing rather
 * than SSE, and adding a binary parser would push this past the 150-line budget we agreed
 * on. The provider silently downgrades streaming requests to non-streaming — the agent
 * loop still gets the full response, just without progressive UI updates.
 */

import { BaseProvider } from './base-provider.js';

export class BedrockProvider extends BaseProvider {
  getName() {
    return 'bedrock';
  }

  static matchesUrl(baseUrl) {
    return baseUrl.includes('bedrock-runtime') && baseUrl.includes('amazonaws.com');
  }

  async getHeaders() {
    return {
      'Authorization': `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  buildUrl(_useStreaming) {
    // baseUrl is the region-specific root, e.g. https://bedrock-runtime.us-east-1.amazonaws.com
    // The model ID is path-encoded (the ":" in inference profile IDs is significant).
    const root = (this.config.apiBaseUrl || '').replace(/\/$/, '');
    const modelId = encodeURIComponent(this.config.model);
    return `${root}/model/${modelId}/invoke`;
  }

  buildRequestBody(messages, systemPrompt, tools, _useStreaming) {
    // Bedrock uses the same Anthropic Messages API shape with two differences:
    //   1. No `model` field in the body (it's in the URL).
    //   2. `anthropic_version: "bedrock-2023-05-31"` replaces the header.
    // Normalize string vs array system prompt (see AnthropicProvider for rationale).
    const systemBlocks = typeof systemPrompt === 'string'
      ? (systemPrompt ? [{ type: 'text', text: systemPrompt }] : [])
      : (systemPrompt || []);
    const cachedSystem = systemBlocks.length > 0
      ? systemBlocks.map((b, i) =>
          i === systemBlocks.length - 1
            ? { ...b, cache_control: { type: 'ephemeral' } }
            : b
        )
      : systemBlocks;

    const cachedTools = tools && tools.length > 0
      ? tools.map((t, i) =>
          i === tools.length - 1
            ? { ...t, cache_control: { type: 'ephemeral' } }
            : t
        )
      : tools;

    return {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: this.config.maxTokens || 8192,
      system: cachedSystem,
      tools: cachedTools,
      messages,
      // No `stream` field — we force non-streaming. The body is identical for /invoke
      // and /invoke-with-response-stream; the endpoint chosen by buildUrl decides format.
    };
  }

  normalizeResponse(response) {
    // Bedrock returns the standard Anthropic Messages API response shape, so no rewrite
    // is needed. The `usage` block has the same fields (input_tokens, output_tokens,
    // cache_creation_input_tokens, cache_read_input_tokens) — cost accounting in api.js
    // works unchanged.
    return response;
  }

  async handleStreaming(response, _onTextChunk, _log) {
    // Streaming path not supported on Bedrock yet. Treat the response as a complete
    // (non-streamed) JSON body and return it. This keeps the agent loop functional;
    // the only thing missing is progressive text display in the side panel.
    const text = await response.text();
    try {
      return this.normalizeResponse(JSON.parse(text));
    } catch (_e) {
      throw new Error(`Bedrock returned non-JSON response: ${text.slice(0, 300)}`);
    }
  }
}
