/**
 * Phase B — Webwright-inspired "script" tools.
 *
 *   run_script:     batch N typed actions into a single LLM turn. The agent
 *                   plans (e.g.) 6 form_input + 1 click in one message instead
 *                   of 7 separate turns. We dispatch each action through the
 *                   existing tool handlers (form_input, computer, file_upload,
 *                   navigate) so all the battle-tested per-tool logic —
 *                   Workday multiselect detection, anti-bot mouse paths, file
 *                   dedup, etc. — is reused as-is. Crucially this is NOT a
 *                   Runtime.evaluate of free-form JS; the LLM only ever
 *                   names tools and inputs, so there is no isolated-world,
 *                   no fetch-disable, no page-side script-injection surface
 *                   area to defend.
 *
 *   verify_action:  poll for a single observable condition (URL change, text
 *                   appears, element disappears, modal appears) up to a small
 *                   timeout, returning ok/evidence. The agent calls this after
 *                   any submit/Save-and-Continue click to confirm the page
 *                   actually advanced — replacing a 5-20K-token read_page
 *                   round-trip with a ~50-byte boolean.
 *
 * Both tools intentionally skip read_page from inside batches: read_page
 * returns very large payloads and burying multiple reads inside one
 * tool-call makes the agent's view of the page lossy.
 */

import { cdpHelper } from '../modules/cdp-helper.js';
import { ensureDebugger, sendDebuggerCommand } from '../managers/debugger-manager.js';

// Tools allowed inside a run_script batch. Deliberately narrow:
//   - read_page / get_page_text / find: huge results, defeat the point of batching.
//   - javascript_tool: full eval — defeats the safety boundary.
//   - tabs_*: cross-tab confusion inside a single dispatch is hard to debug.
//   - update_plan / escalate / view_screenshot: control-plane tools.
const BATCHED_ALLOWED = new Set([
  'form_input',
  'computer',
  'file_upload',
  'navigate',
]);

const PER_ACTION_TIMEOUT_MS = 12000;
const BATCH_TIMEOUT_MS = 60000;
const MAX_BATCH_LEN = 12;

function withTimeout(promise, ms, label) {
  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutHandle));
}

/**
 * Strip noisy screenshot blobs and oversize strings from a sub-tool result so
 * the LLM gets a compact line per action. The full state is captured one turn
 * later via read_page; nobody needs a base64 JPEG inside a batch row.
 */
function compact(result) {
  if (!result) return result;
  if (typeof result === 'string') {
    return result.length > 1000 ? result.slice(0, 997) + '...' : result;
  }
  if (typeof result === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(result)) {
      if (k === 'base64Image') continue;
      if (k === 'screenshot') continue;
      if (typeof v === 'string' && v.length > 1000) {
        out[k] = v.slice(0, 997) + '...';
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  return result;
}

/**
 * run_script — execute a typed action batch.
 *
 * @param {Object} input
 * @param {Array<{tool: string, input: Object}>} input.actions
 * @param {boolean} [input.stopOnError=false]
 * @param {Object} deps - { executeTool, sessionTabGroupId, mcpSession, askBeforeActing }
 *   executeTool is the same dispatcher service-worker.js uses internally; we
 *   require it via deps to avoid an import cycle.
 */
export async function handleRunScript(input, deps = {}) {
  const actions = Array.isArray(input?.actions) ? input.actions : null;
  const stopOnError = input?.stopOnError === true;

  if (!actions || actions.length === 0) {
    return { error: 'run_script: `actions` must be a non-empty array of {tool, input} objects.' };
  }
  if (actions.length > MAX_BATCH_LEN) {
    return { error: `run_script: batch too large (${actions.length} actions, max ${MAX_BATCH_LEN}). Split into smaller batches.` };
  }
  const { executeTool, sessionTabGroupId, mcpSession, askBeforeActing } = deps;
  if (typeof executeTool !== 'function') {
    return { error: 'run_script: executeTool dependency missing (internal wiring bug).' };
  }

  const results = [];
  let okCount = 0;
  let failCount = 0;
  const overallStart = Date.now();

  for (let i = 0; i < actions.length; i++) {
    if (Date.now() - overallStart > BATCH_TIMEOUT_MS) {
      results.push({
        index: i,
        tool: actions[i]?.tool || '?',
        skipped: true,
        error: 'Batch budget exhausted before this action could run.',
      });
      failCount++;
      continue;
    }

    const a = actions[i];
    const tool = a?.tool;
    const innerInput = a?.input;

    if (!tool || typeof tool !== 'string') {
      results.push({ index: i, tool: '?', success: false, error: 'Missing `tool` field.' });
      failCount++;
      if (stopOnError) break;
      continue;
    }
    if (!BATCHED_ALLOWED.has(tool)) {
      results.push({
        index: i,
        tool,
        success: false,
        error: `Tool "${tool}" is not allowed inside run_script. Allowed: ${[...BATCHED_ALLOWED].join(', ')}. Use the tool directly outside the batch.`,
      });
      failCount++;
      if (stopOnError) break;
      continue;
    }
    if (innerInput == null || typeof innerInput !== 'object') {
      results.push({ index: i, tool, success: false, error: 'Missing or non-object `input` field.' });
      failCount++;
      if (stopOnError) break;
      continue;
    }

    const startedAt = Date.now();
    try {
      const result = await withTimeout(
        executeTool(tool, innerInput, sessionTabGroupId, mcpSession, {
          askBeforeActing: !!askBeforeActing,
          planScopeId: null,
        }),
        PER_ACTION_TIMEOUT_MS,
        `run_script[${i}] (${tool})`,
      );
      const compacted = compact(result);
      const isError = result?.error || (typeof result === 'string' && result.includes('Error:'));
      results.push({
        index: i,
        tool,
        success: !isError,
        durationMs: Date.now() - startedAt,
        ...(isError ? { error: typeof result === 'string' ? result : result.error } : { output: typeof compacted === 'string' ? compacted : (compacted?.output ?? compacted) }),
      });
      if (isError) {
        failCount++;
        if (stopOnError) break;
      } else {
        okCount++;
      }
    } catch (err) {
      failCount++;
      results.push({
        index: i,
        tool,
        success: false,
        durationMs: Date.now() - startedAt,
        error: err && err.message ? err.message : String(err),
      });
      if (stopOnError) break;
    }
  }

  // Compact text summary — easier for the LLM to scan than the JSON array.
  const lines = results.map(r => {
    const tag = r.skipped ? 'SKIP' : (r.success ? ' OK ' : 'FAIL');
    const detail = r.success
      ? (typeof r.output === 'string' ? r.output : JSON.stringify(r.output ?? '').slice(0, 200))
      : (r.error || '');
    return `[${tag}] #${r.index} ${r.tool}: ${detail}`;
  });
  const summary = `run_script: ${okCount} OK, ${failCount} FAIL (of ${actions.length})`;
  return {
    output: `${summary}\n${lines.join('\n')}`,
    structured: { summary, okCount, failCount, total: actions.length, results },
  };
}

/**
 * verify_action — pure-CDP polling check. Replaces a read_page round-trip when
 * the agent just needs to confirm a single observable outcome after an action.
 *
 * @param {Object} input
 * @param {'navigated'|'text-appeared'|'ref-disappeared'|'modal-present'} input.expect
 * @param {string} [input.hint]    — used as the URL pattern / text needle / ref id, depending on expect
 * @param {number} [input.tabId]
 * @param {number} [input.timeoutMs=3000]
 * @param {number} [input.pollIntervalMs=200]
 */
export async function handleVerifyAction(input) {
  const expect = input?.expect;
  const tabId = input?.tabId;
  const hint = input?.hint || '';
  const timeoutMs = Math.min(Math.max(Number(input?.timeoutMs) || 3000, 200), 15000);
  const pollIntervalMs = Math.min(Math.max(Number(input?.pollIntervalMs) || 200, 100), 1000);

  if (!tabId) return { error: 'verify_action: tabId required.' };
  if (!expect) return { error: 'verify_action: `expect` required.' };
  if (!['navigated', 'text-appeared', 'ref-disappeared', 'modal-present'].includes(expect)) {
    return { error: `verify_action: unknown expect="${expect}". Allowed: navigated | text-appeared | ref-disappeared | modal-present.` };
  }

  const attached = await ensureDebugger(tabId);
  if (!attached) return { error: 'verify_action: could not attach debugger.' };

  let initialUrl = '';
  try { initialUrl = (await chrome.tabs.get(tabId)).url || ''; } catch { /* tab gone */ }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const check = await runCheck(tabId, expect, hint, initialUrl);
      if (check.ok) {
        return {
          output: `verify_action OK (${expect}): ${check.evidence} [polled ${Date.now() - startedAt}ms]`,
          structured: { ok: true, evidence: check.evidence, polledMs: Date.now() - startedAt },
        };
      }
    } catch (err) {
      // A per-poll failure is just an inconclusive observation — keep polling.
      void err;
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  return {
    output: `verify_action FAIL (${expect}): no evidence within ${timeoutMs}ms.`,
    structured: { ok: false, evidence: '', polledMs: timeoutMs },
  };
}

async function runCheck(tabId, expect, hint, initialUrl) {
  switch (expect) {
    case 'navigated': {
      const tab = await chrome.tabs.get(tabId);
      const url = tab?.url || '';
      if (!url) return { ok: false };
      if (hint) {
        // hint may be a substring or a RegExp source — accept either.
        try {
          const re = new RegExp(hint);
          if (re.test(url)) return { ok: true, evidence: `URL matches /${hint}/: ${url}` };
        } catch {
          if (url.includes(hint)) return { ok: true, evidence: `URL contains "${hint}": ${url}` };
        }
        return { ok: false };
      }
      return url !== initialUrl
        ? { ok: true, evidence: `URL changed: ${initialUrl} → ${url}` }
        : { ok: false };
    }
    case 'text-appeared': {
      if (!hint) return { ok: false };
      const safe = hint.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
      const expr = `(function(){var t=(document.body && document.body.innerText) || '';var i=t.indexOf(\`${safe}\`);return i>=0 ? t.slice(Math.max(0,i-30), i+${safe.length}+30) : '';})()`;
      const r = await cdpHelper.sendCommand(tabId, 'Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        timeout: 2000,
      });
      const v = r?.result?.value || '';
      return v ? { ok: true, evidence: `text="${v.slice(0, 120)}"` } : { ok: false };
    }
    case 'ref-disappeared': {
      const ref = Number(hint);
      if (!Number.isFinite(ref) || ref <= 0) {
        return { ok: false };
      }
      try {
        await sendDebuggerCommand(tabId, 'DOM.resolveNode', { backendNodeId: ref });
        return { ok: false }; // resolved → still exists
      } catch {
        return { ok: true, evidence: `ref ${ref} no longer resolvable` };
      }
    }
    case 'modal-present': {
      const sel = '[role="dialog"]:not([aria-hidden="true"]), [role="alertdialog"]:not([aria-hidden="true"]), [data-automation-id="taskModalCloseButton"], .ReactModal__Content--after-open';
      const safeSel = sel.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
      const expr = `(function(){var els=document.querySelectorAll(\`${safeSel}\`);for(var i=0;i<els.length;i++){var e=els[i];if(e && e.offsetParent !== null){var t=(e.innerText||'').slice(0,200);return t || '[modal element with no text]';}}return '';})()`;
      const r = await cdpHelper.sendCommand(tabId, 'Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        timeout: 2000,
      });
      const v = r?.result?.value || '';
      return v ? { ok: true, evidence: `modal: "${v.slice(0, 120)}"` } : { ok: false };
    }
    default:
      return { ok: false };
  }
}
