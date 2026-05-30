/**
 * Compact page-state builders for read_page modes.
 *
 * Produces task-relevant UI state from the selectorMap (the same enhanced-node
 * map the full DOM serializer uses). Everything here is pure: it never reads
 * Chrome state or makes CDP calls. Inputs come from extractDomState().
 *
 * Modes:
 *   summary       — page meta + form fields + buttons + errors + blocker + next safe action
 *   actions       — interactive elements only ([ref] <tag> "label" state)
 *   errors        — validation errors and their associated fields
 *   form_summary  — required fields with their fill state
 *   full          — full DOM tree (handled by caller, not here)
 *   region        — subtree of a given ref (handled by caller, not here)
 */

const FORM_TAGS = new Set(['input', 'textarea', 'select']);
const FORM_ROLES = new Set([
  'textbox', 'combobox', 'searchbox', 'spinbutton', 'slider',
  'checkbox', 'radio', 'switch', 'listbox',
]);
const BUTTON_ROLES = new Set(['button', 'link', 'menuitem', 'tab']);
const SUBMIT_KEYWORDS = /^(submit|save( and continue)?|continue|next|review|apply|send|finish|done)$/i;

function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function nameOf(node) {
  return (
    node?.axNode?.name
    || node?.attributes?.['aria-label']
    || node?.attributes?.placeholder
    || node?.attributes?.title
    || node?.attributes?.name
    || ''
  );
}

function roleOf(node) {
  return (
    node?.axNode?.role
    || node?.attributes?.role
    || (node?.nodeName || '').toLowerCase()
  );
}

function tagOf(node) {
  return (node?.nodeName || '').toLowerCase();
}

function selectedValueFor(node, selectedByMultiId) {
  const multiId = node?.attributes?.['data-uxi-multiselect-id'];
  if (!multiId) return '';
  return selectedByMultiId?.get?.(multiId) || '';
}

function valueOf(node, selectedByMultiId = null) {
  const selected = selectedValueFor(node, selectedByMultiId);
  if (selected) return selected;
  const props = node?.axNode?.properties || {};
  if (props.valuetext != null && String(props.valuetext).trim()) return String(props.valuetext);
  if (props.value != null && String(props.value).trim()) return String(props.value);
  const attrVal = node?.attributes?.value;
  if (attrVal != null && String(attrVal).trim()) return String(attrVal);
  if (tagOf(node) === 'button' && node?.attributes?.['aria-haspopup'] === 'listbox') {
    const label = nameOf(node);
    if (label && !/\bselect one\b/i.test(label)) return label.replace(/\s+required\s*$/i, '').trim();
  }
  return '';
}

function isRequired(node) {
  const props = node?.axNode?.properties || {};
  if (props.required === true || props.required === 'true') return true;
  if (node?.attributes?.['aria-required'] === 'true') return true;
  const attr = node?.attributes?.required;
  if (/\\brequired\\b/i.test(nameOf(node))) return true;
  return attr === '' || attr === 'true' || attr === 'required';
}

function isDisabled(node) {
  const props = node?.axNode?.properties || {};
  if (props.disabled === true || props.disabled === 'true') return true;
  const attr = node?.attributes?.disabled;
  return attr === '' || attr === 'true' || attr === 'disabled';
}

function isInvalid(node) {
  const props = node?.axNode?.properties || {};
  if (props.invalid === true || props.invalid === 'true') return true;
  const attr = node?.attributes?.['aria-invalid'];
  return attr === 'true';
}

function checkedState(node) {
  const props = node?.axNode?.properties || {};
  if (props.checked === true || props.checked === 'true') return 'checked';
  if (props.checked === false || props.checked === 'false') return 'unchecked';
  if (props.checked === 'mixed') return 'mixed';
  return null;
}

function isFileInput(node) {
  return tagOf(node) === 'input' && (node?.attributes?.type === 'file');
}

function classifyField(node) {
  const tag = tagOf(node);
  const role = roleOf(node);
  const type = node?.attributes?.type || '';
  if (isFileInput(node)) return 'file';
  if (tag === 'button' && node?.attributes?.['aria-haspopup'] === 'listbox') return 'select';
  if (tag === 'textarea' || role === 'textbox') return 'text';
  if (tag === 'select' || role === 'combobox' || role === 'listbox') return 'select';
  if (role === 'checkbox' || (tag === 'input' && type === 'checkbox')) return 'checkbox';
  if (role === 'radio' || (tag === 'input' && type === 'radio')) return 'radio';
  if (role === 'searchbox' || (tag === 'input' && type === 'search')) return 'text';
  if (role === 'spinbutton' || (tag === 'input' && type === 'number')) return 'number';
  if (role === 'slider' || (tag === 'input' && type === 'range')) return 'slider';
  if (tag === 'input' && (type === 'date' || type === 'datetime-local' || type === 'month' || type === 'time' || type === 'week')) return 'date';
  if (tag === 'input') return 'text';
  return null;
}

function classifyButton(node) {
  const tag = tagOf(node);
  const role = roleOf(node);
  const type = node?.attributes?.type || '';
  if (tag === 'button' || role === 'button') return 'button';
  if (tag === 'a' || role === 'link') return 'link';
  if (tag === 'input' && (type === 'submit' || type === 'button' || type === 'reset')) return 'button';
  if (BUTTON_ROLES.has(role)) return role;
  return null;
}

function isSubmitishLabel(label) {
  return SUBMIT_KEYWORDS.test(String(label || '').trim());
}

/**
 * Walk selectorMap and bucket entries into fields, buttons, errors.
 * One pass, O(n).
 */
function bucketize(selectorMap) {
  const fields = [];
  const buttons = [];
  const errors = [];
  if (!selectorMap || typeof selectorMap.forEach !== 'function') {
    return { fields, buttons, errors };
  }

  const selectedByMultiId = new Map();
  selectorMap.forEach((node) => {
    const attrs = node?.attributes || {};
    if (attrs['data-automation-id'] !== 'selectedItem') return;
    const multiId = attrs['data-uxi-multiselect-id'];
    const selectedText = (
      attrs['data-automation-label']
      || attrs['aria-label']
      || attrs.title
      || nameOf(node)
      || ''
    ).replace(/, press delete to clear value\.$/i, '').trim();
    if (multiId && selectedText) selectedByMultiId.set(multiId, selectedText);
  });

  selectorMap.forEach((node, ref) => {
    if (!node) return;
    const role = roleOf(node);

    // Errors: alert role or aria-invalid=true
    if (role === 'alert' || role === 'alertdialog') {
      const text = (nameOf(node) || node?.axNode?.description || '').trim();
      if (text) errors.push({ ref: String(ref), text: truncate(text, 200) });
    }
    if (isInvalid(node)) {
      const text = (nameOf(node) || '').trim();
      errors.push({ ref: String(ref), text: truncate(`Invalid: ${text || tagOf(node)}`, 200) });
    }

    const fieldKind = classifyField(node);
    if (fieldKind) {
      fields.push({
        ref: String(ref),
        kind: fieldKind,
        label: truncate(nameOf(node), 80),
        value: truncate(valueOf(node, selectedByMultiId), 60),
        required: isRequired(node),
        disabled: isDisabled(node),
        invalid: isInvalid(node),
        checked: checkedState(node),
        tag: tagOf(node),
        role,
      });
      return;
    }

    const buttonKind = classifyButton(node);
    if (buttonKind) {
      buttons.push({
        ref: String(ref),
        kind: buttonKind,
        label: truncate(nameOf(node) || (node?.attributes?.value || ''), 80),
        disabled: isDisabled(node),
        tag: tagOf(node),
      });
    }
  });

  return { fields, buttons, errors };
}

function formatField(f) {
  const parts = [];
  parts.push(`[${f.ref}]`);
  parts.push(f.kind);
  if (f.label) parts.push(`"${f.label}"`);
  if (f.required) parts.push('required');
  if (f.disabled) parts.push('disabled');
  if (f.invalid) parts.push('invalid');
  if (f.checked) parts.push(f.checked);
  if (f.value) parts.push(`value="${f.value}"`);
  else if (f.kind !== 'checkbox' && f.kind !== 'radio' && !f.disabled) parts.push('empty');
  return '  ' + parts.join(' ');
}

function formatButton(b) {
  const parts = [`[${b.ref}]`];
  parts.push(b.kind);
  if (b.label) parts.push(`"${b.label}"`);
  if (b.disabled) parts.push('disabled');
  return '  ' + parts.join(' ');
}

function detectBlocker({ fields, buttons, errors, hasModal }) {
  if (hasModal) {
    return 'A modal/dialog is open. Handle it before interacting with the rest of the page.';
  }
  const missingRequired = fields.filter(
    (f) => f.required && !f.disabled && !f.value && f.checked !== 'checked'
  );
  const disabledSubmit = buttons.find((b) => b.disabled && isSubmitishLabel(b.label));
  if (disabledSubmit && missingRequired.length > 0) {
    const labels = missingRequired.slice(0, 3).map((f) => f.label || f.ref).join(', ');
    return `"${disabledSubmit.label}" is disabled — missing required: ${labels}${missingRequired.length > 3 ? ` (+${missingRequired.length - 3} more)` : ''}.`;
  }
  if (errors.length > 0) {
    return `${errors.length} validation error(s) on the page — resolve before submitting.`;
  }
  if (disabledSubmit) {
    return `"${disabledSubmit.label}" is disabled — page is not ready to advance.`;
  }
  return null;
}

function detectModal(domText) {
  return typeof domText === 'string' && domText.includes('=== ACTIVE MODAL');
}

function detectOpenDropdown(domText) {
  return typeof domText === 'string' && domText.includes('=== OPEN DROPDOWN');
}

/**
 * Build the compact summary mode.
 *
 * @param {Object} args
 * @param {Map<number, Object>} args.selectorMap
 * @param {string} args.domText  Full serialized DOM text (used for modal/dropdown markers)
 * @param {Object} args.stats
 * @param {string} args.url
 * @param {string} [args.title]
 * @param {string} [args.fingerprint]
 * @returns {string}
 */
export function buildSummary({ selectorMap, domText, stats, url, title, fingerprint }) {
  const { fields, buttons, errors } = bucketize(selectorMap);
  const hasModal = detectModal(domText);
  const hasDropdown = detectOpenDropdown(domText);

  const requiredMissing = fields.filter(
    (f) => f.required && !f.disabled && !f.value && f.checked !== 'checked'
  );
  const submitButtons = buttons.filter((b) => isSubmitishLabel(b.label));

  const lines = [];
  lines.push(`PAGE: ${truncate(title || '(untitled)', 100)}`);
  lines.push(`URL: ${url}`);
  if (fingerprint) lines.push(`FINGERPRINT: ${fingerprint}`);
  lines.push(`VIEWPORT: ${stats?.viewportWidth || '?'}x${stats?.viewportHeight || '?'} | INTERACTIVE: ${stats?.interactiveElements ?? selectorMap?.size ?? 0}`);
  if (hasModal) lines.push('STATE: active modal/dialog');
  if (hasDropdown) lines.push('STATE: open dropdown — click an option ref to commit');

  if (errors.length > 0) {
    lines.push('');
    lines.push(`ERRORS (${errors.length}):`);
    for (const e of errors.slice(0, 15)) {
      lines.push(`  [${e.ref}] ${e.text}`);
    }
    if (errors.length > 15) lines.push(`  …and ${errors.length - 15} more`);
  }

  if (fields.length > 0) {
    lines.push('');
    lines.push(`FIELDS (${fields.length}${requiredMissing.length ? `, ${requiredMissing.length} required missing` : ''}):`);
    // Prioritize required-missing and invalid first, then the rest.
    const sorted = [
      ...fields.filter((f) => requiredMissing.includes(f) || f.invalid),
      ...fields.filter((f) => !requiredMissing.includes(f) && !f.invalid),
    ];
    for (const f of sorted.slice(0, 40)) {
      lines.push(formatField(f));
    }
    if (fields.length > 40) lines.push(`  …and ${fields.length - 40} more fields (call read_page mode=full for the rest)`);
  }

  if (buttons.length > 0) {
    lines.push('');
    lines.push(`BUTTONS (${buttons.length}):`);
    // Prioritize submitish buttons at top so the agent can see save/continue state.
    const sortedBtns = [
      ...submitButtons,
      ...buttons.filter((b) => !submitButtons.includes(b)),
    ];
    for (const b of sortedBtns.slice(0, 25)) {
      lines.push(formatButton(b));
    }
    if (buttons.length > 25) lines.push(`  …and ${buttons.length - 25} more buttons`);
  }

  const blocker = detectBlocker({ fields, buttons, errors, hasModal });
  if (blocker) {
    lines.push('');
    lines.push(`BLOCKER: ${blocker}`);
  }

  lines.push('');
  lines.push('NEXT SAFE ACTIONS:');
  if (hasModal) {
    lines.push('  - Read or dismiss the open modal before anything else.');
  } else if (hasDropdown) {
    lines.push('  - Click one of the option refs in the open dropdown to commit the selection.');
  } else if (requiredMissing.length > 0) {
    lines.push(`  - Fill required field(s): ${requiredMissing.slice(0, 3).map((f) => `[${f.ref}] "${f.label || f.ref}"`).join(', ')}`);
  } else if (submitButtons.length > 0) {
    const enabled = submitButtons.find((b) => !b.disabled);
    if (enabled) lines.push(`  - Click [${enabled.ref}] "${enabled.label}" to advance.`);
    else lines.push(`  - Resolve the blocker above; submit buttons are disabled.`);
  } else {
    lines.push('  - No required field gaps detected — verify with verify_action or call read_page mode=actions.');
  }
  lines.push('  - For the full DOM tree (rare), call read_page mode=full.');
  lines.push('  - For just the validation errors, call read_page mode=errors.');

  return lines.join('\n');
}

/** Build the actions-only mode: only refs, tags, labels, and state. No tree noise. */
export function buildActionsOnly({ selectorMap, stats, url, fingerprint }) {
  const { fields, buttons } = bucketize(selectorMap);
  const lines = [];
  lines.push(`URL: ${url}`);
  if (fingerprint) lines.push(`FINGERPRINT: ${fingerprint}`);
  lines.push(`INTERACTIVE: ${stats?.interactiveElements ?? selectorMap?.size ?? 0}`);
  lines.push('');
  if (fields.length > 0) {
    lines.push(`FIELDS (${fields.length}):`);
    for (const f of fields) lines.push(formatField(f));
    lines.push('');
  }
  if (buttons.length > 0) {
    lines.push(`BUTTONS (${buttons.length}):`);
    for (const b of buttons) lines.push(formatButton(b));
  }
  return lines.join('\n');
}

/** Build the errors-only mode. */
export function buildErrorsOnly({ selectorMap, domText, url }) {
  const { fields, errors } = bucketize(selectorMap);
  const lines = [];
  lines.push(`URL: ${url}`);
  if (errors.length === 0) {
    lines.push('No validation errors detected on this page.');
    if (detectModal(domText)) lines.push('Note: a modal/dialog is open — call read_page mode=full to inspect it.');
    return lines.join('\n');
  }
  lines.push(`ERRORS (${errors.length}):`);
  for (const e of errors) lines.push(`  [${e.ref}] ${e.text}`);
  const invalidFields = fields.filter((f) => f.invalid);
  if (invalidFields.length > 0) {
    lines.push('');
    lines.push(`INVALID FIELDS (${invalidFields.length}):`);
    for (const f of invalidFields) lines.push(formatField(f));
  }
  return lines.join('\n');
}

/** Build the form-summary mode: required field status and submit-button state. */
export function buildFormSummary({ selectorMap, domText, url, fingerprint }) {
  const { fields, buttons, errors } = bucketize(selectorMap);
  const required = fields.filter((f) => f.required && !f.disabled);
  const missing = required.filter((f) => !f.value && f.checked !== 'checked');
  const filled = required.filter((f) => f.value || f.checked === 'checked');
  const submitButtons = buttons.filter((b) => isSubmitishLabel(b.label));

  const lines = [];
  lines.push(`URL: ${url}`);
  if (fingerprint) lines.push(`FINGERPRINT: ${fingerprint}`);
  lines.push(`REQUIRED: ${required.length} | FILLED: ${filled.length} | MISSING: ${missing.length} | ERRORS: ${errors.length}`);
  if (missing.length > 0) {
    lines.push('');
    lines.push(`MISSING REQUIRED (${missing.length}):`);
    for (const f of missing) lines.push(formatField(f));
  }
  if (errors.length > 0) {
    lines.push('');
    lines.push(`ERRORS (${errors.length}):`);
    for (const e of errors.slice(0, 10)) lines.push(`  [${e.ref}] ${e.text}`);
  }
  if (submitButtons.length > 0) {
    lines.push('');
    lines.push('SUBMIT BUTTONS:');
    for (const b of submitButtons) lines.push(formatButton(b));
  }
  const blocker = detectBlocker({ fields, buttons, errors, hasModal: detectModal(domText) });
  if (blocker) {
    lines.push('');
    lines.push(`BLOCKER: ${blocker}`);
  }
  return lines.join('\n');
}

// Re-export helpers used by tests / other modules.
export { bucketize, detectBlocker };
