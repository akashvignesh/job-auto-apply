/**
 * Provider Factory — Claude-only build.
 *
 * Two providers supported: AnthropicProvider (api.anthropic.com) and BedrockProvider
 * (bedrock-runtime.{region}.amazonaws.com). Routing is by URL match; default falls back
 * to Anthropic, which is the right answer in this codebase since both providers expect
 * the same Anthropic Messages request shape.
 */

import { AnthropicProvider } from './anthropic-provider.js';
import { BedrockProvider } from './bedrock-provider.js';

const PROVIDERS = [BedrockProvider, AnthropicProvider];

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
