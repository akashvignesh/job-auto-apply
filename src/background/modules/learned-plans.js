/**
 * Learned-plans store — IndexedDB CRUD for action sequences recorded from
 * successful runs. Phase A of the Webwright-inspired plan: instead of letting
 * the LLM re-derive a Workday application flow on every fresh run, we persist
 * the symbolic step sequence keyed by form fingerprint and inject it into the
 * next session's system prompt.
 *
 * Schema v2 (one row per PAGE, additive across tenants)
 * -----------------------------------------------------
 * The lookup key is the form fingerprint ALONE. Multiple ATS tenants whose
 * "My Experience" page renders identical field labels share one row — the
 * tenant hostnames accumulate in `originDomains[]`. A successful run on
 * Boeing whose form matches a fingerprint Medtronic already produced just
 * adds Boeing to the row's origins and merges any novel step variants.
 *
 * Each step is a small dictionary describing what the agent did, and a
 * `variants[]` array of selector hints — the original Medtronic detection
 * AND the Boeing variant both live there as fallbacks. Never delete a
 * variant: the original site may still need it.
 *
 *   {
 *     key,                        // = formFingerprint
 *     formFingerprint: 'a3f1...',
 *     originDomains: ['medtronic.wd1...', 'boeing.wd1...'],
 *     plan: [
 *       { tool, label, role, valueKind?, value?,
 *         variants: [{selectorHint?, firstSeenOn, successCount}] },
 *       ...
 *     ],
 *     taskKind, modelVersion,
 *     successCount, firstSuccessAt, lastSuccessAt,
 *     exemplarUrl,                // a URL we last saw this fingerprint on
 *   }
 *
 * Storage caps: 200 rows, LRU-evicted by `lastSuccessAt`.
 */

import { compactSteps } from './plan-recorder.js';

const DB_NAME = 'hanzi-learned-plans';
const DB_VERSION = 2;
const STORE_NAME = 'plans';
const MAX_ROWS = 200;

let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const oldVersion = ev.oldVersion || 0;
      // v1 → v2: schema changed from (domain, fingerprint) → (fingerprint
      // alone, originDomains array). Pre-launch, no real users have v1 data
      // worth preserving, so we drop and recreate the store. This is safe
      // because savePlan / getPlan / getMostRecentPlanForDomain were never
      // wired to a production code path that returned success.
      if (oldVersion < 2 && db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
      }
      const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      // multiEntry index so a row with N origins is findable by ANY of them.
      // Required for getMostRecentPlanForDomain to keep working under v2.
      store.createIndex('originDomains', 'originDomains', { unique: false, multiEntry: true });
      store.createIndex('lastSuccessAt', 'lastSuccessAt', { unique: false });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  });
  return _dbPromise;
}

function tx(db, mode) {
  return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

function asPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Exact-fingerprint lookup. This is the PRIMARY lookup path — when the live
 * page matches a recorded form, we get the exact per-page plan.
 *
 * @param {string} formFingerprint
 * @returns {Promise<Object|null>}
 */
export async function getPlanByFingerprint(formFingerprint) {
  if (!formFingerprint) return null;
  try {
    const db = await openDb();
    const row = await asPromise(tx(db, 'readonly').get(formFingerprint));
    return row || null;
  } catch {
    return null;
  }
}

/**
 * Soft fallback: the most-recently-successful plan whose `originDomains[]`
 * includes the given hostname. Used as a fingerprint-unknown fallback at
 * task start (before any `read_page` has fired). Subject to the
 * relevance-gate filter applied by the service-worker caller.
 *
 * @param {string} domain
 * @returns {Promise<Object|null>}
 */
export async function getMostRecentPlanForDomain(domain) {
  if (!domain) return null;
  try {
    const db = await openDb();
    const idx = tx(db, 'readonly').index('originDomains');
    const rows = await asPromise(idx.getAll(domain.toLowerCase()));
    if (!rows || rows.length === 0) return null;
    rows.sort((a, b) => (b.lastSuccessAt || 0) - (a.lastSuccessAt || 0));
    return rows[0];
  } catch {
    return null;
  }
}

/**
 * Return a small ranked set of plans for a host. This keeps soft-domain
 * prompt injection bounded while still exposing alternatives when the current
 * page has not produced a fingerprint yet.
 *
 * @param {string} domain
 * @param {{pathname?: string, taskText?: string, limit?: number}} [opts]
 * @returns {Promise<Array<Object>>}
 */
export async function getRelevantPlansForDomain(domain, opts = {}) {
  if (!domain) return [];
  try {
    const db = await openDb();
    const idx = tx(db, 'readonly').index('originDomains');
    const rows = await asPromise(idx.getAll(domain.toLowerCase()));
    if (!rows || rows.length === 0) return [];

    const pathTerms = tokenize(`${opts.pathname || ''} ${opts.taskText || ''}`);
    const scored = rows.map(row => {
      const haystack = tokenize([
        row.exemplarUrl || '',
        row.taskKind || '',
        ...(Array.isArray(row.plan) ? row.plan.map(s => `${s.label || ''} ${s.role || ''} ${s.tool || ''}`) : []),
      ].join(' '));
      let overlap = 0;
      for (const term of pathTerms) {
        if (haystack.has(term)) overlap++;
      }
      return {
        row,
        score: (row.status === 'verified' ? 100000 : 0)
          + (overlap * 1000)
          + ((row.successCount || 0) * 100)
          + ((row.draftCount || 0) * 10)
          + Math.floor(Math.max(row.lastSuccessAt || 0, row.lastDraftAt || 0) / 86400000),
      };
    });

    scored.sort((a, b) => b.score - a.score || (b.row.lastSuccessAt || 0) - (a.row.lastSuccessAt || 0));
    return scored.slice(0, Math.max(1, Math.min(Number(opts.limit) || 5, 5))).map(s => s.row);
  } catch {
    return [];
  }
}

/**
 * UPSERT-and-merge a per-page plan.
 *
 * Behavior:
 *   - No row for this fingerprint → create one with single-origin domain
 *     and step list (each step seeded with one variant from this origin).
 *   - Row exists → ADD `domain` to `originDomains` if not present, MERGE
 *     `steps` (equal-by-symbolic-key → bump variant successCount and add
 *     the new origin to its variant list; novel steps → append), bump
 *     `successCount`, refresh `lastSuccessAt`, refresh `exemplarUrl`.
 *
 * @param {Object} params
 * @param {string} params.domain         hostname of THIS run's site
 * @param {string} params.fingerprint    page fingerprint
 * @param {Array<Object>} params.steps   step list from this run's chunk
 * @param {string} [params.startUrl]     URL where this page was first seen
 * @param {string} [params.modelVersion] model id
 * @param {string} [params.taskKind]     e.g. 'application'
 */
export async function upsertPlanForPage({ domain, fingerprint, steps, startUrl, modelVersion, taskKind, status = 'verified' }) {
  const cleanSteps = compactSteps(steps);
  if (!domain || !fingerprint || cleanSteps.length === 0) return;
  try {
    const db = await openDb();
    const store = tx(db, 'readwrite');
    const existing = await asPromise(store.get(fingerprint));
    const now = Date.now();
    const dom = domain.toLowerCase();
    const isVerified = status !== 'draft';

    if (!existing) {
      const row = {
        key: fingerprint,
        formFingerprint: fingerprint,
        originDomains: [dom],
        plan: cleanSteps.map((s) => _seedStepWithVariant(s, dom)),
        taskKind: taskKind || 'generic',
        modelVersion: modelVersion || 'unknown',
        status: isVerified ? 'verified' : 'draft',
        successCount: isVerified ? 1 : 0,
        draftCount: isVerified ? 0 : 1,
        firstSuccessAt: isVerified ? now : null,
        lastSuccessAt: isVerified ? now : 0,
        lastDraftAt: isVerified ? null : now,
        exemplarUrl: startUrl || '',
      };
      await asPromise(store.put(row));
    } else {
      // Additive merge — never destructive. The original site's variants
      // remain even when the new origin's recording differs slightly.
      const originDomains = Array.isArray(existing.originDomains) ? existing.originDomains.slice() : [];
      if (!originDomains.includes(dom)) originDomains.push(dom);
      const mergedPlan = mergeStepLists(existing.plan || [], cleanSteps, dom);
      const row = {
        ...existing,
        originDomains,
        plan: mergedPlan,
        taskKind: existing.taskKind || taskKind || 'generic',
        modelVersion: modelVersion || existing.modelVersion || 'unknown',
        status: isVerified ? 'verified' : (existing.status || 'draft'),
        successCount: isVerified ? (existing.successCount || 0) + 1 : (existing.successCount || 0),
        draftCount: isVerified ? (existing.draftCount || 0) : (existing.draftCount || 0) + 1,
        firstSuccessAt: isVerified ? (existing.firstSuccessAt || now) : (existing.firstSuccessAt || null),
        lastSuccessAt: isVerified ? now : (existing.lastSuccessAt || 0),
        lastDraftAt: isVerified ? (existing.lastDraftAt || null) : now,
        exemplarUrl: startUrl || existing.exemplarUrl || '',
      };
      await asPromise(store.put(row));
    }

    await trimIfNeeded();
  } catch (e) {
    if (typeof console !== 'undefined') {
      console.warn('[LearnedPlans] upsertPlanForPage failed:', e && e.message);
    }
  }
}

/**
 * Backwards-compat shim. Old callers (and the pre-chunk version of
 * service-worker.js) call savePlan with a single flat plan; map it onto
 * the new upsert. New code should call upsertPlanForPage directly.
 */
export async function savePlan({ domain, formFingerprint, plan, modelVersion, taskKind }) {
  return upsertPlanForPage({
    domain,
    fingerprint: formFingerprint,
    steps: plan,
    modelVersion,
    taskKind,
  });
}

export async function recordPlanFailure({ domain, fingerprint, step, error, startUrl, taskKind }) {
  if (!domain || !fingerprint || !step || !step.tool) return;
  try {
    const db = await openDb();
    const store = tx(db, 'readwrite');
    const existing = await asPromise(store.get(fingerprint));
    const now = Date.now();
    const dom = domain.toLowerCase();
    const failure = {
      tool: step.tool || '',
      action: step.action || '',
      label: step.label || '',
      role: step.role || '',
      selectorHint: step.selectorHint || step.refHint || '',
      valueKind: step.valueKind || '',
      value: step.value != null ? truncate(step.value, 80) : '',
      error: truncate(error || 'failed', 180),
      count: 1,
      lastFailedAt: now,
    };

    if (!existing) {
      await asPromise(store.put({
        key: fingerprint,
        formFingerprint: fingerprint,
        originDomains: [dom],
        plan: [],
        mistakes: [failure],
        taskKind: taskKind || 'generic',
        modelVersion: 'unknown',
        status: 'draft',
        successCount: 0,
        draftCount: 0,
        firstSuccessAt: null,
        lastSuccessAt: 0,
        lastDraftAt: null,
        exemplarUrl: startUrl || '',
      }));
    } else {
      const originDomains = Array.isArray(existing.originDomains) ? existing.originDomains.slice() : [];
      if (!originDomains.includes(dom)) originDomains.push(dom);
      await asPromise(store.put({
        ...existing,
        originDomains,
        mistakes: mergeMistakes(existing.mistakes || [], failure),
        taskKind: existing.taskKind || taskKind || 'generic',
        exemplarUrl: startUrl || existing.exemplarUrl || '',
      }));
    }
  } catch (e) {
    if (typeof console !== 'undefined') {
      console.warn('[LearnedPlans] recordPlanFailure failed:', e && e.message);
    }
  }
}

function mergeMistakes(oldMistakes, failure) {
  const sig = (m) => [
    m.tool || '',
    m.action || '',
    (m.label || '').toLowerCase(),
    m.role || '',
    m.selectorHint || '',
    m.valueKind || '',
    m.value || '',
  ].join('::');
  const result = oldMistakes.slice(-20).map(m => ({ ...m }));
  const idx = result.findIndex(m => sig(m) === sig(failure));
  if (idx >= 0) {
    result[idx].count = (result[idx].count || 1) + 1;
    result[idx].error = failure.error || result[idx].error;
    result[idx].lastFailedAt = failure.lastFailedAt;
  } else {
    result.push(failure);
  }
  return result.sort((a, b) => (b.lastFailedAt || 0) - (a.lastFailedAt || 0)).slice(0, 20);
}

function _seedStepWithVariant(step, origin) {
  // Hoist value/valueKind to the step root; selectorHint and origin live on
  // the variant. Future selector self-heal pulls from `variants[*].selectorHint`.
  const variant = {
    selectorHint: step.selectorHint || step.refHint || '',
    firstSeenOn: origin,
    successCount: 1,
  };
  const { selectorHint: _drop1, refHint: _drop2, ...stepCore } = step;
  return { ...stepCore, variants: [variant] };
}

/**
 * Merge `newSteps` into `oldSteps` additively.
 *   - Symbolic equality:  same `(tool, action?, label, role, valueKind || value)`.
 *   - Equal step → push a fresh variant or bump an existing one's successCount.
 *   - Novel step → append at end (preserves recorded order for new pages).
 *
 * Pure / side-effect-free. Exported for tests.
 */
export function mergeStepLists(oldSteps, newSteps, origin) {
  const result = oldSteps.map((s) => ({ ...s, variants: (s.variants || []).slice() }));
  const sigOf = (s) => [
    s.tool || '',
    s.action || '',
    (s.label || '').toLowerCase(),
    s.role || '',
    s.valueKind || (s.value != null ? `lit:${String(s.value).toLowerCase()}` : ''),
  ].join('::');
  const indexBySig = new Map();
  result.forEach((s, i) => indexBySig.set(sigOf(s), i));

  for (const ns of newSteps) {
    const sig = sigOf(ns);
    const idx = indexBySig.get(sig);
    if (idx != null) {
      const tgt = result[idx];
      const newSelectorHint = ns.selectorHint || ns.refHint || '';
      const existing = tgt.variants.find((v) => (v.selectorHint || '') === newSelectorHint);
      if (existing) {
        existing.successCount = (existing.successCount || 0) + 1;
      } else {
        tgt.variants.push({ selectorHint: newSelectorHint, firstSeenOn: origin, successCount: 1 });
      }
    } else {
      const seeded = _seedStepWithVariant(ns, origin);
      result.push(seeded);
      indexBySig.set(sig, result.length - 1);
    }
  }
  return result;
}

async function trimIfNeeded() {
  try {
    const db = await openDb();
    const store = tx(db, 'readwrite');
    const count = await asPromise(store.count());
    if (count <= MAX_ROWS) return;
    const idx = store.index('lastSuccessAt');
    const cursorReq = idx.openCursor();
    let toDelete = count - MAX_ROWS;
    await new Promise((resolve, reject) => {
      cursorReq.onsuccess = () => {
        const cur = cursorReq.result;
        if (!cur || toDelete <= 0) { resolve(); return; }
        cur.delete();
        toDelete--;
        cur.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  } catch {
    // best-effort cleanup
  }
}

/**
 * Delete a plan (for testing / "forget this site" UX).
 */
export async function deletePlan(formFingerprint) {
  if (!formFingerprint) return;
  try {
    const db = await openDb();
    await asPromise(tx(db, 'readwrite').delete(formFingerprint));
  } catch {
    // ignored
  }
}

/**
 * List all stored plans (for debugging UI).
 */
export async function listAllPlans() {
  try {
    const db = await openDb();
    const rows = await asPromise(tx(db, 'readonly').getAll());
    return rows || [];
  } catch {
    return [];
  }
}

/**
 * Render a learned plan as a compact human/LLM-readable block. Each step
 * shows its primary variant's selector hint; secondary variants are
 * summarized inline so the agent knows fallbacks exist.
 *
 * @param {Object} row - plan row from getPlanByFingerprint / getMostRecentPlanForDomain
 * @returns {string}
 */
export function renderPlanForPrompt(row) {
  if (!row) return '';
  const plan = Array.isArray(row.plan) ? row.plan : [];
  const mistakes = Array.isArray(row.mistakes) ? row.mistakes : [];
  if (plan.length === 0 && mistakes.length === 0) return '';

  const lines = plan.map((step, i) => {
    const valueHint = step.valueKind
      ? ` value=<${step.valueKind}>`
      : (step.value != null ? ` value="${truncate(step.value, 40)}"` : '');
    const labelPart = step.label ? ` label="${truncate(step.label, 60)}"` : '';
    const rolePart = step.role ? ` role=${step.role}` : '';
    const variants = Array.isArray(step.variants) ? step.variants : [];
    const primaryHint = variants[0]?.selectorHint ? ` selector="${truncate(variants[0].selectorHint, 80)}"` : '';
    const altCount = Math.max(0, variants.length - 1);
    const altNote = altCount > 0 ? ` (+${altCount} variant${altCount === 1 ? '' : 's'})` : '';
    const actionPart = step.action ? `[${step.action}]` : '';
    return `${i + 1}. ${step.tool}${actionPart}${labelPart}${rolePart}${valueHint}${primaryHint}${altNote}`;
  });
  const origins = Array.isArray(row.originDomains) ? row.originDomains.join(',') : (row.domain || '');
  const status = row.status || ((row.successCount || 0) > 0 ? 'verified' : 'draft');
  const meta = `status=${status} origins=${origins} successes=${row.successCount || 0} drafts=${row.draftCount || 0} kind=${row.taskKind || 'generic'}`;
  const out = [meta];
  if (lines.length > 0) {
    out.push(status === 'verified' ? 'WORKED STEPS:' : 'PARTIAL STEPS FROM UNFINISHED RUN - verify live page before using:');
    out.push(...lines);
  }
  if (mistakes.length > 0) {
    out.push('AVOID REPEATING THESE FAILED ACTIONS:');
    mistakes.slice(0, 8).forEach((m, i) => {
      const label = m.label ? ` label="${truncate(m.label, 60)}"` : '';
      const role = m.role ? ` role=${m.role}` : '';
      const selector = m.selectorHint ? ` selector="${truncate(m.selectorHint, 80)}"` : '';
      const action = m.action ? `[${m.action}]` : '';
      out.push(`${i + 1}. ${m.tool}${action}${label}${role}${selector} failed ${m.count || 1}x: ${truncate(m.error || 'unknown error', 120)}`);
    });
  }
  return out.join('\n');
}

function tokenize(text) {
  const set = new Set();
  String(text || '').toLowerCase().split(/[^a-z0-9]+/).forEach(t => {
    if (t.length >= 3) set.add(t);
  });
  return set;
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
