/**
 * DOM Tree Serializer
 *
 * Filters enhanced DOM tree and serializes to text format for LLM consumption.
 * Produces output matching browser-use's DOMTreeSerializer format:
 *   [backendNodeId]<tag attr1=val1 attr2=val2 />
 *   Visible text content
 *   |SHADOW(open)|[id]<input ... />
 *
 * Port of browser-use's serializer/serializer.py + clickable_elements.py
 */

const NODE_ELEMENT = 1;
const NODE_TEXT = 3;
const NODE_DOCUMENT = 9;
const NODE_DOCUMENT_FRAGMENT = 11;

const DISABLED_ELEMENTS = new Set([
  'STYLE', 'SCRIPT', 'HEAD', 'META', 'LINK', 'TITLE', 'NOSCRIPT',
]);

const SVG_CHILD_ELEMENTS = new Set([
  'path', 'rect', 'g', 'circle', 'ellipse', 'line', 'polyline',
  'polygon', 'use', 'defs', 'clipPath', 'mask', 'pattern', 'image',
  'text', 'tspan',
]);

const INTERACTIVE_TAGS = new Set([
  'button', 'input', 'select', 'textarea', 'a', 'details', 'summary',
  'option', 'optgroup',
]);

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'menuitem', 'option', 'radio', 'checkbox', 'tab',
  'textbox', 'combobox', 'slider', 'spinbutton', 'search', 'searchbox',
  'listbox', 'row', 'cell', 'gridcell', 'separator',
]);

// Attributes to include in serialized output (matching browser-use DEFAULT_INCLUDE_ATTRIBUTES)
// Phase 2: Tightened allowlist for token efficiency
const INCLUDE_ATTRIBUTES = new Set([
  'title', 'type', 'checked', 'id', 'name', 'role', 'value',
  'placeholder', 'alt', 'aria-label', 'aria-expanded', 'data-state',
  'aria-checked', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow',
  'pattern', 'min', 'max', 'minlength', 'maxlength', 'step', 'accept',
  'multiple', 'inputmode', 'autocomplete', 'aria-autocomplete',
  'contenteditable', 'required',
  // Selector hints — help AI write targeted JS when standard tools fail
  'href', 'for', 'data-automation-id', 'data-testid',
]);

// Phase 2: Attribute value caps (per-attribute, default 20 chars)
const VALUE_CAPS = {
  'aria-label': 50,
  'title': 40,
  'href': 80,
  'placeholder': 30,
  'value': 25,
  'id': 40,
  'name': 40,
  'role': 30,
};

// Phase 2: Utility class removal regex (Tailwind + Bootstrap)
function cleanClass(raw) {
  if (!raw) return '';
  return raw
    .replace(/\b(bg|text|border|p[xy]?|m[xy]?|w|h|flex|grid|gap|rounded|shadow|hover|focus|active|sm|md|lg|xl|2xl)-[\w-]+\b/g, '')
    .replace(/\b(col|row|span|container|wrapper|block|inline|hidden|visible|d-\w+|align-\w+)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// AX properties to include
const INCLUDE_AX_PROPS = new Set([
  'checked', 'selected', 'expanded', 'pressed', 'disabled', 'invalid',
  'valuemin', 'valuemax', 'valuenow', 'required', 'valuetext',
  'haspopup', 'multiselectable', 'level',
]);

/**
 * Check if an enhanced node is interactive/clickable.
 * Port of browser-use's ClickableElementDetector.is_interactive()
 *
 * Must also be visible to be included in the selector map.
 */
function isInteractive(node) {
  if (node.nodeType !== NODE_ELEMENT) return false;

  const tag = (node.nodeName || '').toLowerCase();
  if (tag === 'html' || tag === 'body') return false;

  // Must be visible (have bounds and not hidden by CSS)
  // Exception: file inputs which may have 0-size but are still interactive
  if (!node.isVisible && tag !== 'input') return false;

  // Interactive tags
  if (INTERACTIVE_TAGS.has(tag)) return true;

  // Interactive ARIA roles (from HTML attributes)
  const role = node.attributes?.role;
  if (role && INTERACTIVE_ROLES.has(role)) return true;

  // Interactive AX roles — but NOT for generic structural elements
  // (LI, UL, DIV with listitem/list/generic roles are not truly interactive)
  if (node.axNode?.role) {
    const axRole = node.axNode.role;
    if (INTERACTIVE_ROLES.has(axRole) && axRole !== 'listbox' && axRole !== 'list') {
      return true;
    }
  }

  // Interactive attributes (onclick, tabindex, etc.)
  if (node.attributes) {
    const interactiveAttrs = ['onclick', 'onmousedown', 'onmouseup', 'tabindex'];
    for (const attr of interactiveAttrs) {
      if (attr in node.attributes) return true;
    }
  }

  // AX properties indicating interactivity
  if (node.axNode?.properties) {
    const props = node.axNode.properties;
    if (props.focusable || props.editable || props.settable) return true;
    if ('checked' in props || 'expanded' in props || 'pressed' in props) return true;
  }

  // Cursor pointer
  if (node.snapshotNode?.cursorStyle === 'pointer') return true;

  // JS event listeners (click/mousedown/touchstart bound via addEventListener)
  // Detected via DOMDebugger.getEventListeners — catches React/Vue onClick bindings
  // on plain <div>/<span> elements that have no ARIA role or cursor style.
  return !!node.hasJsEventListener;
}

/**
 * Check if an element should be included in the simplified tree.
 */
function shouldInclude(node) {
  const tag = (node.nodeName || '').toUpperCase();

  // Always skip disabled elements
  if (DISABLED_ELEMENTS.has(tag)) return false;

  // Skip SVG child elements (only show <svg> itself)
  if (SVG_CHILD_ELEMENTS.has(tag.toLowerCase())) return false;

  // Skip extension overlay elements (Simplify, etc.) — they waste agent turns
  const cls = node.attributes?.class || '';
  if (cls.includes('simplify')) return false;

  // Include if visible, has snapshot data, or is interactive
  if (node.isVisible) return true;
  if (isInteractive(node)) return true;

  // Include shadow hosts (they contain shadow roots we need to traverse)
  if (node.shadowRoots && node.shadowRoots.length > 0) return true;

  // Include elements with children (structural)
  if (node.children && node.children.length > 0) return true;
  return !!node.contentDocument;
}

/**
 * Build attributes string for an element.
 * Mirrors browser-use's _build_attributes_string()
 */
// eslint-disable-next-line sonarjs/cognitive-complexity
function buildAttributesString(node) {
  const attrs = {};

  // HTML attributes
  if (node.attributes) {
    for (const [key, value] of Object.entries(node.attributes)) {
      if (INCLUDE_ATTRIBUTES.has(key) && value != null && String(value).trim() !== '') {
        attrs[key] = String(value).trim();
      }
    }
  }

  // AX properties
  if (node.axNode?.properties) {
    for (const [propName, propValue] of Object.entries(node.axNode.properties)) {
      if (INCLUDE_AX_PROPS.has(propName) && propValue != null) {
        const strVal = typeof propValue === 'boolean'
          ? String(propValue).toLowerCase()
          : String(propValue).trim();
        if (strVal) attrs[propName] = strVal;
      }
    }
  }

  // AX node value for form elements (reflects actual typed value)
  if (node.axNode && ['input', 'textarea', 'select'].includes((node.nodeName || '').toLowerCase()) && node.axNode.properties) {
    const valuetext = node.axNode.properties.valuetext;
    const value = node.axNode.properties.value;
    if (valuetext && String(valuetext).trim()) {
      attrs.value = String(valuetext).trim();
    } else if (value && String(value).trim()) {
      attrs.value = String(value).trim();
    }
  }

  // Remove invalid=false, required=false
  if (attrs.invalid === 'false') delete attrs.invalid;
  if (attrs.required === 'false' || attrs.required === '0' || attrs.required === 'no') delete attrs.required;

  // Remove aria-expanded if we have expanded
  if ('expanded' in attrs && 'aria-expanded' in attrs) delete attrs['aria-expanded'];

  // Remove type if it matches tag name
  if (attrs.type && attrs.type.toLowerCase() === (node.nodeName || '').toLowerCase()) delete attrs.type;

  // Phase 2: Duplicate attribute dedup
  if ('aria-label' in attrs && 'name' in attrs && attrs['aria-label'] === attrs.name) {
    delete attrs.name;
  }
  if ('title' in attrs && 'aria-label' in attrs && attrs.title === attrs['aria-label']) {
    delete attrs.title;
  }

  const parts = [];
  for (const [key, value] of Object.entries(attrs)) {
    // Phase 2: Utility class removal + value capping
    let processedValue = value;
    if (key === 'class') {
      processedValue = cleanClass(value);
      if (!processedValue) continue; // Skip empty classes after cleanup
    }

    // Phase 2: Cap values per attribute (default 20 chars)
    const maxLen = VALUE_CAPS[key] || 20;
    const capped = processedValue.length > maxLen ? processedValue.slice(0, maxLen) : processedValue;
    parts.push(`${key}=${capped}`);
  }
  return parts.join(' ');
}

/**
 * Serialize enhanced DOM tree to text format.
 *
 * @param {import('./tree-builder.js').EnhancedNode} root
 * @param {Object} [options]
 * @param {number} [options.maxChars=40000] - Cap output at this many characters
 * @returns {{ text: string, selectorMap: Map<number, Object> }}
 */
/**
 * Detect modal/dialog/overlay nodes that BLOCK interaction with the page behind them.
 *
 * Per the ARIA spec, only `aria-modal="true"` signals a true blocking modal — `role="dialog"`
 * alone is widely used for non-blocking widgets (intl-tel-input's country picker, autocomplete
 * containers, react-select menus, popovers, etc.). Hoisting those triggered the agent into
 * 25+ wasted turns trying to "dismiss" a dropdown that was just normal page chrome.
 *
 * As a backstop for non-ARIA-compliant modals that still visually block (e.g. legacy Bootstrap),
 * we also accept a generic "modal/dialog/overlay" class IF the element covers a large fraction
 * of the viewport — real blocking overlays are big, dropdowns are small.
 */
function isDialog(node, viewportWidth, viewportHeight) {
  if (node.nodeType !== NODE_ELEMENT) return false;

  // Primary signal: aria-modal="true" is the unambiguous "I block the page" marker.
  if (node.attributes?.['aria-modal'] === 'true') return true;

  // Backstop: large visible overlay with a modal-ish class name. Size check eliminates
  // small inline popovers (autocomplete lists, country pickers, tooltips).
  if (!node.isVisible || !node.absolutePosition) return false;
  const cls = (node.attributes?.class || '').toLowerCase();
  if (!/(^|[-_ ])(modal|dialog|overlay)([-_ ]|$)/.test(cls)) return false;
  const { width, height } = node.absolutePosition;
  const viewportArea = (viewportWidth || 1280) * (viewportHeight || 800);
  return width * height >= viewportArea * 0.35;
}

/**
 * Find the outermost dialog/overlay nodes (does not recurse into a dialog to find nested ones).
 */
function collectDialogs(node, out, viewportWidth, viewportHeight) {
  if (!node) return;
  if (node.nodeType === NODE_ELEMENT && isDialog(node, viewportWidth, viewportHeight)) {
    out.push(node);
    return;
  }
  if (node.shadowRoots) for (const sr of node.shadowRoots) collectDialogs(sr, out, viewportWidth, viewportHeight);
  if (node.children) for (const c of node.children) collectDialogs(c, out, viewportWidth, viewportHeight);
  if (node.contentDocument) collectDialogs(node.contentDocument, out, viewportWidth, viewportHeight);
}

/**
 * Detect an OPEN dropdown/typeahead result list (a listbox popup whose options the agent must
 * click to make a selection). Frameworks like Workday and react-select portal these popups to
 * the END of the <body>, so under output truncation the agent gets the search INPUT's ref but
 * never the OPTION refs — it then can't commit a selection and flails with form_input / Enter /
 * blind coordinate clicks (a real Workday "Field of Study" run burned 25+ turns this way).
 * Hoisting the popup to the top guarantees the option refs survive truncation.
 */
function isOptionPopup(node) {
  if (node.nodeType !== NODE_ELEMENT || !node.isVisible) return false;
  const aid = (node.attributes?.['data-automation-id'] || '').toLowerCase();
  // CRITICAL: `selectedItemList` is the list of ALREADY-CHOSEN values (the pills shown after a
  // selection), NOT an open dropdown. Each pill is a role=option, so without this guard it gets
  // hoisted as "OPEN DROPDOWN" on every read_page — the agent then loops forever trying to "close"
  // a dropdown that is actually just the committed value, burning turns/screenshots. Never hoist it.
  if (aid === 'selecteditemlist') return false;
  // Workday renders the active prompt results into activeListContainer / promptOption nodes.
  if (aid === 'activelistcontainer' || aid.includes('promptoption')) return true;
  const role = node.attributes?.role || node.axNode?.role;
  return role === 'listbox';
}

/**
 * Does this subtree contain at least one selectable option? Used to avoid hoisting empty or
 * decorative listboxes. Depth-capped so we don't walk a huge tree.
 */
function hasOptionDescendant(node, depth = 0) {
  if (!node || depth > 6) return false;
  if (node.nodeType === NODE_ELEMENT) {
    const role = node.attributes?.role || node.axNode?.role;
    const tag = (node.nodeName || '').toLowerCase();
    const aid = (node.attributes?.['data-automation-id'] || '').toLowerCase();
    // A `selectedItem` is an already-chosen pill, not a selectable option — don't let it qualify
    // a container as an open option popup (see isOptionPopup note).
    if (aid !== 'selecteditem' && (role === 'option' || tag === 'option')) return true;
  }
  if (node.shadowRoots) for (const sr of node.shadowRoots) if (hasOptionDescendant(sr, depth + 1)) return true;
  if (node.children) for (const c of node.children) if (hasOptionDescendant(c, depth + 1)) return true;
  return false;
}

/**
 * Find outermost open option-list popups. Stops at dialog boundaries — popups inside a modal are
 * already surfaced by the dialog hoist, so re-collecting them here would duplicate output.
 */
function collectOptionPopups(node, out, viewportWidth, viewportHeight) {
  if (!node) return;
  if (node.nodeType === NODE_ELEMENT) {
    if (isDialog(node, viewportWidth, viewportHeight)) return;
    if (isOptionPopup(node) && hasOptionDescendant(node)) { out.push(node); return; }
  }
  if (node.shadowRoots) for (const sr of node.shadowRoots) collectOptionPopups(sr, out, viewportWidth, viewportHeight);
  if (node.children) for (const c of node.children) collectOptionPopups(c, out, viewportWidth, viewportHeight);
  if (node.contentDocument) collectOptionPopups(node.contentDocument, out, viewportWidth, viewportHeight);
}

export function serializeDomTree(root, options = {}) {
  const { maxChars = 40000, viewportWidth, viewportHeight, jsElementList = null, jsonLdObjects = [] } = options;
  const selectorMap = new Map();
  const lines = [];
  let charCount = 0;
  let truncated = false;
  const hoistedDialogIds = new Set(); // backendNodeIds already emitted in the hoist pass
  let inDialogPass = false;

  // Phase 1: Prepend compact JS element list (Phase 1)
  if (jsElementList) {
    lines.push('=== INTERACTIVE ELEMENTS (JS-detected) ===');
    lines.push(jsElementList);
    lines.push('=== PAGE STRUCTURE (for context) ===');
    charCount += jsElementList.length + 80;
  }

  // Phase 0b: Prepend JSON-LD structured data (Phase 3)
  if (jsonLdObjects && jsonLdObjects.length > 0) {
    const relevant = jsonLdObjects.filter(obj => {
      const type = obj['@type'];
      if (typeof type === 'string') {
        return ['JobPosting', 'Product', 'Organization', 'Person', 'BreadcrumbList', 'Article'].includes(type);
      }
      if (Array.isArray(type)) {
        return type.some(t => ['JobPosting', 'Product', 'Organization', 'Person', 'BreadcrumbList', 'Article'].includes(t));
      }
      return false;
    });

    if (relevant.length > 0) {
      lines.push('=== STRUCTURED DATA (JSON-LD) ===');
      for (const obj of relevant) {
        const jsonStr = JSON.stringify(obj, null, 2);
        lines.push(jsonStr);
        charCount += jsonStr.length + 10;
      }
      lines.push('=== END STRUCTURED DATA ===');
      charCount += 35;
    }
  }

  // eslint-disable-next-line sonarjs/cognitive-complexity
  function serialize(node, depth) {
    if (!node || truncated) return;
    if (charCount > maxChars) { truncated = true; return; }

    const tag = (node.nodeName || '').toUpperCase();
    const indent = '\t'.repeat(depth);

    // During the main pass, skip dialog subtrees already emitted at the top (avoid duplication).
    if (!inDialogPass && node.nodeType === NODE_ELEMENT && node.backendNodeId
        && hoistedDialogIds.has(node.backendNodeId)) {
      return;
    }

    // Document nodes (type 9) and DocumentType nodes (type 10) — just traverse children
    if (node.nodeType === NODE_DOCUMENT || node.nodeType === 10) {
      traverseChildren(node, depth);
      return;
    }

    if (node.nodeType === NODE_ELEMENT) {
      // Skip disabled elements
      if (DISABLED_ELEMENTS.has(tag)) return;
      // Skip SVG children
      if (SVG_CHILD_ELEMENTS.has(tag.toLowerCase())) return;
      // Skip extension overlay elements (Simplify, etc.)
      const cls = node.attributes?.class || '';
      if (cls.includes('simplify')) return;

      const interactive = isInteractive(node);
      const isShadowHost = node.shadowRoots && node.shadowRoots.length > 0;
      const isIframe = tag === 'IFRAME' || tag === 'FRAME';

      // SVG — collapse children
      if (tag === 'SVG') {
        let line = indent;
        if (isShadowHost) line += '|SHADOW(open)|';
        if (interactive) {
          line += `[${node.backendNodeId}]`;
          selectorMap.set(node.backendNodeId, node);
        }
        line += '<svg';
        const attrStr = buildAttributesString(node);
        if (attrStr) line += ' ' + attrStr;
        line += ' /> <!-- SVG content collapsed -->';
        lines.push(line);
        charCount += line.length + 1;
        return;
      }

      // Determine if this element gets its own line
      const shouldShow = interactive || isShadowHost || isIframe || shouldInclude(node);
      if (!shouldShow && !node.isVisible) {
        // Still traverse children in case they're visible
        traverseChildren(node, depth);
        return;
      }

      // Build the element line
      if (interactive || isIframe) {
        let line = indent;

        // Shadow host prefix
        if (isShadowHost) {
          const hasClosed = node.shadowRoots.some(sr =>
            sr.shadowRootType && sr.shadowRootType.toLowerCase() === 'closed'
          );
          line += hasClosed ? '|SHADOW(closed)|' : '|SHADOW(open)|';
        }

        if (interactive) {
          line += `[${node.backendNodeId}]`;
          selectorMap.set(node.backendNodeId, node);
        } else if (isIframe) {
          line += '|IFRAME|';
        }

        line += `<${node.nodeName.toLowerCase()}`;
        const attrStr = buildAttributesString(node);
        if (attrStr) line += ' ' + attrStr;
        line += ' />';
        lines.push(line);
        charCount += line.length + 1;

        traverseChildren(node, depth + 1);
      } else {
        // Non-interactive structural element — don't render it, just traverse children
        traverseChildren(node, depth);
      }
    } else if (node.nodeType === NODE_TEXT) {
      // Text node
      if (node.isVisible && node.nodeValue && node.nodeValue.trim().length > 1) {
        const text = node.nodeValue.trim();
        const line = indent + text;
        lines.push(line);
        charCount += line.length + 1;
      }
    } else if (node.nodeType === NODE_DOCUMENT_FRAGMENT) {
      // Shadow root
      const isClosed = node.shadowRootType && node.shadowRootType.toLowerCase() === 'closed';
      lines.push(`${indent}${isClosed ? 'Closed Shadow' : 'Open Shadow'}`);
      charCount += indent.length + 15;

      traverseChildren(node, depth + 1);

      if (node.children && node.children.length > 0) {
        lines.push(`${indent}Shadow End`);
        charCount += indent.length + 11;
      }
    }
  }

  function traverseChildren(node, depth) {
    // Shadow roots first
    if (node.shadowRoots) {
      for (const sr of node.shadowRoots) {
        serialize(sr, depth);
      }
    }
    // Regular children
    if (node.children) {
      for (const child of node.children) {
        serialize(child, depth);
      }
    }
    // Content document (iframes)
    if (node.contentDocument) {
      serialize(node.contentDocument, depth);
    }
  }

  // Hoist modals/dialogs to the very top so they survive truncation. An overlay blocks every
  // element behind it, so the agent must read and dismiss it before anything else works.
  const dialogRoots = [];
  collectDialogs(root, dialogRoots, viewportWidth, viewportHeight);
  if (dialogRoots.length > 0) {
    inDialogPass = true;
    lines.push('=== ACTIVE MODAL / DIALOG — handle this before interacting with the page behind it ===');
    charCount += 90;
    for (const d of dialogRoots) {
      if (d.backendNodeId) hoistedDialogIds.add(d.backendNodeId);
      serialize(d, 1);
    }
    lines.push('=== END MODAL / DIALOG ===');
    charCount += 28;
    inDialogPass = false;
  }

  // Hoist open dropdown/option-list popups next (after any modal). These carry the option refs
  // the agent needs to COMMIT a typeahead selection (Workday Field of Study, react-select menus,
  // etc.). They render at the end of the DOM and were being lost to truncation.
  const popupRoots = [];
  collectOptionPopups(root, popupRoots, viewportWidth, viewportHeight);
  const freshPopups = popupRoots.filter(p => p.backendNodeId && !hoistedDialogIds.has(p.backendNodeId));
  if (freshPopups.length > 0) {
    inDialogPass = true;
    lines.push('=== OPEN DROPDOWN / OPTION LIST — to choose, click the option BY ITS [ref] below; do NOT retype the field or press Enter ===');
    charCount += 120;
    for (const p of freshPopups) {
      hoistedDialogIds.add(p.backendNodeId);
      serialize(p, 1);
    }
    lines.push('=== END OPTION LIST ===');
    charCount += 24;
    inDialogPass = false;
  }

  serialize(root, 0);

  return {
    text: lines.join('\n'),
    selectorMap,
    truncated,
  };
}
