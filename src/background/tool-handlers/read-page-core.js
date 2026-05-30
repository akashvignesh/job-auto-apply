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
import { fingerprintFromSequence } from '../dom-service/fingerprint.js';
import { recordRefMeta, clearRefMetaForTab } from '../dom-service/element-resolver.js';
import { ensureDebugger, sendDebuggerCommand } from '../managers/debugger-manager.js';
import {
  buildSummary,
  buildActionsOnly,
  buildErrorsOnly,
  buildFormSummary,
} from '../dom-service/summary-builder.js';

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

/**
 * Per-tab cache of the most recent form fingerprint observed by read_page. The
 * service-worker reads this at task-completion time to key the learned-plans
 * store. Updated on every non-collapsed read; preserved across collapsed
 * reads (the DOM hasn't changed so neither has the fingerprint).
 *
 * @type {Map<number, { url: string, fingerprint: string, fieldCount: number, at: number }>}
 */
const lastFingerprintByTab = new Map();

/**
 * Phase 7.2 — screenshot budget state.
 *
 * Goal: cap the number of screenshots taken per page-fingerprint, and short-circuit
 * a repeat screenshot when the DOM hash hasn't changed since the last one. Without
 * a budget, an agent in a "what does the page look like now?" loop can rack up 50+
 * screenshot tokens on one page; with this cap, the agent must do something that
 * actually changes the page before the next screenshot is allowed.
 *
 * Shared with computer({action:'screenshot'}) via the exported helpers below.
 *
 * @type {Map<number, {
 *   lastDomHash?: string,
 *   lastFingerprint?: string,
 *   lastScreenshotAt?: number,
 *   perFingerprint: Map<string, number>,
 *   recentDomHashes: Map<string, { id: string, at: number }>,
 *   counter: number,
 * }>}
 */
const screenshotBudgetByTab = new Map();

const SCREENSHOT_BUDGET_PER_FINGERPRINT = 2;
const SCREENSHOT_CONSECUTIVE_MIN_MS = 1500;

function getBudget(tabId) {
  let b = screenshotBudgetByTab.get(tabId);
  if (!b) {
    b = { perFingerprint: new Map(), recentDomHashes: new Map(), counter: 0 };
    screenshotBudgetByTab.set(tabId, b);
  }
  return b;
}

/**
 * Decide whether a screenshot should be captured for the current state. Returns
 *   { allow: true, id }                       — capture; caller stores the result
 *   { allow: false, reason, priorId? }         — block; caller emits the message
 *
 * Pure decision logic; does not capture or store the image itself.
 *
 * @param {number} tabId
 * @param {{ domHash?: string, fingerprint?: string, now?: number }} state
 */
export function checkScreenshotBudget(tabId, state) {
  const now = state.now || Date.now();
  const b = getBudget(tabId);
  const domHash = state.domHash || '';
  const fingerprint = state.fingerprint || '';

  // 1. Identical DOM hash already captured? Reuse the prior id.
  if (domHash && b.recentDomHashes.has(domHash)) {
    const prior = b.recentDomHashes.get(domHash);
    return {
      allow: false,
      reason: `Page state hash unchanged since ${prior.id}. Reuse the prior screenshot — take a new one only after an action changes the DOM.`,
      priorId: prior.id,
    };
  }

  // 2. Just took a screenshot? Refuse a consecutive one (likely a loop).
  if (b.lastScreenshotAt && now - b.lastScreenshotAt < SCREENSHOT_CONSECUTIVE_MIN_MS) {
    return {
      allow: false,
      reason: `Consecutive screenshot blocked. Wait for an action to change the page (or call read_page mode=summary / mode=errors for cheaper signal).`,
      priorId: b.lastDomHash ? (b.recentDomHashes.get(b.lastDomHash)?.id) : undefined,
    };
  }

  // 3. Per-fingerprint cap.
  if (fingerprint) {
    const used = b.perFingerprint.get(fingerprint) || 0;
    if (used >= SCREENSHOT_BUDGET_PER_FINGERPRINT) {
      return {
        allow: false,
        reason: `Screenshot budget exhausted for this page (${used}/${SCREENSHOT_BUDGET_PER_FINGERPRINT}). Use read_page mode=summary, mode=errors, or verify_action — or advance the page before screenshotting again.`,
      };
    }
  }

  b.counter += 1;
  return { allow: true, id: `screenshot_${tabId}_${b.counter}` };
}

/**
 * Record a captured screenshot in the budget state. Called by callers after they
 * successfully obtain image bytes.
 */
export function recordScreenshotCapture(tabId, id, state) {
  const now = state?.now || Date.now();
  const b = getBudget(tabId);
  const domHash = state?.domHash || '';
  const fingerprint = state?.fingerprint || '';
  if (domHash) {
    b.recentDomHashes.set(domHash, { id, at: now });
    // Keep map bounded.
    if (b.recentDomHashes.size > 6) {
      const firstKey = b.recentDomHashes.keys().next().value;
      if (firstKey !== undefined) b.recentDomHashes.delete(firstKey);
    }
    b.lastDomHash = domHash;
  }
  if (fingerprint) {
    b.perFingerprint.set(fingerprint, (b.perFingerprint.get(fingerprint) || 0) + 1);
    b.lastFingerprint = fingerprint;
  }
  b.lastScreenshotAt = now;
}

/** Clear screenshot budget for a tab (call on tab close / navigate to a new domain). */
export function clearScreenshotBudgetForTab(tabId) {
  screenshotBudgetByTab.delete(tabId);
}

/** Service-worker reads this at task-success to persist the learned plan. */
export function getLastFingerprintForTab(tabId) {
  return lastFingerprintByTab.get(tabId) || null;
}

/** Clear fingerprint cache when a fresh task starts on this tab. */
export function clearLastFingerprintForTab(tabId) {
  lastFingerprintByTab.delete(tabId);
}

/** Cheap deterministic hash (djb2) over the serialized DOM + URL. */
function hashRead(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
}

/**
 * Phase C — build a compact per-ref summary used for diffing the next read.
 * The serializer's selectorMap maps backendNodeId → enhanced tree node; we
 * keep only the fields a diff cares about (role, label, tag) so the cache
 * is small and equality checks are cheap.
 *
 * @param {Map<number, Object>} selectorMap
 * @returns {Map<string, {role: string, label: string, tag: string}>}
 */
export function buildRefSummaryFromMap(selectorMap) {
  const out = new Map();
  if (!selectorMap || typeof selectorMap.forEach !== 'function') return out;
  selectorMap.forEach((node, ref) => {
    const role = (node?.axNode?.role || node?.attributes?.role || '').toString();
    const label = (
      node?.axNode?.name
      || node?.attributes?.['aria-label']
      || node?.attributes?.placeholder
      || node?.attributes?.title
      || ''
    ).toString().slice(0, 80);
    const tag = (node?.nodeName || '').toString().toLowerCase();
    out.set(String(ref), { role, label, tag });
  });
  return out;
}

/**
 * Phase C — diff two ref-summary maps. Returns three lists:
 *   added:   refs present in `cur` but not in `prev`
 *   removed: refs present in `prev` but not in `cur`
 *   changed: refs present in both whose role+label differs
 *
 * Pure / side-effect-free. Exported for tests.
 */
export function diffRefMaps(prev, cur) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [ref, meta] of cur) {
    if (!prev.has(ref)) {
      added.push({ ref, ...meta });
    } else {
      const old = prev.get(ref);
      if (old.role !== meta.role || old.label !== meta.label || old.tag !== meta.tag) {
        changed.push({ ref, from: old, to: meta });
      }
    }
  }
  for (const [ref, meta] of prev) {
    if (!cur.has(ref)) removed.push({ ref, ...meta });
  }
  return { added, removed, changed };
}

/**
 * Format a diff payload for the LLM. Tight format: one short line per change,
 * an explicit "unchanged refs are still valid" sentence so the model knows
 * the cached state from its prior turn remains good for everything not
 * listed here.
 */
function formatDiffOutput({ url, stats, diff, prevRefCount, curRefCount }) {
  const lines = [];
  lines.push(`Page DOM mostly unchanged since your last read_page. URL: ${url}. Interactive elements: ${curRefCount} (was ${prevRefCount}).`);
  lines.push('Refs from the previous read_page that are NOT listed below are still valid — act on them directly. The agent self-heals on stale refs internally.');
  lines.push('');
  if (diff.added.length > 0) {
    lines.push(`ADDED (${diff.added.length}):`);
    for (const a of diff.added.slice(0, 20)) {
      const lbl = a.label ? ` "${truncate(a.label, 60)}"` : '';
      lines.push(`  [${a.ref}] ${a.tag || '<el>'}${a.role ? ' role=' + a.role : ''}${lbl}`);
    }
    if (diff.added.length > 20) lines.push(`  …and ${diff.added.length - 20} more added`);
    lines.push('');
  }
  if (diff.removed.length > 0) {
    lines.push(`REMOVED (${diff.removed.length}):`);
    for (const r of diff.removed.slice(0, 20)) {
      const lbl = r.label ? ` "${truncate(r.label, 60)}"` : '';
      lines.push(`  [${r.ref}] ${r.tag || '<el>'}${r.role ? ' role=' + r.role : ''}${lbl}`);
    }
    if (diff.removed.length > 20) lines.push(`  …and ${diff.removed.length - 20} more removed`);
    lines.push('');
  }
  if (diff.changed.length > 0) {
    lines.push(`CHANGED (${diff.changed.length}):`);
    for (const c of diff.changed.slice(0, 20)) {
      const fromLbl = c.from.label ? `"${truncate(c.from.label, 40)}"` : c.from.tag;
      const toLbl   = c.to.label   ? `"${truncate(c.to.label, 40)}"`   : c.to.tag;
      lines.push(`  [${c.ref}] ${fromLbl} → ${toLbl}`);
    }
    if (diff.changed.length > 20) lines.push(`  …and ${diff.changed.length - 20} more changed`);
    lines.push('');
  }
  lines.push(`Viewport: ${stats.viewportWidth}x${stats.viewportHeight}. If you need the full DOM tree (e.g. structural context, or a refs you cannot find), call read_page with screenshot=true to force a full re-render.`);
  return lines.join('\n');
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function refreshReadCaches(tabId, tabUrl, result, stats) {
  try {
    const map = result.selectorMap;
    if (map && typeof map.forEach === 'function') {
      clearRefMetaForTab(tabId);
      map.forEach((node, ref) => {
        const attrs = node?.attributes || {};
        const axProps = node?.axNode?.properties || {};
        const role = node?.axNode?.role || attrs.role || '';
        const label = node?.axNode?.name
          || attrs['aria-label']
          || attrs.placeholder
          || attrs.title
          || '';
        const tag = (node?.nodeName || '').toLowerCase();

        // Playwright-style actionability state captured at read time so
        // computer/form_input can pre-check without a round-trip. Both HTML
        // attribute and AX property channels are consulted because React
        // controlled components often only mark disabled via aria.
        const disabled =
          axProps.disabled === true || axProps.disabled === 'true'
          || attrs.disabled === '' || attrs.disabled === 'true' || attrs.disabled === 'disabled'
          || attrs['aria-disabled'] === 'true';
        const readonly =
          axProps.readonly === true || axProps.readonly === 'true'
          || attrs.readonly === '' || attrs.readonly === 'true' || attrs.readonly === 'readonly'
          || attrs['aria-readonly'] === 'true';

        if (role || label || tag) {
          recordRefMeta(tabId, ref, {
            role,
            label,
            tag,
            type: attrs.type || '',
            id: attrs.id || '',
            name: attrs.name || '',
            placeholder: attrs.placeholder || '',
            automationId: attrs['data-automation-id'] || '',
            disabled,
            readonly,
          });
        }
      });
    }
  } catch {
    // Cache population is best-effort. A failure here just means the
    // next stale-ref lookup falls through to the "Could not resolve" path.
  }

  if (stats && stats.fieldSeq) {
    fingerprintFromSequence(stats.fieldSeq).then((fp) => {
      if (fp.fingerprint) {
        lastFingerprintByTab.set(tabId, {
          url: tabUrl || '',
          fingerprint: fp.fingerprint,
          fieldCount: fp.fieldCount,
          sample: fp.sample,
          at: Date.now(),
        });
      }
    }).catch(() => { /* ignore */ });
  }
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

const VALID_MODES = new Set(['summary', 'actions', 'errors', 'form_summary', 'full', 'region']);

/**
 * Handle read_page tool - get a compact, task-relevant view of the page.
 *
 * Modes (Phase 7.1):
 *   summary (default) — page meta + fields + buttons + errors + blocker + next-safe-action
 *   actions           — interactive elements only (refs, kinds, labels, state)
 *   errors            — validation errors and invalid fields
 *   form_summary      — required-field fill state + submit button state
 *   full              — full DOM tree (previous default; only when summary is insufficient)
 *   region            — subtree of a given ref (currently falls back to full + filtered output)
 *
 * The DOM extraction is identical across modes; only the output formatting changes.
 * This lets the cache/diff/fingerprint state stay coherent regardless of mode.
 *
 * @param {Object} input - Tool input
 * @param {number} input.tabId - Tab ID to read from
 * @param {string} [input.mode] - 'summary' (default) | 'actions' | 'errors' | 'form_summary' | 'full' | 'region'
 * @param {string} [input.ref] - Required when mode='region'
 * @param {number} [input.max_chars] - Max output chars (only meaningful for mode='full'|'region')
 * @param {boolean} [input.screenshot] - Include screenshot (subject to per-fingerprint budget)
 * @returns {Promise<{output?: string, error?: string, base64Image?: string, imageFormat?: string}>}
 */
export async function handleReadPage(input) {
  const { tabId, max_chars, screenshot } = input || {};
  let mode = (input?.mode || 'summary').toLowerCase();
  if (!VALID_MODES.has(mode)) {
    return { error: `Unknown read_page mode "${mode}". Valid: ${[...VALID_MODES].join(', ')}.` };
  }

  if (!tabId) {
    throw new Error('No active tab found');
  }

  const tab = await chrome.tabs.get(tabId);
  if (!tab.id) {
    throw new Error('Active tab has no ID');
  }

  // Clamp max_chars only matters for full/region modes. Summary/actions/errors emit
  // bounded output by construction (≤40 fields + ≤25 buttons + ≤15 errors).
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

    // Compute the page hash early — needed for both collapse and the screenshot budget.
    const hash = hashRead(`${tabNow.url}\n${result.text}`);

    // Phase A — compute the form fingerprint up front; needed for both the
    // screenshot budget and the meta line emitted to the LLM.
    let liveFingerprint = null;
    if (stats && stats.fieldSeq) {
      try {
        const fp = await fingerprintFromSequence(stats.fieldSeq);
        if (fp.fingerprint) {
          liveFingerprint = fp.fingerprint;
          lastFingerprintByTab.set(tabId, {
            url: tabNow.url || '',
            fingerprint: fp.fingerprint,
            fieldCount: fp.fieldCount,
            at: Date.now(),
          });
        }
      } catch { /* ignore — fingerprint is best-effort */ }
    }

    // Phase 7.2 — screenshot budget. The screenshot bytes are already in result.screenshot
    // (extractDomState captured them). If the budget says no, we drop the bytes from the
    // response and emit a reuse message instead, so the LLM doesn't pay for the image.
    let screenshotBlocked = null;
    if (screenshot === true && result.screenshot) {
      const decision = checkScreenshotBudget(tabId, { domHash: hash, fingerprint: liveFingerprint });
      if (decision.allow) {
        recordScreenshotCapture(tabId, decision.id, { domHash: hash, fingerprint: liveFingerprint });
      } else {
        screenshotBlocked = decision;
        result.screenshot = null;
      }
    }

    // Build the mode-specific output. Modes that don't need the full DOM tree
    // skip the collapse + diff paths below since they're already compact.
    const compactModes = new Set(['summary', 'actions', 'errors', 'form_summary']);
    if (compactModes.has(mode)) {
      // Update caches before returning so future diffs/self-heal work even when
      // the LLM never sees the full DOM tree.
      lastReadByTab.set(tabId, {
        hash,
        collapseCount: 0,
        url: tabNow.url || '',
        refs: buildRefSummaryFromMap(result.selectorMap),
      });
      refreshReadCaches(tabId, tabNow.url || '', result, stats);

      let body;
      const ctx = {
        selectorMap: result.selectorMap,
        domText: result.text,
        stats,
        url: tabNow.url || '',
        title: tabNow.title || '',
        fingerprint: liveFingerprint,
      };
      if (mode === 'summary')      body = buildSummary(ctx);
      else if (mode === 'actions') body = buildActionsOnly(ctx);
      else if (mode === 'errors')  body = buildErrorsOnly(ctx);
      else                          body = buildFormSummary(ctx);

      const tail = [];
      if (liveFingerprint) tail.push(`[fingerprint:${liveFingerprint}]`);
      tail.push(`mode=${mode}`);
      tail.push(`max_chars not applied to mode=${mode}; call mode=full for the raw DOM tree.`);
      if (screenshotBlocked) {
        tail.push(`SCREENSHOT BLOCKED: ${screenshotBlocked.reason}${screenshotBlocked.priorId ? ` (prior id: ${screenshotBlocked.priorId})` : ''}`);
      }
      const response = { output: `${body}\n\n${tail.join(' | ')}` };
      if (result.screenshot) {
        response.base64Image = result.screenshot;
        response.imageFormat = 'jpeg';
      }
      return response;
    }

    // Full (or region) mode: emit the raw serialized tree with meta + diff/collapse logic.
    const meta = [
      `URL: ${tabNow.url}`,
      `Viewport: ${stats.viewportWidth}x${stats.viewportHeight}`,
      `Interactive elements: ${stats.interactiveElements}`,
      'mode=full',
      '(CDP read uses bounded DOM depth + per-step timeouts; empty snapshot falls back to AX for refs — re-call read_page if content looks incomplete)',
    ];
    if (stats.truncated) {
      meta.push('(output truncated — use max_chars to increase limit, or switch to mode=summary)');
    }
    if (screenshotBlocked) {
      meta.push(`SCREENSHOT BLOCKED: ${screenshotBlocked.reason}${screenshotBlocked.priorId ? ` (prior id: ${screenshotBlocked.priorId})` : ''}`);
    }
    if (liveFingerprint) meta.push(`[fingerprint:${liveFingerprint}]`);

    // Collapse redundant identical reads to save tokens. Skipped when a screenshot was
    // explicitly captured (the agent wanted fresh visual state).
    const prev = lastReadByTab.get(tabId);
    const isScreenshotEmitted = screenshot === true && !!result.screenshot;
    if (!isScreenshotEmitted && prev && prev.hash === hash && prev.collapseCount < MAX_COLLAPSE) {
      lastReadByTab.set(tabId, { ...prev, hash, collapseCount: prev.collapseCount + 1 });
      refreshReadCaches(tabId, tabNow.url || '', result, stats);
      return {
        output: `Page DOM is UNCHANGED since your last read_page on this tab (URL: ${tabNow.url} | ${stats.interactiveElements} interactive elements). The element refs from your previous read_page are still valid — act on them directly; do NOT re-read for the same state. If you expected a change: wait ~2s then retry, scroll, switch to mode=summary or mode=errors for a different signal, or take a different action.`,
      };
    }

    const currentRefs = buildRefSummaryFromMap(result.selectorMap);
    lastReadByTab.set(tabId, { hash, collapseCount: 0, url: tabNow.url || '', refs: currentRefs });
    refreshReadCaches(tabId, tabNow.url || '', result, stats);

    if (!isScreenshotEmitted && prev && prev.refs && prev.url === (tabNow.url || '') && prev.refs.size > 0) {
      const diff = diffRefMaps(prev.refs, currentRefs);
      const total = Math.max(prev.refs.size, currentRefs.size, 1);
      const changeRatio = (diff.added.length + diff.removed.length + diff.changed.length) / total;
      if (changeRatio <= 0.2 && (diff.added.length + diff.removed.length + diff.changed.length) <= 40) {
        const diffOutput = formatDiffOutput({
          url: tabNow.url || '',
          stats,
          diff,
          prevRefCount: prev.refs.size,
          curRefCount: currentRefs.size,
        });
        return { output: diffOutput };
      }
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
