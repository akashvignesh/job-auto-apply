/**
 * DOM Service
 *
 * Extracts and processes page DOM using Chrome DevTools Protocol.
 * Makes 4 parallel CDP calls, merges results into enhanced tree,
 * then serializes to compact text format for LLM consumption.
 *
 * Architecture mirrors browser-use's DomService but runs in a
 * Chrome extension service worker using chrome.debugger API.
 *
 * Usage (from service worker):
 *   import { extractDomState } from './dom-service/index.js';
 *   const { text, selectorMap, timing } = await extractDomState(tabId);
 *
 * Usage (offline with raw CDP JSON — for testing):
 *   import { processCdpData } from './dom-service/index.js';
 *   const { text, selectorMap } = processCdpData(rawCdpJson);
 */

import { buildSnapshotLookup, REQUIRED_COMPUTED_STYLES } from './snapshot-lookup.js';
import { buildAxLookup, buildEnhancedTree } from './tree-builder.js';
import { serializeDomTree } from './serializer.js';

// Tags that are never semantically interactive on their own but often carry
// React/Vue addEventListener bindings.  We only query these for event listeners.
const CANDIDATE_TAGS = new Set([
  'div', 'span', 'li', 'td', 'th', 'p', 'article', 'section',
  'nav', 'header', 'footer', 'main', 'label', 'aside',
]);

// Only these listener types indicate a "click-like" interaction.
const CLICK_EVENTS = new Set([
  'click', 'mousedown', 'touchstart', 'pointerdown',
]);

/**
 * Traverse raw DOM.getDocument result and collect backendNodeIds of
 * non-semantic elements that might carry JS event listeners.
 * Caps at `cap` entries to bound CDP round-trips.
 *
 * @param {Object} rawNode - node from DOM.getDocument response
 * @param {number[]} out - accumulator array
 * @param {number} cap
 */
function collectCandidateIds(rawNode, out, cap = 150) {
  if (!rawNode || out.length >= cap) return;
  const tag = (rawNode.nodeName || '').toLowerCase();
  if (CANDIDATE_TAGS.has(tag) && rawNode.backendNodeId) {
    out.push(rawNode.backendNodeId);
  }
  for (const child of rawNode.children || []) {
    if (out.length >= cap) break;
    collectCandidateIds(child, out, cap);
  }
  // Recurse into shadow roots and content documents
  for (const sr of rawNode.shadowRoots || []) {
    if (out.length >= cap) break;
    collectCandidateIds(sr, out, cap);
  }
  if (rawNode.contentDocument && out.length < cap) {
    collectCandidateIds(rawNode.contentDocument, out, cap);
  }
}

/**
 * For a list of backendNodeIds, resolve each to a JS objectId and call
 * DOMDebugger.getEventListeners.  Returns a Set of backendNodeIds that
 * have at least one click-family listener.
 *
 * Errors on individual elements are silently skipped.
 * The whole call is wrapped in a 5-second deadline so it never blocks extraction.
 *
 * @param {(m: string, p?: Object) => Promise<*>} cdp
 * @param {number[]} candidateIds
 * @returns {Promise<Set<number>>}
 */
async function collectEventListenerHints(cdp, candidateIds) {
  if (!candidateIds.length) return new Set();

  const work = async () => {
    const result = new Set();
    await Promise.all(
      candidateIds.map(async (backendNodeId) => {
        try {
          const { object } = await cdp('DOM.resolveNode', { backendNodeId });
          if (!object?.objectId) return;
          const { listeners } = await cdp('DOMDebugger.getEventListeners', {
            objectId: object.objectId,
            depth: 0,       // only this element, not ancestors
            pierce: false,
          });
          if (listeners && listeners.some((l) => CLICK_EVENTS.has(l.type))) {
            result.add(backendNodeId);
          }
          // Release the remote object to avoid memory leak
          await cdp('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
        } catch (_) {
          // silently skip — node may have been removed or CDP may not support it
        }
      }),
    );
    return result;
  };

  try {
    return await raceDeadline(work(), 5000, 'collectEventListenerHints');
  } catch (e) {
    console.warn('[extractDomState] event listener hints timed out:', e?.message || e);
    return new Set();
  }
}

/**
 * @param {Promise<*>} promise
 * @param {number} ms
 * @param {string} label
 */
function raceDeadline(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

/**
 * @param {(m: string, p?: Object) => Promise<*>} cdp
 */
async function captureSnapshotPhased(cdp, snapshotTimeoutMs) {
  const params = {
    computedStyles: REQUIRED_COMPUTED_STYLES,
    includePaintOrder: true,
    includeDOMRects: true,
    includeBlendedBackgroundColors: false,
    includeTextColorOpacities: false,
  };
  try {
    return await raceDeadline(cdp('DOMSnapshot.captureSnapshot', params), snapshotTimeoutMs, 'DOMSnapshot.captureSnapshot');
  } catch (e) {
    console.warn('[extractDomState] full snapshot failed:', e?.message || e);
    try {
      return await raceDeadline(
        cdp('DOMSnapshot.captureSnapshot', { ...params, includePaintOrder: false }),
        Math.min(15000, Math.max(8000, Math.floor(snapshotTimeoutMs * 0.7))),
        'DOMSnapshot.captureSnapshot(lite)',
      );
    } catch (e2) {
      console.warn('[extractDomState] lite snapshot failed:', e2?.message || e2);
      return { documents: [], strings: [] };
    }
  }
}

/**
 * Process raw CDP data into serialized DOM state.
 * Used for offline testing (with golden reference data) and
 * as the core processing step in live extraction.
 *
 * @param {Object} rawCdp - Object with keys: dom_snapshot, dom_tree, ax_tree, layout_metrics
 * @param {Object} [options]
 * @param {number} [options.maxChars=40000]
 * @param {Set<number>} [options.eventListenerSet] - backendNodeIds with JS click listeners
 * @returns {{ text: string, selectorMap: Map<number, Object>, stats: Object }}
 */
export function processCdpData(rawCdp, options = {}) {
  const { dom_snapshot, dom_tree, ax_tree, layout_metrics } = rawCdp;
  const { eventListenerSet = new Set() } = options;

  // Calculate device pixel ratio
  const cssViewport = layout_metrics?.cssVisualViewport || {};
  const visualViewport = layout_metrics?.visualViewport || {};
  const viewportWidth = cssViewport.clientWidth || 1200;
  const viewportHeight = cssViewport.clientHeight || 725;

  let devicePixelRatio = 1.0;
  if (visualViewport.clientWidth && cssViewport.clientWidth) {
    devicePixelRatio = visualViewport.clientWidth / cssViewport.clientWidth;
  }

  // Phase 1: Build snapshot lookup
  const snapshotLookup = buildSnapshotLookup(dom_snapshot, devicePixelRatio);

  // Phase 2: Build AX lookup
  const axLookup = buildAxLookup(ax_tree?.nodes || []);

  // Phase 3: Build enhanced tree
  if (!dom_tree?.root) {
    return {
      text: '',
      selectorMap: new Map(),
      stats: {
        devicePixelRatio,
        viewportWidth,
        viewportHeight,
        snapshotNodes: snapshotLookup.size,
        axNodes: axLookup.size,
        interactiveElements: 0,
        textLength: 0,
        truncated: false,
      },
    };
  }

  const enhancedRoot = buildEnhancedTree(
    dom_tree.root,
    axLookup,
    snapshotLookup,
    viewportHeight,
    eventListenerSet,
  );

  // Phase 4: Serialize
  const { text, selectorMap, truncated } = serializeDomTree(enhancedRoot, options);

  return {
    text,
    selectorMap,
    stats: {
      devicePixelRatio,
      viewportWidth,
      viewportHeight,
      snapshotNodes: snapshotLookup.size,
      axNodes: axLookup.size,
      interactiveElements: selectorMap.size,
      textLength: text.length,
      truncated,
    },
  };
}

/**
 * Extract DOM state from a live Chrome tab using CDP.
 * Requires chrome.debugger to be attached to the tab.
 *
 * @param {number} tabId - Chrome tab ID
 * @param {(tabId: number, method: string, params?: Object) => Promise<*>} sendCommand - CDP command sender (e.g., sendDebuggerCommand from debugger-manager)
 * @param {Object} [options]
 * @param {number} [options.maxChars=40000]
 * @param {boolean} [options.includeScreenshot=false]
 * @param {number} [options.documentDepth=52] DOM.getDocument depth (not -1) so huge ATS pages finish
 * @param {number} [options.snapshotTimeoutMs=22000]
 * @param {number} [options.documentTimeoutMs=22000]
 * @param {number} [options.layoutTimeoutMs=10000]
 * @param {number} [options.axFrameTimeoutMs=8000]
 * @param {number} [options.screenshotTimeoutMs=12000]
 * @returns {Promise<{ text: string, selectorMap: Map<number, Object>, screenshot?: string, stats: Object }>}
 */
export async function extractDomState(tabId, sendCommand, options = {}) {
  const {
    maxChars = 40000,
    includeScreenshot = false,
    documentDepth = 52,
    snapshotTimeoutMs = 22000,
    documentTimeoutMs = 22000,
    layoutTimeoutMs = 10000,
    axFrameTimeoutMs = 8000,
    screenshotTimeoutMs = 12000,
  } = options;

  const cdp = (method, params = {}) => sendCommand(tabId, method, params);
  const startTime = performance.now();

  await raceDeadline(
    Promise.all([
      cdp('DOM.enable'),
      cdp('DOMSnapshot.enable'),
      cdp('Accessibility.enable'),
      cdp('Page.enable'),
    ]),
    12000,
    'CDP.enableDomains',
  ).catch((err) => {
    console.warn('[extractDomState] domain enable:', err?.message || err);
  });

  const frameTreeResult = await raceDeadline(cdp('Page.getFrameTree'), 8000, 'Page.getFrameTree');

  const frameIds = [];
  function collectFrames(ft) {
    frameIds.push(ft.frame.id);
    for (const child of ft.childFrames || []) {
      collectFrames(child);
    }
  }
  collectFrames(frameTreeResult.frameTree);

  const [snapSettled, domSettled] = await Promise.allSettled([
    captureSnapshotPhased(cdp, snapshotTimeoutMs),
    raceDeadline(
      cdp('DOM.getDocument', { depth: documentDepth, pierce: true }),
      documentTimeoutMs,
      'DOM.getDocument',
    ),
  ]);

  let snapshotResult = snapSettled.status === 'fulfilled' ? snapSettled.value : { documents: [], strings: [] };
  if (snapSettled.status === 'rejected') {
    console.warn('[extractDomState] snapshot rejected:', snapSettled.reason?.message);
  }

  let domResult = domSettled.status === 'fulfilled' ? domSettled.value : null;
  if (domSettled.status === 'rejected') {
    console.warn('[extractDomState] getDocument rejected:', domSettled.reason?.message);
  }

  if (!domResult?.root) {
    try {
      domResult = await raceDeadline(
        cdp('DOM.getDocument', { depth: 14, pierce: true }),
        12000,
        'DOM.getDocument(shallow)',
      );
    } catch (e) {
      console.warn('[extractDomState] shallow getDocument failed:', e?.message);
    }
  }

  if (!domResult?.root) {
    throw new Error('read_page: DOM.getDocument returned no root (page may be inaccessible)');
  }

  let layoutResult = {};
  try {
    layoutResult = await raceDeadline(cdp('Page.getLayoutMetrics'), layoutTimeoutMs, 'Page.getLayoutMetrics');
  } catch (e) {
    console.warn('[extractDomState] layout metrics:', e?.message);
  }

  // Collect candidate backendNodeIds for JS event listener detection
  const candidateIds = [];
  collectCandidateIds(domResult.root, candidateIds, 150);

  // Run AX tree collection AND event listener hints in parallel
  const [axResults, eventListenerSet] = await Promise.all([
    Promise.all(
      frameIds.map((fid) =>
        raceDeadline(cdp('Accessibility.getFullAXTree', { frameId: fid }), axFrameTimeoutMs, `AX.${String(fid).slice(0, 8)}`)
          .catch(() => ({ nodes: [] })),
      ),
    ),
    collectEventListenerHints(cdp, candidateIds),
  ]);

  const allAxNodes = [];
  for (const axResult of axResults) {
    if (axResult?.nodes) allAxNodes.push(...axResult.nodes);
  }

  const cdpTime = performance.now() - startTime;

  const rawCdp = {
    dom_snapshot: snapshotResult,
    dom_tree: domResult,
    ax_tree: { nodes: allAxNodes },
    layout_metrics: layoutResult,
  };

  const result = processCdpData(rawCdp, { maxChars, eventListenerSet });

  let screenshot = null;
  if (includeScreenshot) {
    try {
      const screenshotResult = await raceDeadline(
        cdp('Page.captureScreenshot', { format: 'jpeg', quality: 70 }),
        screenshotTimeoutMs,
        'Page.captureScreenshot',
      );
      screenshot = screenshotResult?.data || null;
    } catch (e) {
      console.warn('[read_page] Screenshot via CDP failed:', e?.message);
      try {
        const tab = await chrome.tabs.get(tabId);
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 75 });
        screenshot = dataUrl?.split(',')[1] || null;
      } catch (_) { /* ignore */ }
    }
  }

  return {
    ...result,
    screenshot,
    stats: {
      ...result.stats,
      cdpTimeMs: Math.round(cdpTime),
      totalTimeMs: Math.round(performance.now() - startTime),
      frameCount: frameIds.length,
    },
  };
}
