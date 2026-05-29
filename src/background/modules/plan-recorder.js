/**
 * Plan recorder — collects symbolic steps from successful tool calls during a
 * task. On task completion (success), the resulting plan is persisted via
 * learned-plans.js, keyed by (domain, formFingerprint), so the next run on a
 * structurally similar form can replay it instead of re-deriving from scratch.
 *
 * Why symbolic, not raw?
 *   A raw `{tool: 'form_input', ref: 9359, value: 'Akash Sureshkumar'}` is
 *   useless on the next run — refs change per page load, and the user's name
 *   would be inappropriate to write into a learned plan that other users may
 *   trigger. Instead we store `{tool, valueKind: 'profile.fullName'}`, and
 *   the replay-time injection tells the LLM "fill the field labeled X with
 *   the profile's full name."
 *
 *   We deliberately do not try to fully resolve labels here. The injected
 *   plan acts as a trajectory hint; the LLM still confirms each step against
 *   the live DOM via read_page and adapts when the page diverges. The label
 *   field is best-effort, filled from `refMeta` when the caller provides it.
 */

/**
 * Per-tab recording state. Chunked: a Workday application that visits 6 pages
 * produces 6 chunks, each persisted as its own (domain, fingerprint) row.
 *
 *   tabId → {
 *     chunks: [
 *       { startUrl, fingerprint, hostname, steps: [...] },
 *       ...
 *     ],
 *   }
 *
 * A new chunk is opened whenever the agent records a step on a URL whose
 * pathname differs from the current chunk's `startUrl`, OR when a fresh
 * fingerprint is observed mid-page (multi-step wizard advance without
 * navigation, common on Workday).
 */
const _recordings = new Map();

function _ensure(tabId) {
  let st = _recordings.get(tabId);
  if (!st) {
    st = { chunks: [] };
    _recordings.set(tabId, st);
  }
  return st;
}

function _samePath(a, b) {
  if (!a || !b) return false;
  try {
    return new URL(a).pathname === new URL(b).pathname;
  } catch {
    return a === b;
  }
}

function _currentChunk(state) {
  return state.chunks.length > 0 ? state.chunks[state.chunks.length - 1] : null;
}

/**
 * Reset recording for a tab. Called at the start of every task.
 */
export function resetRecording(tabId) {
  if (tabId == null) return;
  _recordings.set(tabId, { chunks: [] });
}

/**
 * Append a successful tool call to the per-tab recording.
 *
 * The caller (service-worker dispatch loop) must supply the live URL and
 * (optionally) the live fingerprint so the recorder can split chunks at
 * page boundaries. Passing them as a separate `ctx` keeps the existing
 * `step` shape symbolic and free of tab metadata.
 *
 * @param {number} tabId
 * @param {Object} step  — { tool, action?, label?, role?, value?, valueKind? }
 * @param {Object} [ctx] — { url?, fingerprint? }
 */
export function recordStep(tabId, step, ctx = {}) {
  if (tabId == null || !step || !step.tool) return;

  // Drop noisy steps that won't help a future run. We exit BEFORE opening a
  // chunk so a sea of scrolls doesn't start a phantom page chunk.
  if (step.tool === 'computer' && (step.action === 'scroll' || step.action === 'wait')) return;

  const state = _ensure(tabId);
  let cur = _currentChunk(state);

  const url = ctx.url || '';
  const fingerprint = ctx.fingerprint || '';
  let hostname = '';
  if (url) {
    try { hostname = new URL(url).hostname.toLowerCase(); } catch { /* empty */ }
  }

  // Open a new chunk when either:
  //   (a) no chunk exists yet, OR
  //   (b) the URL path changed (wizard advanced via navigation), OR
  //   (c) a fingerprint exists and differs from the chunk's (wizard advanced
  //       in place — the SPA replaced the form without changing the URL).
  const needNewChunk = !cur
    || (url && cur.startUrl && !_samePath(url, cur.startUrl))
    || (fingerprint && cur.fingerprint && fingerprint !== cur.fingerprint);

  if (needNewChunk) {
    cur = {
      startUrl: url || (cur && cur.startUrl) || '',
      hostname: hostname || (cur && cur.hostname) || '',
      fingerprint: fingerprint || '',
      steps: [],
    };
    state.chunks.push(cur);
  } else {
    // Fill in fingerprint as soon as one is observed; the first step on a page
    // may record before read_page has set the fingerprint.
    if (!cur.fingerprint && fingerprint) cur.fingerprint = fingerprint;
    if (!cur.startUrl && url) cur.startUrl = url;
    if (!cur.hostname && hostname) cur.hostname = hostname;
  }

  cur.steps.push(step);
}

/**
 * Return chunks suitable for persistence. Each chunk → one IDB row keyed by
 * (domain, fingerprint). Chunks without a fingerprint (rare: the page never
 * got a successful read_page) are filtered out — they can't be looked up
 * later anyway.
 */
export function getChunks(tabId) {
  const state = _recordings.get(tabId);
  if (!state) return [];
  return state.chunks
    .filter(c => c.fingerprint && c.hostname && c.steps.length > 0)
    .map(c => ({
      domain: c.hostname,
      fingerprint: c.fingerprint,
      startUrl: c.startUrl,
      steps: c.steps.slice(),
    }));
}

/**
 * Legacy flat-array accessor — kept for callers that still need a single
 * unified view of all steps recorded during the task (debug logs, etc.).
 */
export function getRecording(tabId) {
  const state = _recordings.get(tabId);
  if (!state) return [];
  const flat = [];
  for (const c of state.chunks) flat.push(...c.steps);
  return flat;
}

/**
 * Heuristic classification of a literal value against the user's profile.
 * Returns a stable symbolic identifier (e.g. "profile.email", "today.date")
 * when a match is found, or null to indicate the literal should be kept.
 *
 * Match is case-insensitive and tolerates whitespace differences.
 *
 * @param {string} value
 * @param {Object} [profile] — flattened profile, e.g. { email, fullName, phone, address, … }
 * @returns {string|null}
 */
export function classifyValueKind(value, profile) {
  if (value == null || value === '') return null;
  const v = String(value).trim();
  if (!v) return null;

  // Date heuristics first — they short-circuit profile lookup since profiles
  // never legitimately contain "today's date" as a static value.
  if (isToday(v)) return 'today.date';

  if (profile && typeof profile === 'object') {
    const lc = v.toLowerCase();
    for (const [key, raw] of Object.entries(flattenProfile(profile))) {
      if (!raw) continue;
      const r = String(raw).trim().toLowerCase();
      if (!r || r.length < 2) continue;
      if (r === lc) return `profile.${key}`;
    }
  }

  // Common Yes/No answers — encode as a literal but mark as "answer" so the
  // injected plan reads naturally: "answer Yes" instead of "literal Yes".
  if (/^(yes|no)$/i.test(v)) return null; // keep literal; semantic is clear from value

  return null;
}

function flattenProfile(profile, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(profile || {})) {
    if (v == null) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'object' && !Array.isArray(v)) {
      flattenProfile(v, key, out);
    } else {
      out[key] = v;
    }
  }
  return out;
}

function isToday(v) {
  // Recognize MM/DD/YYYY and YYYY-MM-DD forms matching today's local date.
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const yyyy = String(now.getFullYear());
  const forms = [
    `${mm}/${dd}/${yyyy}`, `${Number(mm)}/${Number(dd)}/${yyyy}`,
    `${yyyy}-${mm}-${dd}`,
  ];
  return forms.includes(v);
}

/**
 * Build a step from a successful tool dispatch. Pure function — the caller
 * (service-worker dispatch loop) decides whether to actually record it.
 *
 * @param {Object} toolUse — {name, input}
 * @param {Object} [profile] — user profile for value classification
 * @param {Object} [refMeta] — optional ref→{label, role} cache populated by the
 *                              serializer; used to enrich the recorded step
 * @returns {Object|null} step suitable for recordStep(), or null to skip
 */
export function stepFromToolCall(toolUse, profile, refMeta) {
  if (!toolUse || !toolUse.name || !toolUse.input) return null;
  const meta = (refMeta && toolUse.input.ref != null)
    ? (refMeta.get ? refMeta.get(String(toolUse.input.ref)) : refMeta[String(toolUse.input.ref)])
    : null;

  switch (toolUse.name) {
    case 'form_input': {
      const valueKind = classifyValueKind(toolUse.input.value, profile);
      return {
        tool: 'form_input',
        label: meta?.label || '',
        role: meta?.role || '',
        ...(valueKind ? { valueKind } : { value: String(toolUse.input.value ?? '') }),
      };
    }
    case 'file_upload': {
      // File path can leak local-FS structure; keep just the basename and mark
      // it as a profile artefact so a different user's plan replays with their
      // resume rather than ours.
      const path = String(toolUse.input.filePath || toolUse.input.file_path || '');
      const basename = path.split(/[\\/]/).pop() || '';
      return {
        tool: 'file_upload',
        label: meta?.label || '',
        valueKind: /resume|cv/i.test(basename) ? 'profile.resume' : 'profile.attachment',
      };
    }
    case 'computer': {
      const action = toolUse.input.action;
      if (action !== 'left_click' && action !== 'right_click' && action !== 'double_click') {
        return null;
      }
      // Coordinate clicks aren't replayable on another tenant — skip them so a
      // future run doesn't get nudged toward (965, 183) by mistake.
      if (toolUse.input.coordinate && !toolUse.input.ref) return null;
      return {
        tool: 'click',
        action,
        label: meta?.label || '',
        role: meta?.role || '',
      };
    }
    case 'navigate': {
      const url = String(toolUse.input.url || '');
      // Only persist navigations that are likely to repeat on a similar form
      // — same-origin transitions are interesting (next step of a wizard),
      // outbound search/listing navigations are not.
      return { tool: 'navigate', url };
    }
    default:
      return null;
  }
}
