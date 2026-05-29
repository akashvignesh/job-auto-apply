/**
 * JavaScript Injector — Phase 1
 *
 * Injects lightweight JS into the page to detect interactive elements,
 * occlusion detection, and element stamping with data-hanzi-id.
 * Returns a compact flat list of interactive elements for the LLM.
 *
 * This runs BEFORE the CDP multi-call pipeline to provide a high-signal
 * element list that the LLM uses for action targeting.
 */

/**
 * The injectable script (self-contained IIFE).
 * Runs in the page's main world after injection via Runtime.evaluate.
 */
const INJECTOR_SCRIPT = `(function() {
  const INTERACTIVE_TAGS = new Set(['button','input','select','textarea','a','details','summary','label','option','optgroup']);
  const INTERACTIVE_ROLES = new Set(['button','link','textbox','combobox','checkbox','radio','tab','menuitem','option','switch','slider','searchbox','listbox']);

  let idCounter = 0;
  const idPrefix = Math.random().toString(36).substr(2, 4).toUpperCase();

  function generateId() {
    const num = (idCounter++).toString(36);
    return (idPrefix + '0000' + num).slice(-4);
  }

  function isInteractable(el) {
    try {
      // Primary: checkVisibility API (Chrome 105+)
      if (el.checkVisibility?.({ visibilityProperty: true })) {
        return true;
      }
    } catch (_) {}

    // Fallback: computed style checks
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') {
      return false;
    }

    // Check cursor style (primary signal from PageAgent)
    if (cs.cursor === 'pointer') return true;

    // Check interactive tag names
    const tag = el.tagName.toLowerCase();
    if (INTERACTIVE_TAGS.has(tag)) return true;

    // Check ARIA roles
    const role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES.has(role)) return true;

    // Check for explicit onclick/onmousedown attributes
    if (el.onclick || el.onmousedown) return true;

    return false;
  }

  function isTopElement(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;

    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const probes = [
      [cx, cy],
      [rect.left + 5, rect.top + 5],
      [rect.right - 5, rect.top + 5],
      [rect.left + 5, rect.bottom - 5],
      [rect.right - 5, rect.bottom - 5]
    ];

    for (const [x, y] of probes) {
      const top = document.elementFromPoint(x, y);
      if (top && (top === el || el.contains(top))) {
        return true;
      }
    }
    return false;
  }

  function getElementLabel(el) {
    let label = '';

    // aria-label is most reliable
    if (el.hasAttribute('aria-label')) {
      label = el.getAttribute('aria-label');
    }
    // placeholder for inputs
    else if (el.hasAttribute('placeholder')) {
      label = el.getAttribute('placeholder');
    }
    // title attribute
    else if (el.hasAttribute('title')) {
      label = el.getAttribute('title');
    }
    // aria-labelledby
    else if (el.hasAttribute('aria-labelledby')) {
      const ref = el.getAttribute('aria-labelledby');
      const labelEl = document.getElementById(ref);
      label = labelEl?.textContent || '';
    }
    // direct text content
    else if (el.textContent) {
      label = el.textContent.trim().slice(0, 60);
    }
    // For links, use href
    else if (el.tagName === 'A' && el.href) {
      label = el.href.slice(0, 40);
    }

    return label.replace(/\\s+/g, ' ').trim().slice(0, 80);
  }

  function buildCompactEntry(el, hanziId) {
    const tag = el.tagName.toLowerCase();
    const label = getElementLabel(el);

    // Build attribute string
    let attrs = '';
    if (el.type) attrs += \` type=\${el.type}\`;
    if (el.name) attrs += \` name=\${el.name}\`;
    if (el.role) attrs += \` role=\${el.role}\`;
    if (el.value) attrs += \` value=\${el.value.slice(0, 20)}\`;
    if (el.href && el.tagName === 'A') attrs += \` href=\${el.href.slice(0, 40)}\`;
    if (el.placeholder) attrs += \` placeholder=\${el.placeholder.slice(0, 30)}\`;
    if (el.disabled) attrs += \` disabled\`;
    if (el.checked) attrs += \` checked\`;

    return \`[\${hanziId}]<\${tag}\${attrs}>\${label ? label : ''}\`;
  }

  // Track previous elements
  window.__hanziPrevIds = window.__hanziPrevIds || new Set();
  const prevIds = window.__hanziPrevIds;
  const currentIds = new Set();

  const elements = [];
  const entries = [];

  // Scan all elements
  for (const el of document.querySelectorAll('*')) {
    if (!isInteractable(el)) continue;
    if (!isTopElement(el)) continue;

    const hanziId = generateId();
    el.dataset.hanziId = hanziId;
    currentIds.add(hanziId);

    // Mark new elements with *
    const isNew = !prevIds.has(hanziId);
    const marker = isNew ? '*' : '';

    const entry = buildCompactEntry(el, hanziId);
    entries.push(marker + entry);
    elements.push({ hanziId, el });
  }

  // Update prev set for next call
  window.__hanziPrevIds = currentIds;

  return entries.join('\\n');
})()`;

/**
 * Inject the element detector into the page and get the compact list.
 *
 * @param {number} tabId - Chrome tab ID
 * @param {Function} sendDebuggerCommand - CDP command function
 * @returns {Promise<string|null>} Compact element list, or null on failure
 */
export async function injectElementDetector(tabId, sendDebuggerCommand) {
  try {
    const result = await sendDebuggerCommand('Runtime.evaluate', {
      expression: INJECTOR_SCRIPT,
      returnByValue: true,
      awaitPromise: false,
      allowUnsafeEvalBlockedByCSP: true,
    });

    if (result?.result?.value && typeof result.result.value === 'string') {
      return result.result.value;
    }
    return null;
  } catch (err) {
    console.warn('[js-injector] Failed to inject element detector:', err.message);
    return null;
  }
}
