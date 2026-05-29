/**
 * Form fingerprint — a stable short hash that says "this page is structurally the
 * same form I've seen before." Used by the learned-plans system (Phase A of the
 * Webwright-inspired plan) to look up a previously successful action sequence
 * for an equivalent form on a different tenant or session.
 *
 * Design rationale:
 *   The agent re-derives the same Workday/Greenhouse/Lever flow on every fresh
 *   run because nothing carries forward. The fingerprint is the lookup key.
 *
 *   We hash the *labels of visible interactive fields in DOM order* — not refs,
 *   not coordinates, not tenant URLs. Two Workday tenants (Medtronic and
 *   Boeing) render the same "My Experience" form with the same field labels;
 *   their fingerprints match and the learned plan replays.
 *
 *   Stop-words and value text are excluded so that pre-filled values (a Boeing
 *   address vs a Medtronic address) don't fragment the cache.
 */

const STOP_WORDS = new Set([
  'the', 'and', 'or', 'of', 'to', 'a', 'an', 'in', 'on', 'for', 'with',
  'is', 'are', 'this', 'that', 'as', 'by', 'at', 'be', 'optional', 'required',
]);

// Roles we consider "interactive form field" for fingerprinting purposes.
// Mirrors the spirit of INTERACTIVE_ROLES in serializer.js but trimmed to the
// label-bearing controls — a fingerprint built from these is stable across
// tenants whose buttons and links differ but whose form structure does not.
const FIELD_ROLES = new Set([
  'textbox', 'combobox', 'listbox', 'spinbutton',
  'checkbox', 'radio', 'switch',
  'menuitem', 'option',
]);
const FIELD_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function normalizeLabel(raw) {
  if (!raw) return '';
  return String(raw)
    .toLowerCase()
    .replace(/[*:]+$/g, '')              // trailing required markers / colons
    .replace(/\s+/g, ' ')
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .trim();
}

function bestLabelFor(node) {
  // Prefer AX-tree name (the real accessible label), then aria-label,
  // then placeholder, then HTML <label for> mapping (already resolved
  // by the AX tree in this codebase). NEVER fall back to value — values
  // are user-specific and would fragment the fingerprint.
  const ax = node?.axNode;
  if (ax?.name) return ax.name;
  const attrs = node?.attributes || {};
  if (attrs['aria-label']) return attrs['aria-label'];
  if (attrs['placeholder']) return attrs['placeholder'];
  if (attrs['title']) return attrs['title'];
  return '';
}

function isFormField(node) {
  if (!node || node.nodeType !== 1) return false;
  if (!node.isVisible && (node.nodeName || '').toUpperCase() !== 'INPUT') return false;
  const tag = (node.nodeName || '').toUpperCase();
  if (FIELD_TAGS.has(tag)) return true;
  const role = node.attributes?.role || node.axNode?.role;
  return role ? FIELD_ROLES.has(role) : false;
}

/**
 * Walk a domTree (the same shape `serializeDomTree` accepts) collecting normalized
 * labels of form fields in document order. Returns the canonical string used as
 * fingerprint input — exposed for tests and debugging.
 */
export function fieldLabelSequence(root) {
  const labels = [];
  const visit = (node) => {
    if (!node) return;
    if (isFormField(node)) {
      const norm = normalizeLabel(bestLabelFor(node));
      if (norm) {
        const tokens = norm.split(' ').filter(w => w.length >= 2 && !STOP_WORDS.has(w));
        if (tokens.length > 0) labels.push(tokens.join(' '));
      }
    }
    const kids = node.children || [];
    for (const k of kids) visit(k);
    const roots = node.shadowRoots || [];
    for (const r of roots) visit(r);
    if (node.contentDocument) visit(node.contentDocument);
  };
  visit(root);
  return labels.join('|');
}

async function sha1Hex(text) {
  // Web Crypto is available in the service worker. Fallback path is unreachable
  // in MV3 but kept defensive in case the module is reused outside extension context.
  if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // Cheap non-crypto fallback (FNV-1a 32-bit, repeated for length). Collisions
  // here only fragment the learned-plan cache, never corrupt page state.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0').repeat(5).slice(0, 40);
}

/**
 * Produce a 16-char hex fingerprint for the visible form on a page.
 *
 * @param {Object} root - The DOM tree root accepted by serializeDomTree.
 * @returns {Promise<{fingerprint: string, fieldCount: number, sample: string}>}
 *   fingerprint: 16-char hex (truncated SHA-1); empty string if no fields found
 *   fieldCount:  number of label-bearing fields included
 *   sample:      the first ~120 chars of the canonical sequence (for debug logs)
 */
export async function fingerprintForm(root) {
  const seq = fieldLabelSequence(root);
  return fingerprintFromSequence(seq);
}

/**
 * Hash an already-computed canonical field sequence. Exposed separately so the
 * DOM walk and the hash can happen in different places: the walk is synchronous
 * inside processCdpData (where the tree is in scope), the hash runs later in
 * the read-page-core handler where we can await crypto.subtle.
 *
 * @param {string} seq - canonical "|"-joined field-label sequence
 */
export async function fingerprintFromSequence(seq) {
  if (!seq) return { fingerprint: '', fieldCount: 0, sample: '' };
  const full = await sha1Hex(seq);
  return {
    fingerprint: full.slice(0, 16),
    fieldCount: seq.split('|').length,
    sample: seq.length > 120 ? seq.slice(0, 117) + '...' : seq,
  };
}
