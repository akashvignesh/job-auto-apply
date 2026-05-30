/**
 * CDP Element Resolver
 *
 * Resolves backendNodeId references to live DOM elements via Chrome DevTools Protocol.
 * Replaces the WeakRef-based ref_N system with Chrome's stable internal identifiers.
 *
 * Usage:
 *   import { createElementResolver } from './element-resolver.js';
 *   const resolver = createElementResolver(sendDebuggerCommand);
 *   const coords = await resolver.getCoordinates(tabId, backendNodeId);
 *   const result = await resolver.callFunction(tabId, backendNodeId, fn, args);
 */

/**
 * Phase C — per-tab cache of ref→{role, label} populated by read-page-core
 * after each successful read. When a stored ref later fails to resolve (the
 * DOM mutated, the form re-rendered), the self-heal path uses these hints to
 * locate the same logical element by role+label and continues without
 * forcing the agent to read_page again.
 *
 * Map<tabId, Map<refString, {role, label, tag?}>>
 *
 * Module-scoped — survives both resolver instances (one in computer-core,
 * one in form-core) so cache misses on one path don't get retried in another.
 */
const _refMetaCache = new Map();
const REF_META_MAX_PER_TAB = 800;

/**
 * Public mutator. Called once per emitted ref by read-page-core after
 * extractDomState returns. Cheap: writes a small object into a Map.
 */
export function recordRefMeta(tabId, ref, meta) {
  if (tabId == null || ref == null || !meta) return;
  let perTab = _refMetaCache.get(tabId);
  if (!perTab) {
    perTab = new Map();
    _refMetaCache.set(tabId, perTab);
  }
  if (perTab.size >= REF_META_MAX_PER_TAB) {
    // Cheapest viable eviction: drop the oldest insertion (Map iterates in
    // insertion order). Refs from this read just-replaced are at the tail.
    const firstKey = perTab.keys().next().value;
    if (firstKey !== undefined) perTab.delete(firstKey);
  }
  perTab.set(String(ref), {
    role: meta.role || '',
    label: meta.label || '',
    tag: meta.tag || '',
    id: meta.id || '',
    name: meta.name || '',
    placeholder: meta.placeholder || '',
    automationId: meta.automationId || '',
  });
}

/** Called by read-page-core whenever a tab navigates / closes. */
export function clearRefMetaForTab(tabId) {
  _refMetaCache.delete(tabId);
}

/** Snapshot the per-tab ref metadata. Used by the plan recorder. */
export function getRefMetaForTab(tabId) {
  const perTab = _refMetaCache.get(tabId);
  return perTab ? new Map(perTab) : new Map();
}

/** For tests. */
export function _peekRefMeta(tabId, ref) {
  const perTab = _refMetaCache.get(tabId);
  return perTab ? perTab.get(String(ref)) || null : null;
}

/**
 * Create an element resolver bound to a CDP send function.
 *
 * @param {(tabId: number, method: string, params?: Object) => Promise<*>} sendCommand
 * @returns {ElementResolver}
 */
export function createElementResolver(sendCommand) {
  /**
   * Phase C — self-heal attempt for a backendNodeId that DOM.resolveNode
   * couldn't find. Uses the per-tab ref-meta cache populated by
   * read-page-core to look up the role/label that the agent saw last time,
   * then runs a small Runtime.evaluate snippet to find a still-visible
   * element matching those hints. Returns a fresh `{objectId, backendNodeId}`
   * so the caller can transparently continue with CDP ops, or null when
   * recovery isn't possible.
   */
  async function _attemptSelfHeal(tabId, backendNodeId) {
    const perTab = _refMetaCache.get(tabId);
    if (!perTab) return null;
    const meta = perTab.get(String(backendNodeId));
    if (!meta || (!meta.role && !meta.label)) return null;

    const role = String(meta.role || '').replace(/['"\\]/g, '');
    const label = String(meta.label || '').slice(0, 80).replace(/['"\\\n]/g, '');
    const tag = String(meta.tag || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    const id = String(meta.id || '').replace(/['"\\\n]/g, '');
    const nameAttr = String(meta.name || '').replace(/['"\\\n]/g, '');
    const placeholder = String(meta.placeholder || '').slice(0, 80).replace(/['"\\\n]/g, '');
    const automationId = String(meta.automationId || '').replace(/['"\\\n]/g, '');

    // Build a single expression that runs entirely page-side, so we save a
    // round trip per check. It collects candidates by role OR tag, filters
    // by visibility + accessible-name match against the recorded label, and
    // returns the FIRST node. No matches → returns null so subtype is 'null'.
    const expr = `(function () {
      try {
        var role = ${JSON.stringify(role)};
        var label = ${JSON.stringify(label)}.toLowerCase();
        var tag = ${JSON.stringify(tag)};
        var id = ${JSON.stringify(id)};
        var nameAttr = ${JSON.stringify(nameAttr)};
        var placeholder = ${JSON.stringify(placeholder)};
        var automationId = ${JSON.stringify(automationId)};
        function visible(n) {
          if (!n) return false;
          if (n.offsetParent !== null) return true;
          try {
            var r = n.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          } catch (_e) { return false; }
        }
        function ownName(n) {
          var out = n.getAttribute('aria-label') || n.getAttribute('placeholder') || n.getAttribute('title') || '';
          var labelledBy = n.getAttribute('aria-labelledby');
          if (!out && labelledBy) {
            out = labelledBy.split(/\\s+/).map(function (id) {
              var e = document.getElementById(id);
              return e ? (e.textContent || '') : '';
            }).join(' ');
          }
          if (!out && n.id && window.CSS && CSS.escape) {
            var lab = document.querySelector('label[for="' + CSS.escape(n.id) + '"]');
            if (lab) out = lab.textContent || '';
          }
          if (!out) {
            var ancestor = n.closest && n.closest('label,[role="group"],fieldset,[data-automation-id]');
            if (ancestor) out = ancestor.textContent || '';
          }
          if (!out) out = n.textContent || '';
          return String(out).trim().toLowerCase();
        }
        var stableSelectors = [];
        if (automationId) stableSelectors.push('[data-automation-id="' + automationId.replace(/"/g, '\\\\"') + '"]');
        if (id && window.CSS && CSS.escape) stableSelectors.push('#' + CSS.escape(id));
        if (nameAttr) stableSelectors.push('[name="' + nameAttr.replace(/"/g, '\\\\"') + '"]');
        if (placeholder) stableSelectors.push('[placeholder="' + placeholder.replace(/"/g, '\\\\"') + '"]');
        for (var s = 0; s < stableSelectors.length; s++) {
          var stableNodes = document.querySelectorAll(stableSelectors[s]);
          for (var si = 0; si < stableNodes.length; si++) {
            var sn = stableNodes[si];
            var snName = ownName(sn);
            if (visible(sn) && (!label || snName.indexOf(label) !== -1 || label.indexOf(snName) !== -1)) return sn;
          }
        }
        var sel = [];
        if (role) sel.push('[role="' + role + '"]');
        if (tag)  sel.push(tag);
        if (sel.length === 0) return null;
        var nodes = document.querySelectorAll(sel.join(','));
        for (var i = 0; i < nodes.length; i++) {
          var n = nodes[i];
          if (!visible(n)) continue;
          var nodeName = ownName(n);
          if (!label || nodeName.indexOf(label) !== -1 || label.indexOf(nodeName) !== -1) return n;
          if (!n || n.offsetParent === null) {
            // offsetParent null for fixed/hidden — still allow elements
            // with non-zero box when getBoundingClientRect is available.
            try {
              var r = n.getBoundingClientRect();
              if (!(r.width > 0 && r.height > 0)) continue;
            } catch (_e) { continue; }
          }
          var name = (n.getAttribute('aria-label') || n.getAttribute('aria-labelledby') || '');
          if (!name) {
            // Fall back to textContent for buttons/links.
            name = (n.textContent || '').trim();
          }
          name = String(name).toLowerCase();
          if (!label || name.indexOf(label) !== -1) return n;
        }
        return null;
      } catch (_e) { return null; }
    })()`;

    let evalResult;
    try {
      evalResult = await sendCommand(tabId, 'Runtime.evaluate', {
        expression: expr,
        returnByValue: false,
      });
    } catch {
      return null;
    }

    const obj = evalResult && evalResult.result;
    if (!obj || obj.subtype !== 'node' || !obj.objectId) return null;

    // Translate the new objectId into a fresh backendNodeId so downstream
    // CDP calls (DOM.getBoxModel, DOM.scrollIntoViewIfNeeded) work.
    let describe;
    try {
      describe = await sendCommand(tabId, 'DOM.describeNode', { objectId: obj.objectId });
    } catch {
      return null;
    }
    const freshBackendId = describe?.node?.backendNodeId;
    if (!freshBackendId) return null;
    return { objectId: obj.objectId, backendNodeId: freshBackendId };
  }

  /**
   * Resolve a backendNodeId to a Runtime.RemoteObject.
   *
   * Phase C: on resolveNode failure, attempt a self-heal lookup using the
   * per-tab ref-meta cache. If a fresh element matching the recorded
   * role/label is still on the page, return its objectId; the caller's
   * `backendNodeId` argument is now stale but the objectId is valid for the
   * primary code path (Runtime.callFunctionOn). For ops that REQUIRE a
   * backendNodeId (scrollIntoViewIfNeeded, getBoxModel), use
   * `resolveNodeFull` instead which returns the healed id explicitly.
   *
   * @param {number} tabId
   * @param {number} backendNodeId
   * @returns {Promise<string>} objectId for use with Runtime.callFunctionOn
   */
  async function resolveNode(tabId, backendNodeId) {
    const full = await resolveNodeFull(tabId, backendNodeId);
    return full.objectId;
  }

  /**
   * Resolve with self-heal, returning the effective objectId AND the
   * backendNodeId that actually worked. When the original ref resolved
   * cleanly, `backendNodeId` equals the input. When the self-heal path
   * kicked in, `backendNodeId` is the freshly-discovered id.
   *
   * @returns {Promise<{objectId: string, backendNodeId: number, healed: boolean}>}
   */
  async function resolveNodeFull(tabId, backendNodeId) {
    try {
      const result = await sendCommand(tabId, 'DOM.resolveNode', { backendNodeId });
      if (result?.object?.objectId) {
        return { objectId: result.object.objectId, backendNodeId, healed: false };
      }
    } catch {
      // Fall through to self-heal.
    }
    const healed = await _attemptSelfHeal(tabId, backendNodeId);
    if (healed) {
      return { objectId: healed.objectId, backendNodeId: healed.backendNodeId, healed: true };
    }
    throw new Error(`Could not resolve element ${backendNodeId} — it may have been removed from the page`);
  }

  /**
   * Execute a function on an element identified by backendNodeId.
   *
   * @param {number} tabId
   * @param {number} backendNodeId
   * @param {string} functionDeclaration - JS function source, first param is the element
   * @param {Array<{value: *}>} [callArgs] - Additional arguments after the element
   * @returns {Promise<*>} Return value from the function (must be JSON-serializable)
   */
  async function callFunction(tabId, backendNodeId, functionDeclaration, callArgs = []) {
    const objectId = await resolveNode(tabId, backendNodeId);
    const result = await sendCommand(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration,
      arguments: [{ objectId }, ...callArgs],
      returnByValue: true,
      awaitPromise: true,
    });
    if (result?.exceptionDetails) {
      const msg = result.exceptionDetails.exception?.description
        || result.exceptionDetails.text
        || 'Unknown error';
      throw new Error(`Error on element ${backendNodeId}: ${msg}`);
    }
    return result?.result?.value;
  }

  /**
   * Get the center coordinates of an element, scrolling it into view first.
   *
   * @param {number} tabId
   * @param {number} backendNodeId
   * @returns {Promise<{x: number, y: number}>}
   */
  async function getCoordinates(tabId, backendNodeId) {
    // Phase C — pre-resolve once so the self-heal path runs at most once
    // for the whole getCoordinates() call. Subsequent CDP ops use the
    // EFFECTIVE backendNodeId, which may be different from the input.
    const { backendNodeId: effId, objectId } = await resolveNodeFull(tabId, backendNodeId);

    // Scroll into view first
    try {
      await sendCommand(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: effId });
    } catch {
      // Fallback: use JS scrollIntoView
      await sendCommand(tabId, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: '(el) => el.scrollIntoView({behavior:"instant",block:"center",inline:"center"})',
        arguments: [{ objectId }],
      });
    }

    // Get the box model for accurate coordinates
    try {
      const box = await sendCommand(tabId, 'DOM.getBoxModel', { backendNodeId: effId });
      if (box?.model?.content) {
        // content quad: [x1,y1, x2,y2, x3,y3, x4,y4]
        const quad = box.model.content;
        const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
        const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
        return { x, y };
      }
    } catch {
      // Fallback: use getBoundingClientRect via JS
    }

    // Fallback: getBoundingClientRect via the already-resolved objectId so we
    // do not re-resolve a (potentially stale) backendNodeId here.
    try {
      const rectResult = await sendCommand(tabId, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `(el) => {
          if (typeof el.getBoundingClientRect !== 'function') return null;
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }`,
        arguments: [{ objectId }],
        returnByValue: true,
        awaitPromise: true,
      });
      const rect = rectResult?.result?.value;
      if (rect && typeof rect.x === 'number') {
        return rect;
      }
    } catch {
      // Fall through to direct click fallback
    }

    // Last resort: click the element directly and return sentinel coordinates
    // Some ATS (SuccessFactors) render elements that have no box model or bounding rect
    await sendCommand(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `(el) => {
        if (typeof el.click === 'function') el.click();
        else if (el.parentElement) el.parentElement.click();
      }`,
      arguments: [{ objectId }],
      returnByValue: true,
      awaitPromise: true,
    });
    return { x: -1, y: -1, directClicked: true };
  }

  /**
   * Scroll element into view.
   *
   * @param {number} tabId
   * @param {number} backendNodeId
   */
  async function scrollIntoView(tabId, backendNodeId) {
    try {
      await sendCommand(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
    } catch {
      const objectId = await resolveNode(tabId, backendNodeId);
      await sendCommand(tabId, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: '(el) => el.scrollIntoView({behavior:"smooth",block:"center"})',
        arguments: [{ objectId }],
      });
    }
  }

  /**
   * Set files on a file input element.
   *
   * @param {number} tabId
   * @param {number} backendNodeId
   * @param {string[]} files - Array of file paths
   */
  async function setFileInputFiles(tabId, backendNodeId, files) {
    await sendCommand(tabId, 'DOM.setFileInputFiles', {
      files,
      backendNodeId,
    });
  }

  async function getProperty(tabId, backendNodeId, propertyName) {
    const objectId = await resolveNode(tabId, backendNodeId);
    const result = await sendCommand(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: '(el, prop) => el && el[prop] != null ? String(el[prop]) : ""',
      arguments: [{ objectId }, { value: propertyName }],
      returnByValue: true,
      awaitPromise: true,
    });
    return result?.result?.value || '';
  }

  /**
   * Parse a ref string into a backendNodeId.
   * Accepts: "42", 42, "ref_42" (legacy)
   * Returns null if not parseable as backendNodeId (must use legacy WeakRef path).
   *
   * @param {string|number} ref
   * @returns {number|null}
   */
  function parseRef(ref) {
    if (typeof ref === 'number') return ref;
    if (typeof ref === 'string') {
      // Legacy ref_N format — not a backendNodeId
      if (ref.startsWith('ref_')) return null;
      const n = parseInt(ref, 10);
      if (!isNaN(n) && n > 0) return n;
    }
    return null;
  }

  return {
    resolveNode,
    resolveNodeFull,
    callFunction,
    getCoordinates,
    scrollIntoView,
    setFileInputFiles,
    getProperty,
    parseRef,
  };
}
