/**
 * Amazon Bedrock provider (Claude and Kimi K2.5 via AWS).
 *
 * Auth: Bedrock API keys (bearer token) — the user generates an API key in the Bedrock
 * console and we send it as `Authorization: Bearer <key>`.
 *
 * Endpoint: `https://bedrock-runtime.{region}.amazonaws.com/model/{modelId}/invoke`.
 * The model ID lives in the URL (not the request body).
 *
 * Two body formats, chosen by model ID:
 *   - Claude (anthropic.* / claude): Anthropic Messages shape with
 *     `anthropic_version: "bedrock-2023-05-31"`.
 *   - Kimi / Moonshot (moonshotai.kimi-*): OpenAI Chat Completions shape. Kimi K2.5 is
 *     multimodal, so screenshots are sent as `image_url` (base64 data URI). Per AWS, vision
 *     works through InvokeModel (the Converse API rejects images), which is the path we use.
 *
 * Streaming: NOT implemented for either family. Bedrock streams use AWS Event Stream binary
 * framing rather than SSE; the provider downgrades streaming requests to non-streaming
 * `/invoke` and returns the full response (no progressive UI text).
 */

import { BaseProvider } from './base-provider.js';

export class BedrockProvider extends BaseProvider {
  getName() {
    return 'bedrock';
  }

  static matchesUrl(baseUrl) {
    return baseUrl.includes('bedrock-runtime') && baseUrl.includes('amazonaws.com');
  }

  /** Kimi / Moonshot models use the OpenAI request/response shape, not Anthropic's. */
  _isMoonshot() {
    const m = (this.config.model || '').toLowerCase();
    return m.includes('moonshot') || m.includes('kimi');
  }

  /** Used by the system-prompt builder — Kimi is not a Claude model. */
  isClaudeModel() {
    return !this._isMoonshot();
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

  buildRequestBody(messages, systemPrompt, tools, useStreaming) {
    if (this._isMoonshot()) return this._buildMoonshotBody(messages, systemPrompt, tools);
    return this._buildClaudeBody(messages, systemPrompt, tools, useStreaming);
  }

  // --- Claude on Bedrock (Anthropic Messages shape) ---

  _buildClaudeBody(messages, systemPrompt, tools, _useStreaming) {
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

  // --- Kimi K2.5 on Bedrock (OpenAI Chat Completions shape, vision-capable) ---

  _imageDataUri(source) {
    return `data:${source.media_type || 'image/jpeg'};base64,${source.data}`;
  }

  /**
   * Convert Anthropic system prompt + messages into OpenAI chat messages.
   * Kimi K2.5 is multimodal, so images are sent as image_url. OpenAI `tool` messages can't
   * carry images, so an image-bearing tool_result becomes a `tool` text message PLUS a
   * follow-up `user` message holding the image_url.
   */
  _toOpenAIMessages(messages, systemPrompt) {
    const out = [];

    const systemBlocks = typeof systemPrompt === 'string'
      ? (systemPrompt ? [{ type: 'text', text: systemPrompt }] : [])
      : (systemPrompt || []);
    const systemText = systemBlocks.map((b) => b.text).join('\n\n');
    if (systemText) out.push({ role: 'system', content: systemText });

    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        out.push({ role: msg.role, content: msg.content });
        continue;
      }

      if (msg.role === 'assistant') {
        const textParts = [];
        const toolCalls = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
            });
          }
        }
        const assistantMsg = { role: 'assistant', content: textParts.join('') || null };
        if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
        out.push(assistantMsg);
        continue;
      }

      // role === 'user': text, images, and/or tool_result blocks
      const userParts = [];
      const trailingImageMessages = [];

      for (const block of msg.content) {
        if (block.type === 'text') {
          userParts.push({ type: 'text', text: block.text });
        } else if (block.type === 'image') {
          userParts.push({ type: 'image_url', image_url: { url: this._imageDataUri(block.source) } });
        } else if (block.type === 'tool_result') {
          const textChunks = [];
          const imageBlocks = [];
          if (typeof block.content === 'string') {
            textChunks.push(block.content);
          } else if (Array.isArray(block.content)) {
            for (const c of block.content) {
              if (c.type === 'text') textChunks.push(c.text);
              else if (c.type === 'image') imageBlocks.push(c);
            }
          }
          out.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: textChunks.join('\n') || '(no text output)',
          });
          if (imageBlocks.length > 0) {
            trailingImageMessages.push({
              role: 'user',
              content: [
                ...imageBlocks.map((im) => ({ type: 'image_url', image_url: { url: this._imageDataUri(im.source) } })),
                { type: 'text', text: '(screenshot from the previous tool call)' },
              ],
            });
          }
        }
      }

      if (userParts.length > 0) out.push({ role: 'user', content: userParts });
      for (const m of trailingImageMessages) out.push(m);
    }

    return out;
  }

  _toOpenAITools(tools) {
    if (!tools || tools.length === 0) return undefined;
    return tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }

  _buildMoonshotBody(messages, systemPrompt, tools) {
    const convertedTools = this._toOpenAITools(tools);
    const body = {
      // No `model` field — Bedrock takes it from the URL path.
      max_tokens: this.config.maxTokens || 8192,
      messages: this._toOpenAIMessages(messages, systemPrompt),
    };
    if (convertedTools) body.tools = convertedTools;
    return body;
  }

  // --- Response normalization ---

  normalizeResponse(response) {
    if (this._isMoonshot()) return this._normalizeMoonshotResponse(response);
    // Claude on Bedrock returns the standard Anthropic Messages response shape — no rewrite.
    return response;
  }

  _normalizeMoonshotResponse(response) {
    const choice = response.choices?.[0] || {};
    const message = choice.message || {};
    const content = [];
    if (message.content) content.push({ type: 'text', text: message.content });
    const toolCalls = message.tool_calls || [];
    for (const tc of toolCalls) {
      let input = {};
      if (tc.function?.arguments) {
        try { input = JSON.parse(tc.function.arguments); } catch (_e) { input = {}; }
      }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
    }
    if (content.length === 0) content.push({ type: 'text', text: '' });

    let stopReason = 'end_turn';
    if (toolCalls.length > 0) stopReason = 'tool_use';
    else if (choice.finish_reason === 'length') stopReason = 'max_tokens';

    const usage = response.usage
      ? { input_tokens: response.usage.prompt_tokens || 0, output_tokens: response.usage.completion_tokens || 0 }
      : null;

    return { content, stop_reason: stopReason, usage };
  }

  async handleStreaming(response, _onTextChunk, _log) {
    // Streaming path not supported on Bedrock. Treat the response as a complete (non-streamed)
    // JSON body and normalize it (Anthropic for Claude, OpenAI→Anthropic for Kimi).
    const text = await response.text();
    try {
      return this.normalizeResponse(JSON.parse(text));
    } catch (_e) {
      throw new Error(`Bedrock returned non-JSON response: ${text.slice(0, 300)}`);
    }
  }
}
