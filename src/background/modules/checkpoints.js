/**
 * Lightweight task checkpoints.
 *
 * Stores compact restart state in IndexedDB so a service-worker sleep, crash,
 * or browser restart does not lose the last good URL/task context. Rows expire
 * after 24 hours. This is not uninstall-proof storage; a native-host disk mirror
 * is required for that.
 */

const DB_NAME = 'hanzi-agent-checkpoints';
const DB_VERSION = 2;
const STORE_NAME = 'checkpoints';
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGES = 10;
const MAX_TEXT_CHARS = 12000;
const MAX_COMPLETED_PAGES = 20;

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
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'sessionKey' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
        store.createIndex('expiresAt', 'expiresAt', { unique: false });
      } else if (oldVersion < 2) {
        // v2 adds completedPages — no schema change needed, field added dynamically
      }
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

export function checkpointKey(sessionId, tabId) {
  return sessionId ? `mcp:${sessionId}` : `ui:${tabId || 'active'}`;
}

export async function saveCheckpoint({
  sessionKey,
  task,
  tabId,
  url,
  fingerprint,
  turn,
  messages,
  steps,
  startedAt,
  completedPages,
}) {
  if (!sessionKey) return;
  try {
    const now = Date.now();
    const db = await openDb();
    // Merge completedPages with any existing ones to avoid losing progress
    let mergedPages = completedPages || [];
    try {
      const existing = await asPromise(tx(db, 'readonly').get(sessionKey));
      if (existing?.completedPages?.length) {
        const fpSet = new Set(mergedPages.map(p => p.fingerprint));
        for (const p of existing.completedPages) {
          if (!fpSet.has(p.fingerprint)) mergedPages.push(p);
        }
      }
    } catch { /* ignore — first write */ }
    const row = {
      sessionKey,
      task: String(task || ''),
      tabId: tabId || null,
      url: url || '',
      fingerprint: fingerprint || '',
      turn: Number(turn) || 0,
      steps: Number(steps) || 0,
      messages: compactMessages(messages || []),
      startedAt: startedAt || null,
      updatedAt: now,
      expiresAt: now + TTL_MS,
      completedPages: mergedPages.slice(-MAX_COMPLETED_PAGES),
    };
    await asPromise(tx(db, 'readwrite').put(row));
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('[Checkpoints] save failed:', err?.message || err);
    }
  }
}

/**
 * Mark a form page as fully completed for this session.
 * Stored in completedPages[] so a restart can skip it without LLM re-filling.
 *
 * @param {string} sessionKey
 * @param {{ fingerprint: string, url: string, pageLabel?: string }} pageInfo
 */
export async function markPageComplete(sessionKey, pageInfo) {
  if (!sessionKey || !pageInfo?.fingerprint) return;
  try {
    const db = await openDb();
    const existing = await asPromise(tx(db, 'readonly').get(sessionKey));
    if (!existing) return;
    const pages = Array.isArray(existing.completedPages) ? existing.completedPages.slice() : [];
    if (!pages.some(p => p.fingerprint === pageInfo.fingerprint)) {
      pages.push({
        fingerprint: pageInfo.fingerprint,
        url: pageInfo.url || '',
        pageLabel: pageInfo.pageLabel || '',
        completedAt: Date.now(),
      });
    }
    await asPromise(tx(db, 'readwrite').put({
      ...existing,
      completedPages: pages.slice(-MAX_COMPLETED_PAGES),
      updatedAt: Date.now(),
    }));
  } catch {
    // best effort
  }
}

/**
 * Return the list of completed pages for a session.
 * Used at task start to inject skip-hints for already-finished form pages.
 *
 * @param {string} sessionKey
 * @returns {Promise<Array<{fingerprint:string, url:string, pageLabel:string, completedAt:number}>>}
 */
export async function getCompletedPages(sessionKey) {
  if (!sessionKey) return [];
  try {
    const row = await getCheckpoint(sessionKey);
    return Array.isArray(row?.completedPages) ? row.completedPages : [];
  } catch {
    return [];
  }
}

export async function getCheckpoint(sessionKey) {
  if (!sessionKey) return null;
  try {
    const db = await openDb();
    const row = await asPromise(tx(db, 'readonly').get(sessionKey));
    if (!row) return null;
    if ((row.expiresAt || 0) < Date.now()) {
      await deleteCheckpoint(sessionKey);
      return null;
    }
    return row;
  } catch {
    return null;
  }
}

export async function deleteCheckpoint(sessionKey) {
  if (!sessionKey) return;
  try {
    const db = await openDb();
    await asPromise(tx(db, 'readwrite').delete(sessionKey));
  } catch {
    // best effort
  }
}

export async function pruneExpiredCheckpoints() {
  try {
    const db = await openDb();
    const store = tx(db, 'readwrite');
    const idx = store.index('expiresAt');
    const range = IDBKeyRange.upperBound(Date.now());
    await new Promise((resolve, reject) => {
      const req = idx.openCursor(range);
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(); return; }
        cur.delete();
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    // best effort
  }
}

function compactMessages(messages) {
  return messages.slice(-MAX_MESSAGES).map(msg => {
    if (!Array.isArray(msg.content)) {
      return { ...msg, content: truncateText(msg.content) };
    }
    return {
      ...msg,
      content: msg.content.map(block => compactBlock(block)).filter(Boolean),
    };
  });
}

function compactBlock(block) {
  if (!block) return null;
  if (block.type === 'image') return { type: 'text', text: '[screenshot omitted from checkpoint]' };
  if (block.type === 'tool_result') {
    return {
      ...block,
      content: Array.isArray(block.content)
        ? block.content.map(compactBlock).filter(Boolean)
        : truncateText(block.content),
    };
  }
  if (block.type === 'text') return { ...block, text: truncateText(block.text) };
  if (block.type === 'tool_use') return block;
  return { ...block, text: truncateText(block.text || block.content || JSON.stringify(block)) };
}

function truncateText(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || '');
  return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS - 20) + '\n[truncated]' : text;
}
