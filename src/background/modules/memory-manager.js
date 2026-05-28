/**
 * Memory Manager - conversation stats helpers.
 *
 * History compaction lives in conversation-compaction.js. This module previously
 * held a competing "summarize-the-middle" implementation that was never wired
 * into the agent loop; that dead code was removed to avoid confusion.
 *
 * Only getMemoryStats is exported — it's read by the agent loop to log how big
 * the conversation has grown each turn (used for [MEMORY] entries in task logs).
 */

/**
 * Rough token estimate for a message array. ~4 chars/token over the JSON-stringified
 * payload — coarse but adequate for logging. For real compaction-trigger math use
 * calculateContextTokens in conversation-compaction.js (more accurate per-block).
 *
 * @param {Array} messages
 * @returns {number} estimated tokens in thousands (K)
 */
function estimateTokensK(messages) {
  const chars = JSON.stringify(messages).length;
  return Math.round(Math.ceil(chars / 4) / 1000);
}

/**
 * Snapshot of conversation size + shape for monitoring.
 *
 * @param {Array} messages
 * @returns {{totalMessages:number, userMessages:number, assistantMessages:number, toolUseCount:number, estimatedTokensK:number}}
 */
export function getMemoryStats(messages) {
  let userMessages = 0;
  let assistantMessages = 0;
  let toolUseCount = 0;

  for (const msg of messages) {
    if (msg.role === 'user') userMessages++;
    else if (msg.role === 'assistant') assistantMessages++;

    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') toolUseCount++;
      }
    }
  }

  return {
    totalMessages: messages.length,
    userMessages,
    assistantMessages,
    toolUseCount,
    estimatedTokensK: estimateTokensK(messages),
  };
}
