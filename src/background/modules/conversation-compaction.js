/**
 * Conversation Compaction Module
 *
 * Prevents context explosion by summarizing conversation when it reaches ~150K tokens.
 * Keeps only recent messages to prevent rate limits.
 */

// Compaction prompt — kept short to minimize output tokens (target: ~800 words / 1500 tokens)
const ZEPHER_PROMPT = `Summarize this browser automation session concisely. Include:

1. USER TASK: The original request verbatim or near-verbatim. Include any DO NOT / MUST / ALWAYS instructions.

2. APPLICATION PROGRESS (for job applications): Company, role, ATS platform. List every form section completed and the exact values entered (name, email, phone, work auth answers, years of experience, etc.).

3. CURRENT STATE: The exact URL and page/step we are on. What action was just taken.

4. ERRORS & FIXES: Any errors encountered and how they were resolved.

5. NEXT ACTION: The single next thing to do to continue the task.

CRITICAL: Only mark a form section, field, or step as completed if the history shows EXPLICIT success confirmation — e.g., "Selected X", "Set text to Y", "Application submitted", "uploaded", "verified". If a step was started or attempted but not explicitly confirmed complete, mark it IN-PROGRESS. Never infer completion from context. Saying an application was submitted when it wasn't is a critical failure.

Be specific about form field values already filled — the agent must not re-fill them. Keep the summary under 800 words (6000 characters maximum).`;

// Hard cap on summary length (matches browser-use's summary_max_chars default).
// If the model ignores the word limit in ZEPHER_PROMPT, we truncate here.
const SUMMARY_MAX_CHARS = 6000;

// Keep the most-recent N read_page tool_use+result pairs intact during summarization.
// Older read_page results are replaced with a tiny placeholder to shrink the summarization
// input (each read_page result is ~5-20K chars of DOM text, mostly stale by the time we compact).
const KEEP_RECENT_READ_PAGE_RESULTS = 2;

// Estimate ~800 tokens per image (maxTargetTokens is 768, slight buffer for encoding)
const IMAGE_TOKEN_ESTIMATE = 800;

// Overhead tokens that must be counted but aren't in messages:
// - System prompt: ~1000 tokens
// - Tool definitions: ~5000 tokens (17 tools with detailed schemas)
// - API overhead: ~500 tokens
const OVERHEAD_TOKENS = 6500;

// Threshold for triggering compaction.
//
// Set as a COST optimization, not a context-window emergency brake.
// browser-use compacts at ~10K-equivalent tokens (40K chars). We pick 30K total tokens
// (with ~6.5K overhead, that's ~23.5K of actual message content) so compaction fires
// roughly once per job application, keeping the growing-cache-read cost in check.
//
// Trade-off: each compaction costs one LLM summarization call (~$0.005 with Haiku 4.5),
// but it caps cache-read volume on subsequent turns. Worth it when a session runs 50+ turns.
const COMPACTION_THRESHOLD = 30000;

/**
 * Estimate tokens for text content
 * Uses ~3.2 chars per token (conservative estimate for mixed content)
 * Actual tokenization varies, but this errs on the safe side
 * @param {string} text - Text to estimate
 * @returns {number} Estimated tokens
 */
function estimateTextTokens(text) {
  if (!text) return 0;
  // Use 3.2 chars/token (conservative) instead of 4 (optimistic)
  return Math.ceil(text.length / 3.2);
}

/**
 * Calculate estimated token count for messages
 * Includes overhead for system prompt and tools
 * @param {Array<Object>} messages - Conversation messages
 * @param {boolean} includeOverhead - Include system prompt/tools overhead (default: true)
 * @returns {number} Estimated token count
 */
export function calculateContextTokens(messages, includeOverhead = true) {
  let total = includeOverhead ? OVERHEAD_TOKENS : 0;

  for (const msg of messages) {
    // String content
    if (typeof msg.content === 'string') {
      total += estimateTextTokens(msg.content);
      continue;
    }

    // Array content (with text and images)
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'image') {
          total += IMAGE_TOKEN_ESTIMATE;
        } else if (block.type === 'text') {
          total += estimateTextTokens(block.text);
        } else if (block.type === 'tool_use') {
          total += estimateTextTokens(JSON.stringify(block));
        } else if (block.type === 'tool_result') {
          // Estimate tool result size
          const resultStr = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content);
          total += estimateTextTokens(resultStr);
        }
      }
      continue;
    }

    // Fallback: stringify the content
    total += estimateTextTokens(JSON.stringify(msg.content));
  }

  return total;
}

/**
 * Preserve recent context — last N complete turns (user+assistant pairs)
 * plus any user messages with screenshots.
 * This ensures the agent retains recent tool results, page state,
 * and visual context after compaction.
 *
 * @param {Array<Object>} messages - Full conversation history
 * @returns {Array<Object>} Recent messages to preserve
 */
function preserveRecentContext(messages) {
  // Keep the last 6 messages (typically 3 complete user/assistant turns)
  // This preserves the most recent tool calls, results, and page state
  const RECENT_MSG_COUNT = 6;
  const recentMessages = messages.slice(-RECENT_MSG_COUNT);

  // Also grab any earlier user messages with screenshots (up to 2 more)
  const preserved = [];
  let extraScreenshots = 0;
  const recentStartIdx = messages.length - RECENT_MSG_COUNT;

  for (let i = recentStartIdx - 1; i >= 0 && extraScreenshots < 2; i--) {
    const msg = messages[i];
    if (
      msg &&
      msg.role === 'user' &&
      Array.isArray(msg.content) &&
      msg.content.some(
        (block) =>
          block.type === 'image' &&
          block.source &&
          (block.source.type === 'base64' || block.source.data)
      )
    ) {
      preserved.unshift(msg);
      extraScreenshots++;
    }
  }

  return [...preserved, ...recentMessages];
}

/**
 * Extract text content from API response
 * @param {Object} response - API response object
 * @returns {string} Extracted text
 */
function extractTextFromResponse(response) {
  if (!response.content || !Array.isArray(response.content)) {
    return '';
  }

  const textBlocks = response.content.filter((block) => block.type === 'text');

  if (textBlocks.length === 0) {
    return '';
  }

  return textBlocks.map((block) => block.text).join('\n');
}

/**
 * Replace stale read_page tool_result content with a short placeholder.
 *
 * Only the N most-recent read_page results are kept verbatim — older ones contain
 * DOM snapshots that are no longer accurate (the page has navigated/changed since).
 * Each pruned result drops ~5-20K chars from the summarization input, making the
 * summarizer LLM call cheaper without losing information (stale DOM has no value).
 *
 * This runs ONLY inside compactConversation — it shapes the input to the summarizer.
 * The live conversation history is not mutated by this function; compaction's own
 * "replace bulk of messages with summary" step handles the live history.
 *
 * @param {Array<Object>} messages - Messages to process
 * @param {number} keepRecent - Number of most-recent read_page results to keep intact
 * @returns {Array<Object>} Messages with old read_page results replaced
 */
function prunePastReadPageResults(messages, keepRecent = KEEP_RECENT_READ_PAGE_RESULTS) {
  // Pass 1: collect all read_page tool_use IDs in chronological order
  const readPageIds = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.name === 'read_page') {
        readPageIds.push(block.id);
      }
    }
  }
  if (readPageIds.length <= keepRecent) return messages;

  // IDs to prune = all except the last `keepRecent`
  const idsToPrune = new Set(readPageIds.slice(0, readPageIds.length - keepRecent));

  // Pass 2: replace matching tool_result content with placeholder text
  return messages.map(msg => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg;
    let touched = false;
    const newContent = msg.content.map(block => {
      if (block.type === 'tool_result' && idsToPrune.has(block.tool_use_id)) {
        touched = true;
        return {
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          content: '[read_page result pruned — DOM was stale by compaction time; only the most recent read_page reflects the current page]',
        };
      }
      return block;
    });
    return touched ? { ...msg, content: newContent } : msg;
  });
}

/**
 * Strip images from messages for summarization
 * Keeps text descriptions but removes base64 image data
 * @param {Array<Object>} messages - Messages to process
 * @returns {Array<Object>} Messages with images replaced by placeholders
 */
function stripImagesForSummarization(messages) {
  return messages.map(msg => {
    if (typeof msg.content === 'string') {
      return msg;
    }

    if (Array.isArray(msg.content)) {
      const strippedContent = msg.content.map(block => {
        if (block.type === 'image') {
          return { type: 'text', text: '[Screenshot was taken here]' };
        }
        return block;
      });
      return { ...msg, content: strippedContent };
    }

    return msg;
  });
}

/**
 * Compact conversation by summarizing old messages
 * Implements compaction strategy
 *
 * @param {Array<Object>} messages - Full conversation history
 * @param {Function} callLLM - Function to call LLM API
 * @param {Function} log - Logging function
 * @returns {Promise<Array<Object>>} Compacted message array
 */
export async function compactConversation(messages, callLLM, log) {
  if (messages.length === 0) {
    throw new Error('Not enough messages to compact');
  }

  const originalTokens = calculateContextTokens(messages);
  await log('COMPACT', `Starting compaction of ${originalTokens.toLocaleString()} tokens...`);

  // Shrink the summarization input: prune stale read_page DOM dumps + strip images.
  // These two steps make the summarizer call dramatically cheaper without losing signal —
  // old DOM is invalid by the time we compact, and screenshots are already textually
  // described in surrounding tool results.
  const prunedMessages = prunePastReadPageResults(messages);
  const messagesForSummary = stripImagesForSummarization(prunedMessages);

  // Add summarization request to messages
  const messagesToSummarize = [
    ...messagesForSummary,
    {
      role: 'user',
      content: ZEPHER_PROMPT,
    },
  ];

  // Call LLM to create summary. disableTools is critical: with the tool schema present the
  // model invokes a tool instead of writing the summary, returning empty text — which is what
  // caused the silent "No text content in summary response" failures and forced emergency
  // compaction (context loss).
  const summaryResponse = await callLLM(messagesToSummarize, null, log, null, null, { disableTools: true });

  // Extract summary text
  let summaryText = extractTextFromResponse(summaryResponse);

  if (!summaryText) {
    throw new Error('No text content in summary response');
  }

  // Hard cap summary length — protect against the model ignoring the word limit in ZEPHER_PROMPT.
  if (summaryText.length > SUMMARY_MAX_CHARS) {
    await log('COMPACT', `Summary exceeded ${SUMMARY_MAX_CHARS} chars, truncating from ${summaryText.length}`);
    summaryText = summaryText.slice(0, SUMMARY_MAX_CHARS).trimEnd() + '…';
  }

  // Format summary for user message
  const formattedSummary = `The conversation history was compressed to save context space. Here's a summary of what we discussed:

${summaryText}

I'll continue from where we left off without asking additional questions.`;

  // Preserve recent context (last 3 user messages with screenshots)
  const recentContext = preserveRecentContext(messages);

  // Build compacted conversation
  // Note: Don't add metadata fields like isCompactionMessage - they'll be rejected by the API
  // Ensure the first message is from 'user' (API requirement) and messages alternate correctly
  const compactedMessages = [
    {
      role: 'user',
      content: formattedSummary,
    },
    {
      role: 'assistant',
      content: 'Understood. I have the full context from the summary above. Continuing from where we left off.',
    },
    ...recentContext,
  ];

  // Ensure valid message alternation (user/assistant must alternate)
  // Fix any consecutive same-role messages from recentContext
  for (let i = 1; i < compactedMessages.length; i++) {
    if (compactedMessages[i].role === compactedMessages[i - 1].role) {
      if (compactedMessages[i].role === 'user') {
        // Insert a minimal assistant message to fix alternation
        compactedMessages.splice(i, 0, { role: 'assistant', content: 'Continuing.' });
        i++; // Skip the inserted message
      } else {
        // Insert a minimal user message to fix alternation
        compactedMessages.splice(i, 0, { role: 'user', content: 'Continue.' });
        i++;
      }
    }
  }

  const newTokens = calculateContextTokens(compactedMessages);

  await log('COMPACT', `${messages.length} msgs → ${compactedMessages.length} msgs`, {
    beforeTokens: originalTokens,
    afterTokens: newTokens,
    reduction: `${Math.round(((originalTokens - newTokens) / originalTokens) * 100)}%`,
  });

  return compactedMessages;
}

/**
 * Emergency compaction - just keep recent messages without summarization
 * Used when normal compaction fails (e.g., API error)
 * @param {Array<Object>} messages - Full conversation
 * @param {Function} log - Logging function
 * @returns {Promise<Array<Object>>} Truncated messages
 */
async function emergencyCompact(messages, log) {
  // Keep only the last few messages with images
  const recentContext = preserveRecentContext(messages);

  const compacted = [
    {
      role: 'assistant',
      content: 'Previous conversation was truncated due to length. I\'ll continue from the recent context.',
    },
    ...recentContext,
  ];

  await log('COMPACT', `Emergency compact: ${messages.length} msgs → ${compacted.length} msgs`);
  return compacted;
}

/**
 * Check if conversation needs compaction and compact if needed
 * Call this in your agent loop before each API call
 *
 * @param {Array<Object>} messages - Current conversation
 * @param {Function} callLLM - Function to call LLM API
 * @param {Function} log - Logging function
 * @returns {Promise<Array<Object>>} Original or compacted messages
 */
export async function compactIfNeeded(messages, callLLM, log) {
  const tokens = calculateContextTokens(messages);

  // Log token count periodically for debugging
  if (tokens > 100000) {
    await log('COMPACT', `Context size: ${tokens.toLocaleString()} tokens (threshold: ${COMPACTION_THRESHOLD.toLocaleString()})`);
  }

  if (tokens < COMPACTION_THRESHOLD) {
    return messages;
  }

  await log('COMPACT', `Context at ${tokens.toLocaleString()} tokens, compacting...`);

  try {
    return await compactConversation(messages, callLLM, log);
  } catch (error) {
    // If compaction fails (e.g., API error during summarization), do emergency compact
    await log('COMPACT', `Compaction failed: ${error.message}. Using emergency compact.`);
    return await emergencyCompact(messages, log);
  }
}
