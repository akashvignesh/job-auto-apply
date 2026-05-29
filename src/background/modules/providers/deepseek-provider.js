/**
 * DeepSeek V4 provider (OpenAI-compatible Chat Completions API).
 *
 * Endpoint: https://api.deepseek.com/chat/completions, auth `Authorization: Bearer <key>`.
 *
 * The extension uses Anthropic content-block format internally, so this provider converts
 * to/from the OpenAI shape at the boundary. The hosted DeepSeek API is text-only — its
 * content arrays reject `image_url` — so screenshots are replaced with a text placeholder
 * and the agent runs on the read_page DOM / accessibility-tree text.
 */

import { BaseProvider } from './base-provider.js';

export class DeepSeekProvider extends BaseProvider {
  getName() {
    return 'deepseek';
  }

  static matchesUrl(baseUrl) {
    return baseUrl.includes('deepseek.com');
  }

  isClaudeModel() {
    return false;
  }

  async getHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apiKey}`,
    };
  }

  buildUrl(_useStreaming) {
    // config.apiBaseUrl is already the full /chat/completions URL.
    return this.config.apiBaseUrl;
  }

  // The hosted DeepSeek API is text-only — content arrays reject `image_url` (400
  // "unknown variant image_url"). Screenshots are replaced with this placeholder; the
  // agent runs on the read_page DOM / accessibility-tree text instead of vision.
  get _imagePlaceholder() {
    return '[screenshot omitted — image input is not supported by this model]';
  }

  /**
   * Convert Anthropic system prompt + messages into OpenAI chat messages.
   * cache_control is dropped (DeepSeek auto-caches context server-side).
   */
  _convertMessages(messages, systemPrompt) {
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
      const userTextChunks = [];

      for (const block of msg.content) {
        if (block.type === 'text') {
          userTextChunks.push(block.text);
        } else if (block.type === 'image') {
          userTextChunks.push(this._imagePlaceholder);
        } else if (block.type === 'tool_result') {
          const textChunks = [];
          let hadImage = false;
          if (typeof block.content === 'string') {
            textChunks.push(block.content);
          } else if (Array.isArray(block.content)) {
            for (const c of block.content) {
              if (c.type === 'text') textChunks.push(c.text);
              else if (c.type === 'image') hadImage = true;
            }
          }
          if (hadImage) textChunks.push(this._imagePlaceholder);
          out.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: textChunks.join('\n') || '(no text output)',
          });
        }
      }

      // Remaining (non-tool_result) user content goes as a single text message.
      if (userTextChunks.length > 0) {
        out.push({ role: 'user', content: userTextChunks.join('\n') });
      }
    }

    return out;
  }

  _convertTools(tools) {
    if (!tools || tools.length === 0) return undefined;
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  buildRequestBody(messages, systemPrompt, tools, useStreaming) {
    const convertedTools = this._convertTools(tools);
    const body = {
      model: this.config.model,
      max_tokens: this.config.maxTokens || 8192,
      messages: this._convertMessages(messages, systemPrompt),
      stream: useStreaming,
      // Thinking mode (on by default for v4-pro) requires echoing reasoning_content back on
      // every subsequent turn. The agent loop stores only {role,content} for assistant turns,
      // so disable thinking to avoid 400 "reasoning_content must be passed back".
      thinking: { type: 'disabled' },
    };
    if (convertedTools) body.tools = convertedTools;
    if (useStreaming) body.stream_options = { include_usage: true };
    return body;
  }

  /**
   * Map a finished OpenAI message into Anthropic content blocks.
   */
  _openAiMessageToContent(message, finishReason) {
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
    else if (finishReason === 'length') stopReason = 'max_tokens';
    return { content, stop_reason: stopReason };
  }

  _normalizeUsage(usage) {
    if (!usage) return null;
    return {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
    };
  }

  normalizeResponse(response) {
    const choice = response.choices?.[0] || {};
    const { content, stop_reason } = this._openAiMessageToContent(
      choice.message || {},
      choice.finish_reason
    );
    return { content, stop_reason, usage: this._normalizeUsage(response.usage) };
  }

  async handleStreaming(response, onTextChunk, _log) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let currentText = '';
    const toolCalls = [];
    let finishReason = null;
    let usage = null;
    let buffer = '';

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;

        let chunk;
        try { chunk = JSON.parse(data); } catch (_e) { continue; }

        const choice = chunk.choices?.[0];
        if (choice) {
          const delta = choice.delta || {};
          if (delta.content) {
            currentText += delta.content;
            if (onTextChunk) onTextChunk(delta.content);
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id || `call_${idx}`, name: '', args: '' };
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function?.name) toolCalls[idx].name = tc.function.name;
              if (tc.function?.arguments) toolCalls[idx].args += tc.function.arguments;
            }
          }
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }

        if (chunk.usage) usage = this._normalizeUsage(chunk.usage);
      }
    }

    const content = [];
    if (currentText) content.push({ type: 'text', text: currentText });
    for (const tc of toolCalls) {
      if (!tc) continue;
      let input = {};
      if (tc.args) {
        try { input = JSON.parse(tc.args); } catch (_e) { input = {}; }
      }
      content.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
    }
    if (content.length === 0) content.push({ type: 'text', text: '' });

    let stopReason = 'end_turn';
    if (toolCalls.some(Boolean)) stopReason = 'tool_use';
    else if (finishReason === 'length') stopReason = 'max_tokens';

    return { content, stop_reason: stopReason, usage };
  }
}
