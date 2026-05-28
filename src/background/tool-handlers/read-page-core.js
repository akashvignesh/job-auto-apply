/**
 * Read page tool handler
 * Extracts DOM state via Chrome DevTools Protocol (CDP).
 *
 * Uses browser-use's 3-way merge approach:
 *   DOM.getDocument + Accessibility.getFullAXTree + DOMSnapshot.captureSnapshot
 * to produce a rich, serialized DOM tree with [backendNodeId] references.
 *
 * No pre-read delays: attach debugger and snapshot immediately so the UI does not sit on
 * "Reading page structure" for tab/load/spinner polling. If the DOM is empty or still loading,
 * the agent can call read_page again.
 */

import { extractDomState } from '../dom-service/index.js';
import { ensureDebugger, sendDebuggerCommand } from '../managers/debugger-manager.js';

/**
 * Outer cap (per-CDP-step timeouts inside extractDomState fire first).
 * Worst case ≈ enable + frame + parallel(snapshot, dom) + layout + ax + screenshot.
 */
const READ_PAGE_EXTRACT_TIMEOUT_MS = 75000;

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
async function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(t);
  }
}

/**
 * Handle read_page tool - get serialized DOM representation via CDP
 *
 * @param {Object} input - Tool input
 * @param {number} input.tabId - Tab ID to read from
 * @param {number} [input.max_chars] - Max output chars (default: 50000)
 * @param {boolean} [input.screenshot] - Include screenshot (default: false, opt-in for token savings)
 * @returns {Promise<{output?: string, error?: string}>}
 */
export async function handleReadPage(input) {
  const { tabId, max_chars, screenshot } = input || {};

  if (!tabId) {
    throw new Error('No active tab found');
  }

  const tab = await chrome.tabs.get(tabId);
  if (!tab.id) {
    throw new Error('Active tab has no ID');
  }

  // Clamp max_chars: the agent occasionally requests huge values (e.g. 80000) which inflate
  // cost without helping — modals are hoisted to the top and the relevant form fields fit well
  // under 30K. Cap defends against runaway reads.
  const MAX_CHARS_CEILING = 30000;
  const effectiveMaxChars = Math.min(max_chars ?? 20000, MAX_CHARS_CEILING);

  try {
    const attached = await ensureDebugger(tabId);
    if (!attached) {
      return { error: 'Failed to attach debugger to tab. The tab may have been closed or navigated.' };
    }

    const result = await withTimeout(
      extractDomState(tabId, sendDebuggerCommand, {
        maxChars: effectiveMaxChars,
        includeScreenshot: screenshot === true,
        documentDepth: 52,
        snapshotTimeoutMs: 22000,
        documentTimeoutMs: 22000,
        layoutTimeoutMs: 10000,
        axFrameTimeoutMs: 8000,
        screenshotTimeoutMs: 12000,
      }),
      READ_PAGE_EXTRACT_TIMEOUT_MS,
      'read_page (DOM snapshot + screenshot)',
    );

    if (!result.text) {
      return { error: 'Page returned empty DOM tree. The page may still be loading — call read_page again in a moment or use get_page_text.' };
    }

    const tabNow = await chrome.tabs.get(tabId);
    const stats = result.stats;
    const meta = [
      `URL: ${tabNow.url}`,
      `Viewport: ${stats.viewportWidth}x${stats.viewportHeight}`,
      `Interactive elements: ${stats.interactiveElements}`,
      '(CDP read uses bounded DOM depth + per-step timeouts; empty snapshot falls back to AX for refs — re-call read_page if content looks incomplete)',
    ];
    if (stats.truncated) {
      meta.push('(output truncated — use max_chars to increase limit)');
    }

    const response = {
      output: `${result.text}\n\n${meta.join(' | ')}`,
    };
    if (result.screenshot) {
      response.base64Image = result.screenshot;
      response.imageFormat = 'jpeg';
    }
    return response;
  } catch (err) {
    return {
      error: `Failed to read page: ${err instanceof Error ? err.message : 'Unknown error'}`,
    };
  }
}
