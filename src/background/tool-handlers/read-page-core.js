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
 * Per-tab cache of the last serialized read, used to collapse redundant identical reads.
 *
 * Accuracy guarantee: we only collapse when the serialized DOM (including [ref] numbers) is
 * byte-identical to the previous read. Identical serialization ⇒ same backendNodeIds ⇒ the
 * nodes still exist ⇒ the agent's existing refs remain valid. We also cap consecutive collapses
 * at MAX_COLLAPSE, so after at most 2 collapses the next identical read re-emits the FULL tree —
 * guaranteeing the agent always has a complete copy within the last few turns even if
 * conversation compaction pruned the earlier one.
 *
 * @type {Map<number, { hash: string, collapseCount: number }>}
 */
const lastReadByTab = new Map();
const MAX_COLLAPSE = 2;

/** Cheap deterministic hash (djb2) over the serialized DOM + URL. */
function hashRead(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
}

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
  // cost without helping. Phase 1 (JS element list) provides compact targeting signal,
  // so CDP tree is for context only. Phase 2: reduce ceiling to 20K.
  const MAX_CHARS_CEILING = 20000;
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

    // Collapse redundant identical reads to save tokens. Skipped when a screenshot was
    // requested (the agent explicitly wants fresh visual state).
    const hash = hashRead(`${tabNow.url}\n${result.text}`);
    const prev = lastReadByTab.get(tabId);
    if (screenshot !== true && prev && prev.hash === hash && prev.collapseCount < MAX_COLLAPSE) {
      lastReadByTab.set(tabId, { hash, collapseCount: prev.collapseCount + 1 });
      return {
        output: `Page DOM is UNCHANGED since your last read_page on this tab (URL: ${tabNow.url} | ${stats.interactiveElements} interactive elements). The element refs from your previous read_page are still valid — act on them directly; do NOT re-read for the same state. If you expected a change: wait ~2s then retry, scroll, take a screenshot (read_page with screenshot=true) to check for an overlay/modal, or take a different action.`,
      };
    }
    lastReadByTab.set(tabId, { hash, collapseCount: 0 });

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
