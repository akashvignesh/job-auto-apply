/**
 * Provider Factory.
 *
 * Providers supported: AnthropicProvider (api.anthropic.com), BedrockProvider
 * (bedrock-runtime.{region}.amazonaws.com), and DeepSeekProvider (api.deepseek.com).
 * Routing is by URL match; default falls back to Anthropic. Anthropic and Bedrock share the
 * Anthropic Messages request shape; DeepSeek converts to/from the OpenAI shape internally.
 */

import { AnthropicProvider } from './anthropic-provider.js';
import { BedrockProvider } from './bedrock-provider.js';
import { DeepSeekProvider } from './deepseek-provider.js';

const PROVIDERS = [BedrockProvider, DeepSeekProvider, AnthropicProvider];

export function createProvider(baseUrl, config) {
  for (const P of PROVIDERS) {
    if (P.matchesUrl(baseUrl || '')) return new P(config);
  }
  return new AnthropicProvider(config);
}

export function detectProvider(baseUrl) {
  for (const P of PROVIDERS) {
    if (P.matchesUrl(baseUrl || '')) return new P({}).getName();
  }
  return 'anthropic';
}
