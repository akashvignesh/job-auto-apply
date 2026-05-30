#!/usr/bin/env node
/**
 * Offline analyzer: reads a saved run log.json and prints the Phase 7 metrics
 * block (same code path as the live CLI), plus a token-savings projection that
 * compares the run against an "all-full read_page" baseline.
 *
 * Usage: node server/src/local-runner/analyze-run.mjs <path/to/log.json>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const distLogger = pathToFileURL(path.resolve(path.dirname(__filename), '../../dist/local-runner/run-logger.js')).href;
const { analyzeTurns, formatMetricsSummary } = await import(distLogger);

const CHARS_PER_TOKEN = 4;            // rough rule of thumb
const SCREENSHOT_TOKEN_COST = 1800;   // matches existing prompt guidance
const SUMMARY_CHAR_BUDGET = 1500;     // ~bounded summary output

function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
}

const logPath = process.argv[2];
if (!logPath) {
  console.error('Usage: node analyze-run.mjs <path/to/log.json>');
  process.exit(2);
}
const raw = fs.readFileSync(logPath, 'utf8');
const log = JSON.parse(raw);

// log shape: { turns: [{ step, tools: [{ name, input, result, durationMs }], ai_response }], usage, ... }
const turns = log.turns || log.steps || [];
const stats = {
  totalSteps: turns.length,
  apiCalls: log.usage?.apiCalls ?? turns.length,
  inputTokens: log.usage?.inputTokens || 0,
  outputTokens: log.usage?.outputTokens || 0,
  toolCounts: {},
  readPageCount: 0,
  readPageFullChars: 0,
  screenshotCount: 0,
  readPageUnchanged: 0,
  consecutiveScreenshots: 0,
  consecutiveReadPages: 0,
  uploadButtonClicks: 0,
  blockedScreenshotsByHash: 0,
  blockedScreenshotsByTime: 0,
  fingerprints: new Set(),
  fingerprintScreenshotCounts: new Map(),
};

let lastReadPageHash = null;
let lastReadPageAtIdx = -1;
let lastScreenshotAtMs = 0;
let lastScreenshotDomHash = null;
let lastDomHashByFingerprint = new Map();

// Step times aren't always recorded; fall back to step index * 500ms.
function approxAt(i) {
  return i * 500;
}

let modeledReadPageTokens = 0;
let modeledScreenshotTokens = 0;
let originalReadPageTokens = 0;
let originalScreenshotTokens = 0;

// Phase 7.5 — guards modeling.
const failedActionCounts = new Map();
let blockedRepeatedFailures = 0;
let malformedComputerCalls = 0;
let consecutiveFullReads = 0;
let blockedFullReads = 0;

function stableKey(input) {
  if (input == null || typeof input !== 'object') return JSON.stringify(input);
  const out = {};
  for (const k of Object.keys(input).sort()) {
    if (k === 'tabId' || k === 'imageId') continue;
    const v = input[k];
    out[k] = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) : v;
  }
  return JSON.stringify(out);
}

function checkComputerMalformed(input) {
  if (input == null || typeof input !== 'object') return true;
  const action = input.action;
  if (typeof action !== 'string' || action.length === 0) return true;
  const needsRefOrCoord = ['left_click', 'right_click', 'double_click', 'triple_click', 'hover'];
  if (needsRefOrCoord.includes(action) && input.ref == null && !Array.isArray(input.coordinate)) return true;
  if (action === 'scroll' && !Array.isArray(input.coordinate)) return true;
  if (action === 'type' && typeof input.text !== 'string') return true;
  if (action === 'key' && typeof input.text !== 'string') return true;
  if (action === 'wait' && !(typeof input.duration === 'number' && input.duration > 0)) return true;
  if (action === 'scroll_to' && input.ref == null) return true;
  if (action === 'left_click_drag' && (!Array.isArray(input.start_coordinate) || !Array.isArray(input.coordinate))) return true;
  if (action === 'zoom' && (!Array.isArray(input.region) || input.region.length !== 4)) return true;
  return false;
}

for (let i = 0; i < turns.length; i++) {
  const turn = turns[i];
  const tools = turn.tools || [];
  for (const t of tools) {
    stats.toolCounts[t.name] = (stats.toolCounts[t.name] || 0) + 1;

    if (t.name === 'read_page') {
      stats.readPageCount += 1;
      const resultText = String(t.result || '');
      const isUnchanged = /Page DOM is UNCHANGED|Page DOM mostly unchanged/.test(resultText);
      if (isUnchanged) stats.readPageUnchanged += 1;

      // Extract a fingerprint if present
      const fp = (resultText.match(/\[fingerprint:([^\]]+)\]/) || [])[1] || null;
      if (fp) stats.fingerprints.add(fp);

      const domHash = djb2(resultText);
      if (lastReadPageHash === domHash) stats.consecutiveReadPages += 1;
      lastReadPageHash = domHash;
      lastReadPageAtIdx = i;
      if (fp) lastDomHashByFingerprint.set(fp, domHash);

      // Original cost: full DOM up to 20K chars. The log truncates result text
      // to 5KB before storage so resultText.length under-reports — for fresh
      // reads (not the cheap "unchanged" message) we assume the full 20K cap
      // was actually sent to the LLM.
      const fullChars = isUnchanged ? Math.min(resultText.length, 500) : 20000;
      stats.readPageFullChars += fullChars;
      originalReadPageTokens += Math.ceil(fullChars / CHARS_PER_TOKEN);

      // Modeled cost: summary by default unless this read was followed by use
      // of a ref from the DOM tree text. Heuristic: scan the NEXT 2 turns for
      // a tool input.ref that looks numeric and appears in this result text.
      let usedRefFromTree = false;
      for (let j = i + 1; j < Math.min(i + 3, turns.length); j++) {
        for (const t2 of (turns[j].tools || [])) {
          const r = t2.input?.ref;
          if (r && /^\d+$/.test(String(r)) && resultText.includes(`[${r}]`)) {
            usedRefFromTree = true;
          }
        }
        if (usedRefFromTree) break;
      }
      // Modeled cost
      if (isUnchanged) {
        modeledReadPageTokens += Math.ceil(120 / CHARS_PER_TOKEN); // brief unchanged message
      } else if (usedRefFromTree) {
        // Agent used a ref → we'd still emit summary mode by default; the agent
        // would have those refs in summary too (FIELDS/BUTTONS sections list them).
        modeledReadPageTokens += Math.ceil(SUMMARY_CHAR_BUDGET / CHARS_PER_TOKEN);
      } else {
        modeledReadPageTokens += Math.ceil(SUMMARY_CHAR_BUDGET / CHARS_PER_TOKEN);
      }
    }

    // Both computer({action:'screenshot'}) and read_page({screenshot:true}) carry images.
    let isScreenshot = false;
    if (t.name === 'computer' && t.input?.action === 'screenshot') isScreenshot = true;
    if (t.name === 'read_page' && t.input?.screenshot === true) isScreenshot = true;

    if (isScreenshot) {
      stats.screenshotCount += 1;
      originalScreenshotTokens += SCREENSHOT_TOKEN_COST;

      // Modeled: would the new budget allow this?
      const at = approxAt(i);
      const fp = [...lastDomHashByFingerprint.keys()].pop() || null;
      let blocked = false;
      // 1. Consecutive time cap (< 1500ms)
      if (lastScreenshotAtMs > 0 && at - lastScreenshotAtMs < 1500) {
        stats.blockedScreenshotsByTime += 1;
        blocked = true;
      }
      // 2. Same DOM hash as prior screenshot
      if (!blocked && lastReadPageHash && lastReadPageHash === lastScreenshotDomHash) {
        stats.blockedScreenshotsByHash += 1;
        blocked = true;
      }
      // 3. Per-fingerprint budget
      if (!blocked && fp) {
        const used = stats.fingerprintScreenshotCounts.get(fp) || 0;
        if (used >= 2) {
          stats.blockedScreenshotsByHash += 1; // bucket into "would-skip"
          blocked = true;
        } else {
          stats.fingerprintScreenshotCounts.set(fp, used + 1);
        }
      }

      if (blocked) {
        modeledScreenshotTokens += Math.ceil(150 / CHARS_PER_TOKEN); // tiny "skip" message
      } else {
        modeledScreenshotTokens += SCREENSHOT_TOKEN_COST;
        lastScreenshotAtMs = at;
        lastScreenshotDomHash = lastReadPageHash;
      }
    }

    // Phase 7.5 — count guards triggered.
    if (t.name === 'computer' && checkComputerMalformed(t.input || {})) {
      malformedComputerCalls += 1;
    }
    const akey = `${t.name}:${stableKey(t.input || {})}`;
    const failedBefore = failedActionCounts.get(akey) || 0;
    const resultText = String(t.result || '');
    const isFailure = /^Error:|error|failed|invalid|could not/i.test(resultText) && !/successfully/i.test(resultText);
    if (failedBefore >= 2 && isFailure) blockedRepeatedFailures += 1;
    if (isFailure) failedActionCounts.set(akey, failedBefore + 1);
    else failedActionCounts.delete(akey);

    if (t.name === 'read_page' && t.input?.mode === 'full') {
      if (consecutiveFullReads >= 2) blockedFullReads += 1;
      consecutiveFullReads += 1;
    } else if (t.name !== 'read_page') {
      consecutiveFullReads = 0;
    }

    // Upload button click flag
    if (t.name === 'computer' && (t.input?.action === 'left_click' || t.input?.action === 'double_click')) {
      const refStr = String(t.input?.ref || '');
      const resultStr = String(t.result || '');
      // crude flag: previous read_page mentioned 'input type=file' or the result text mentions file picker
      if (/file picker|input type=file|type=file/.test(resultStr) || /upload|choose file/i.test(resultStr)) {
        stats.uploadButtonClicks += 1;
      }
    }
  }
}

const fmt = (n) => n.toLocaleString();
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + '%' : 'n/a');

console.log('=== Run analysis ===');
console.log(`Log: ${logPath}`);
console.log(`Steps: ${stats.totalSteps} | API calls: ${stats.apiCalls}`);
console.log(`Original input tokens: ${fmt(stats.inputTokens)} | output: ${fmt(stats.outputTokens)}`);
console.log('');
console.log(formatMetricsSummary(log.usage || { inputTokens: 0, outputTokens: 0, apiCalls: stats.apiCalls }, analyzeTurns(turns)));
console.log('');
console.log('--- Projection: what Phase 7.1+7.2 would have done to this run ---');
console.log('Tool counts:');
for (const [name, count] of Object.entries(stats.toolCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${name.padEnd(22)} ${count}`);
}
console.log('');
console.log('read_page:');
console.log(`  total calls:                   ${stats.readPageCount}`);
console.log(`  unchanged-collapse responses:  ${stats.readPageUnchanged}`);
console.log(`  consecutive identical reads:   ${stats.consecutiveReadPages}`);
console.log(`  total chars consumed (capped): ${fmt(stats.readPageFullChars)}`);
console.log(`  original modeled tokens:       ${fmt(originalReadPageTokens)}`);
console.log(`  Phase 7.1 modeled tokens:      ${fmt(modeledReadPageTokens)}  (saved ${fmt(originalReadPageTokens - modeledReadPageTokens)}, ${pct(originalReadPageTokens - modeledReadPageTokens, originalReadPageTokens)})`);
console.log('');
console.log('screenshots:');
console.log(`  total captures:                ${stats.screenshotCount}`);
console.log(`  would-block by consecutive:    ${stats.blockedScreenshotsByTime}`);
console.log(`  would-block by hash/budget:    ${stats.blockedScreenshotsByHash}`);
console.log(`  original modeled tokens:       ${fmt(originalScreenshotTokens)}`);
console.log(`  Phase 7.2 modeled tokens:      ${fmt(modeledScreenshotTokens)}  (saved ${fmt(originalScreenshotTokens - modeledScreenshotTokens)}, ${pct(originalScreenshotTokens - modeledScreenshotTokens, originalScreenshotTokens)})`);
console.log('');
console.log('clicks flagged as likely file/upload (Phase 7.3 would block):');
console.log(`  ${stats.uploadButtonClicks}`);
console.log('');
console.log('loop guards (Phase 7.5):');
console.log(`  malformed computer calls (would reject before extension): ${malformedComputerCalls}`);
console.log(`  3rd+ identical failed calls (would block):                  ${blockedRepeatedFailures}`);
console.log(`  3rd+ consecutive full read_pages (would block):             ${blockedFullReads}`);
console.log('');

const origTotal = originalReadPageTokens + originalScreenshotTokens;
const modTotal = modeledReadPageTokens + modeledScreenshotTokens;
console.log(`Combined modeled token savings (read_page + screenshots): ${fmt(origTotal - modTotal)} of ${fmt(origTotal)}  (${pct(origTotal - modTotal, origTotal)})`);
console.log('Note: per-step LLM input tokens also include system prompt + tool defs + history, which are not affected here. Real savings include cascading reduction from fewer follow-up reads.');
