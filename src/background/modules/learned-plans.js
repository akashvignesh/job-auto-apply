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
export async function upsertPlanForPage({ domain, fingerprint, steps, startUrl, modelVersion, taskKind }) {
  if (!domain || !fingerprint || !Array.isArray(steps) || steps.length === 0) return;
  try {
    const db = await openDb();
    const store = tx(db, 'readwrite');
    const existing = await asPromise(store.get(fingerprint));
    const now = Date.now();
    const dom = domain.toLowerCase();

    if (!existing) {
      const row = {
        key: fingerprint,
        formFingerprint: fingerprint,
        originDomains: [dom],
        plan: steps.map((s) => _seedStepWithVariant(s, dom)),
        taskKind: taskKind || 'generic',
        modelVersion: modelVersion || 'unknown',
        successCount: 1,
        firstSuccessAt: now,
        lastSuccessAt: now,
        exemplarUrl: startUrl || '',
      };
      await asPromise(store.put(row));
    } else {
      // Additive merge — never destructive. The original site's variants
      // remain even when the new origin's recording differs slightly.
      const originDomains = Array.isArray(existing.originDomains) ? existing.originDomains.slice() : [];
      if (!originDomains.includes(dom)) originDomains.push(dom);
      const mergedPlan = mergeStepLists(existing.plan || [], steps, dom);
      const row = {
        ...existing,
        originDomains,
        plan: mergedPlan,
        taskKind: existing.taskKind || taskKind || 'generic',
        modelVersion: modelVersion || existing.modelVersion || 'unknown',
        successCount: (existing.successCount || 0) + 1,
        lastSuccessAt: now,
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
  if (!row || !Array.isArray(row.plan) || row.plan.length === 0) return '';
  const lines = row.plan.map((step, i) => {
    const valueHint = step.valueKind
      ? ` value=<${step.valueKind}>`
      : (step.value != null ? ` value="${truncate(step.value, 40)}"` : '');
    const labelPart = step.label ? ` label="${truncate(step.label, 60)}"` : '';
    const rolePart = step.role ? ` role=${step.role}` : '';
    const variants = Array.isArray(step.variants) ? step.variants : [];
    const altCount = Math.max(0, variants.length - 1);
    const altNote = altCount > 0 ? ` (+${altCount} variant${altCount === 1 ? '' : 's'})` : '';
    const actionPart = step.action ? `[${step.action}]` : '';
    return `${i + 1}. ${step.tool}${actionPart}${labelPart}${rolePart}${valueHint}${altNote}`;
  });
  const origins = Array.isArray(row.originDomains) ? row.originDomains.join(',') : (row.domain || '');
  const meta = `origins=${origins} successes=${row.successCount} kind=${row.taskKind || 'generic'}`;
  return `${meta}\n${lines.join('\n')}`;
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
