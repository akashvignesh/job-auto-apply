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
      lastReadByTab.set(tabId, { ...prev, hash, collapseCount: prev.collapseCount + 1 });
      return {
        output: `Page DOM is UNCHANGED since your last read_page on this tab (URL: ${tabNow.url} | ${stats.interactiveElements} interactive elements). The element refs from your previous read_page are still valid — act on them directly; do NOT re-read for the same state. If you expected a change: wait ~2s then retry, scroll, take a screenshot (read_page with screenshot=true) to check for an overlay/modal, or take a different action.`,
      };
    }

    // Phase C — snapshot-diff path. Build a compact ref→{role,label} map of the
    // current read so the NEXT read can compute a diff. When the page is mostly
    // the same (same URL, ≥80% of refs unchanged), we emit only added/removed/
    // changed refs instead of the full 20K-char DOM dump. Skipped for
    // screenshot reads (agent explicitly asked for fresh state) and for the
    // first read on a tab (no baseline yet).
    const currentRefs = buildRefSummaryFromMap(result.selectorMap);
    const newCacheEntry = { hash, collapseCount: 0, url: tabNow.url || '', refs: currentRefs };
    lastReadByTab.set(tabId, newCacheEntry);

    if (screenshot !== true && prev && prev.refs && prev.url === (tabNow.url || '') && prev.refs.size > 0) {
      const diff = diffRefMaps(prev.refs, currentRefs);
      // Only emit a diff when the bulk of the page is unchanged — otherwise
      // a full re-read is cheaper than a thousand-line CHANGED list.
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
        // Still update the fingerprint + ref-meta cache below — they read from
        // the SAME selectorMap and must stay in sync with what the agent sees.
        return { output: diffOutput };
      }
    }

    // Phase C — repopulate the ref-meta cache so element-resolver self-heal
    // can recover from a stale ref by looking up the same logical element
    // by (role, label). The selectorMap is keyed by backendNodeId and each
    // value is the enhanced tree node — we only need the AX/label info,
    // not the whole node. We replace the cache entirely so removed refs
    // don't linger (a stale entry in this cache would mislead self-heal).
    try {
      const map = result.selectorMap;
      if (map && typeof map.forEach === 'function') {
        clearRefMetaForTab(tabId);
        map.forEach((node, ref) => {
          const role = node?.axNode?.role || node?.attributes?.role || '';
          const label = node?.axNode?.name
            || node?.attributes?.['aria-label']
            || node?.attributes?.placeholder
            || node?.attributes?.title
            || '';
          const tag = (node?.nodeName || '').toLowerCase();
          if (role || label || tag) {
            recordRefMeta(tabId, ref, { role, label, tag });
          }
        });
      }
    } catch {
      // Cache population is best-effort. A failure here just means the
      // next stale-ref lookup falls through to the "Could not resolve"
      // error path — same behavior as before Phase C.
    }

    // Phase A — stash the form fingerprint so the service-worker can persist
    // the learned plan keyed by (domain, fingerprint) when the task succeeds.
    // The synchronous walk happened inside processCdpData; only the hash is
    // async here. Best-effort: a hashing failure must never break read_page.
    if (stats && stats.fieldSeq) {
      fingerprintFromSequence(stats.fieldSeq).then((fp) => {
        if (fp.fingerprint) {
          lastFingerprintByTab.set(tabId, {
            url: tabNow.url || '',
            fingerprint: fp.fingerprint,
            fieldCount: fp.fieldCount,
            at: Date.now(),
          });
        }
      }).catch(() => { /* ignore */ });
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
