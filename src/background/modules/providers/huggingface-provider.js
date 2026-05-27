/**
 * HuggingFace Inference API Provider
 * OpenAI-compatible endpoint (https://api-inference.huggingface.co/v1/chat/completions)
 * Handles Gemma, Mistral, Llama, and other open models.
 */

import { OpenAIProvider } from './openai-provider.js';

export class HuggingFaceProvider extends OpenAIProvider {
  getName() {
    return 'huggingface';
  }

  static matchesUrl(baseUrl) {
    return baseUrl.includes('huggingface.co');
  }

  _modelSupportsTools() {
    const model = this.config.model || '';
    // Gemma models don't support function calling via HF Inference API
    if (model.includes('gemma')) return false;
    return true;
  }

  buildRequestBody(messages, systemPrompt, tools, useStreaming) {
    const body = super.buildRequestBody(messages, systemPrompt, tools, useStreaming);
    if (!this._modelSupportsTools()) {
      delete body.tools;
    }
    return body;
  }
}
