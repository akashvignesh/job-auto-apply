/**
 * Standalone test for mouse-click, keyboard, coordinate-scaling, and ref-resolution logic.
 *
 * These are the pure code paths behind the `computer` tool. We stub CDP (`sendCommand`) and
 * record every Input.* command the helper emits, then assert the coordinates / key codes are
 * correct. This isolates "is the click/keyboard math right?" from "is Chrome receiving it?".
 *
 * Run:  node test-input.mjs
 */

// chrome must exist before the modules load (they touch chrome.* at import time).
globalThis.chrome = {
  runtime: { lastError: null, sendMessage() {}, getURL: (p) => p },
  tabs: { get: async () => ({ id: 1, url: 'https://example.com' }), update: async () => {} },
  scripting: { executeScript: async () => [{ result: null }] },
  debugger: {
    sendCommand() {}, attach() {}, detach() {},
    onEvent: { addListener() {}, removeListener() {} },
    onDetach: { addListener() {}, removeListener() {} },
  },
};

const assert = (await import('node:assert/strict')).default;
const { CDPHelper } = await import('./src/background/modules/cdp-helper.js');
const { indicatorManager } = await import('./src/background/managers/indicator-manager.js');
const { scaleCoordinates, scaleCoordinatesLive } = await import('./src/background/modules/screenshot-context.js');
const { createElementResolver } = await import('./src/background/dom-service/element-resolver.js');

// Indicator manager touches the page; make it a no-op for the click test.
indicatorManager.hideIndicatorForToolUse = async () => {};
indicatorManager.restoreIndicatorAfterToolUse = async () => {};

let passed = 0;
let failed = 0;
function test(name, fn) {
  return fn().then(
    () => { passed++; console.log(`  PASS  ${name}`); },
    (err) => { failed++; console.log(`  FAIL  ${name}\n        ${err.message}`); },
  );
}

// A CDPHelper whose sendCommand records calls instead of hitting Chrome.
function makeHelper() {
  const calls = [];
  const helper = new CDPHelper();
  helper.sendCommand = async (tabId, method, params) => {
    calls.push({ method, params });
    if (method === 'DOM.getBoxModel') {
      return { model: { content: [10, 20, 110, 20, 110, 60, 10, 60] } }; // centroid (60,40)
    }
    if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
    return {};
  };
  return { helper, calls, mouse: () => calls.filter(c => c.method === 'Input.dispatchMouseEvent'),
           keys: () => calls.filter(c => c.method === 'Input.dispatchKeyEvent') };
}

console.log('\nMOUSE CLICK');

await test('left click dispatches press+release at the EXACT given coords (no offset)', async () => {
  const { helper, mouse } = makeHelper();
  await helper.click(1, 137, 426, 'left', 1, 0, false);
  const press = mouse().find(c => c.params.type === 'mousePressed');
  const release = mouse().find(c => c.params.type === 'mouseReleased');
  assert.ok(press, 'no mousePressed emitted');
  assert.equal(press.params.x, 137);
  assert.equal(press.params.y, 426);
  assert.equal(press.params.button, 'left');
  assert.equal(press.params.buttons, 1);
  assert.equal(press.params.clickCount, 1);
  assert.equal(release.params.x, 137);
  assert.equal(release.params.y, 426);
  assert.equal(release.params.buttons, 0);
});

await test('right click uses button=right, buttons=2', async () => {
  const { helper, mouse } = makeHelper();
  await helper.click(1, 50, 60, 'right', 1, 0, false);
  const press = mouse().find(c => c.params.type === 'mousePressed');
  assert.equal(press.params.button, 'right');
  assert.equal(press.params.buttons, 2);
});

await test('double click emits two press/release with clickCount 1 then 2', async () => {
  const { helper, mouse } = makeHelper();
  await helper.click(1, 10, 10, 'left', 2, 0, false);
  const presses = mouse().filter(c => c.params.type === 'mousePressed').map(c => c.params.clickCount);
  assert.deepEqual(presses, [1, 2]);
});

await test('coords are rounded before dispatch (CDP needs integers)', async () => {
  const { helper, mouse } = makeHelper();
  await helper.click(1, 12.7, 8.2, 'left', 1, 0, false);
  const press = mouse().find(c => c.params.type === 'mousePressed');
  assert.equal(press.params.x, 13);
  assert.equal(press.params.y, 8);
});

console.log('\nCOORDINATE SCALING (screenshot space -> CSS px)');

await test('DPR=1: coords pass through unchanged', () => {
  const ctx = { viewportWidth: 1280, viewportHeight: 720, screenshotWidth: 1280, screenshotHeight: 720 };
  assert.deepEqual(scaleCoordinates(800, 600, ctx), [800, 600]);
  return Promise.resolve();
});

await test('DPR=2: screenshot coords halved to CSS px', () => {
  const ctx = { viewportWidth: 1280, viewportHeight: 720, screenshotWidth: 2560, screenshotHeight: 1440 };
  assert.deepEqual(scaleCoordinates(1000, 800, ctx), [500, 400]);
  return Promise.resolve();
});

await test('scaleCoordinatesLive uses the CURRENT viewport, not the stale one', async () => {
  // screenshot was 2560 wide; window since resized so innerWidth is now 1000.
  const ctx = { viewportWidth: 1280, viewportHeight: 720, screenshotWidth: 2560, screenshotHeight: 1440 };
  const cdp = async () => ({ result: { value: [1000, 500] } });
  const [x, y] = await scaleCoordinatesLive(2560, 1440, ctx, cdp);
  assert.equal(x, 1000); // 2560 * (1000/2560)
  assert.equal(y, 500);  // 1440 * (500/1440)
});

await test('scaleCoordinatesLive falls back to static scaling when CDP fails', async () => {
  const ctx = { viewportWidth: 1280, viewportHeight: 720, screenshotWidth: 2560, screenshotHeight: 1440 };
  const cdp = async () => { throw new Error('debugger not attached'); };
  const [x, y] = await scaleCoordinatesLive(1000, 800, ctx, cdp);
  assert.equal(x, 500);
  assert.equal(y, 400);
});

console.log('\nREF RESOLUTION (box-model centroid)');

await test('getCoordinates returns the centroid of the content quad', async () => {
  const { helper } = makeHelper();
  const resolver = createElementResolver((tabId, method, params) => helper.sendCommand(tabId, method, params));
  const { x, y } = await resolver.getCoordinates(1, 999);
  assert.equal(x, 60);
  assert.equal(y, 40);
});

await test('parseRef accepts numeric / numeric-string, rejects ref_N and junk', () => {
  const r = createElementResolver(async () => ({}));
  assert.equal(r.parseRef(42), 42);
  assert.equal(r.parseRef('857'), 857);
  assert.equal(r.parseRef('ref_42'), null);
  assert.equal(r.parseRef('abc'), null);
  return Promise.resolve();
});

console.log('\nKEYBOARD');

await test('getKeyCode maps named keys (Enter, Tab) with correct keyCode', () => {
  const { helper } = makeHelper();
  assert.equal(helper.getKeyCode('Enter').keyCode, 13);
  assert.equal(helper.getKeyCode('enter').code, 'Enter');
  assert.equal(helper.getKeyCode('Tab').keyCode, 9);
  return Promise.resolve();
});

await test('getKeyCode maps letters/digits to KeyX / DigitN', () => {
  const { helper } = makeHelper();
  assert.equal(helper.getKeyCode('a').code, 'KeyA');
  assert.equal(helper.getKeyCode('5').code, 'Digit5');
  return Promise.resolve();
});

await test('pressKey emits keyDown then keyUp with matching key/code', async () => {
  const { helper, keys } = makeHelper();
  await helper.pressKey(1, helper.getKeyCode('Enter'), 0);
  const types = keys().map(c => c.params.type);
  assert.deepEqual(types, ['keyDown', 'keyUp']);
  assert.equal(keys()[0].params.key, 'Enter');
  assert.equal(keys()[0].params.windowsVirtualKeyCode, 13);
});

await test('pressKeyChord("ctrl+a") sets ctrl modifier (2) on the "a" key', async () => {
  const { helper, keys } = makeHelper();
  await helper.pressKeyChord(1, 'ctrl+a');
  assert.ok(keys().length >= 2, 'expected keyDown+keyUp');
  assert.equal(keys()[0].params.modifiers, 2);
  assert.equal(keys()[0].params.code, 'KeyA');
});

await test('Enter key in type() is a real key event, not insertText', async () => {
  const { helper, calls } = makeHelper();
  await helper.type(1, '\n', false);
  assert.ok(calls.some(c => c.method === 'Input.dispatchKeyEvent' && c.params.key === 'Enter'),
    'newline should dispatch an Enter key event');
  assert.ok(!calls.some(c => c.method === 'Input.insertText'),
    'newline should NOT go through insertText');
});

// ============================================================================
// Phase B — run_script (batched dispatcher) and verify_action (CDP poller)
// ============================================================================
console.log('\nPHASE B — run_script / verify_action');

const { handleRunScript, handleVerifyAction } = await import('./src/background/tool-handlers/script-tool.js');

function makeExecuteToolStub() {
  const calls = [];
  // Return a stub that records (toolName, input) and yields a configurable result.
  // By default, returns { output: 'ok' } for every call.
  const fn = async (toolName, input /* sessionTabGroupId, mcpSession, opts */) => {
    calls.push({ toolName, input });
    if (toolName === 'form_input' && input?.value === 'FAIL') {
      return { error: 'simulated form_input failure' };
    }
    return { output: `did ${toolName}` };
  };
  return { fn, calls };
}

await test('run_script: rejects when actions is missing/empty', async () => {
  const { fn } = makeExecuteToolStub();
  const r1 = await handleRunScript({}, { executeTool: fn });
  const r2 = await handleRunScript({ actions: [] }, { executeTool: fn });
  assert.ok(String(r1.error || '').includes('actions'));
  assert.ok(String(r2.error || '').includes('actions'));
});

await test('run_script: rejects oversize batches', async () => {
  const { fn } = makeExecuteToolStub();
  const actions = Array.from({ length: 13 }, () => ({ tool: 'form_input', input: { ref: 1, value: 'x' } }));
  const r = await handleRunScript({ actions }, { executeTool: fn });
  assert.ok(String(r.error || '').includes('too large'));
});

await test('run_script: dispatches actions in order and returns per-action results', async () => {
  const { fn, calls } = makeExecuteToolStub();
  const r = await handleRunScript({
    actions: [
      { tool: 'form_input', input: { ref: 100, value: 'a' } },
      { tool: 'form_input', input: { ref: 101, value: 'b' } },
      { tool: 'computer',   input: { action: 'left_click', ref: 200 } },
    ],
  }, { executeTool: fn });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].input.ref, 100);
  assert.equal(calls[2].input.action, 'left_click');
  assert.equal(r.structured.okCount, 3);
  assert.equal(r.structured.failCount, 0);
  assert.match(r.output, /3 OK, 0 FAIL/);
});

await test('run_script: blocks disallowed inner tools', async () => {
  const { fn, calls } = makeExecuteToolStub();
  const r = await handleRunScript({
    actions: [
      { tool: 'read_page',      input: {} },
      { tool: 'javascript_tool', input: { action: 'javascript_exec', text: '1+1' } },
      { tool: 'form_input',     input: { ref: 1, value: 'ok' } },
    ],
  }, { executeTool: fn });
  // Only the form_input should have been dispatched. The other two get rejected
  // with an "allowed" error message and never reach executeTool.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolName, 'form_input');
  assert.equal(r.structured.failCount, 2);
  assert.equal(r.structured.okCount, 1);
});

await test('run_script: stopOnError halts the batch on the first failure', async () => {
  const { fn, calls } = makeExecuteToolStub();
  const r = await handleRunScript({
    stopOnError: true,
    actions: [
      { tool: 'form_input', input: { ref: 1, value: 'ok' } },
      { tool: 'form_input', input: { ref: 2, value: 'FAIL' } },
      { tool: 'form_input', input: { ref: 3, value: 'never-reached' } },
    ],
  }, { executeTool: fn });
  assert.equal(calls.length, 2); // third action never dispatched
  assert.equal(r.structured.okCount, 1);
  assert.equal(r.structured.failCount, 1);
});

await test('run_script: continues past failures by default', async () => {
  const { fn, calls } = makeExecuteToolStub();
  const r = await handleRunScript({
    actions: [
      { tool: 'form_input', input: { ref: 1, value: 'ok' } },
      { tool: 'form_input', input: { ref: 2, value: 'FAIL' } },
      { tool: 'form_input', input: { ref: 3, value: 'recover' } },
    ],
  }, { executeTool: fn });
  assert.equal(calls.length, 3);
  assert.equal(r.structured.okCount, 2);
  assert.equal(r.structured.failCount, 1);
});

// verify_action — make sure the input validation works without needing the
// full chrome.debugger stack. The actual polling logic touches CDP and is
// covered end-to-end in browser; here we just confirm the input gates.
await test('verify_action: rejects missing tabId / expect / bad expect value', async () => {
  const r1 = await handleVerifyAction({ expect: 'navigated' });            // no tabId
  const r2 = await handleVerifyAction({ tabId: 1 });                         // no expect
  const r3 = await handleVerifyAction({ tabId: 1, expect: 'bogus-mode' });   // bad expect
  assert.ok(String(r1.error || '').includes('tabId'));
  assert.ok(String(r2.error || '').includes('expect'));
  assert.ok(String(r3.error || '').includes('unknown expect'));
});

// ============================================================================
// Phase C — proactive compaction / self-heal / snapshot-diff
// ============================================================================
console.log('\nPHASE C — proactive compaction / self-heal / snapshot-diff');

const { shouldProactivelyCompact, PROACTIVE_THRESHOLD, MIN_TURNS_BETWEEN_COMPACTIONS } =
  await import('./src/background/modules/conversation-compaction.js');

await test('shouldProactivelyCompact: under token bar → never fires', () => {
  assert.equal(shouldProactivelyCompact({ tokens: PROACTIVE_THRESHOLD - 1, turn: 100, lastCompactedAt: 0 }), false);
  return Promise.resolve();
});

await test('shouldProactivelyCompact: above token bar + cadence met → fires', () => {
  assert.equal(
    shouldProactivelyCompact({ tokens: PROACTIVE_THRESHOLD + 5000, turn: MIN_TURNS_BETWEEN_COMPACTIONS, lastCompactedAt: 0 }),
    true,
  );
  return Promise.resolve();
});

await test('shouldProactivelyCompact: above token bar but cadence too soon → skip', () => {
  assert.equal(
    shouldProactivelyCompact({ tokens: PROACTIVE_THRESHOLD + 5000, turn: MIN_TURNS_BETWEEN_COMPACTIONS - 1, lastCompactedAt: 0 }),
    false,
  );
  // And once compacted, the next attempt should respect the interval.
  assert.equal(
    shouldProactivelyCompact({
      tokens: PROACTIVE_THRESHOLD + 5000,
      turn: MIN_TURNS_BETWEEN_COMPACTIONS + 3,
      lastCompactedAt: MIN_TURNS_BETWEEN_COMPACTIONS + 1,
    }),
    false,
  );
  return Promise.resolve();
});

// C.1 — self-heal hooks: we test recordRefMeta + the recovery probe by stubbing
// CDP. The real DOM.resolveNode is mocked to fail; Runtime.evaluate is mocked
// to return a fake node objectId; DOM.describeNode is mocked to return a fresh
// backendNodeId. We verify the resolver returns the healed id.
// (createElementResolver is already imported above; reuse it.)
const { recordRefMeta, clearRefMetaForTab, _peekRefMeta } =
  await import('./src/background/dom-service/element-resolver.js');

await test('recordRefMeta stores and clears per-tab', () => {
  clearRefMetaForTab(1);
  assert.equal(_peekRefMeta(1, 42), null);
  recordRefMeta(1, 42, { role: 'button', label: 'Submit', tag: 'button' });
  const m = _peekRefMeta(1, 42);
  assert.equal(m.role, 'button');
  assert.equal(m.label, 'Submit');
  clearRefMetaForTab(1);
  assert.equal(_peekRefMeta(1, 42), null);
  return Promise.resolve();
});

await test('resolver self-heals from stale ref using ref-meta cache', async () => {
  clearRefMetaForTab(7);
  recordRefMeta(7, 9999, { role: 'button', label: 'Save and Continue', tag: 'button' });

  // Stub CDP: DOM.resolveNode rejects (stale ref), Runtime.evaluate returns
  // a node objectId, DOM.describeNode returns a fresh backendNodeId.
  const calls = [];
  const sendCommand = async (tabId, method, params) => {
    calls.push({ method, params });
    if (method === 'DOM.resolveNode') throw new Error('Could not find node');
    if (method === 'Runtime.evaluate') {
      return { result: { type: 'object', subtype: 'node', objectId: 'obj-healed-1' } };
    }
    if (method === 'DOM.describeNode') {
      return { node: { nodeId: 555, backendNodeId: 12345 } };
    }
    return {};
  };
  const resolver = createElementResolver(sendCommand);
  const full = await resolver.resolveNodeFull(7, 9999);
  assert.equal(full.healed, true);
  assert.equal(full.backendNodeId, 12345);
  assert.equal(full.objectId, 'obj-healed-1');
  // Resolved exactly once (the resolveNode attempt that threw), then evaluated.
  assert.equal(calls.filter(c => c.method === 'DOM.resolveNode').length, 1);
  assert.equal(calls.filter(c => c.method === 'Runtime.evaluate').length, 1);
});

await test('resolver throws when self-heal has no cache entry to use', async () => {
  clearRefMetaForTab(8);
  const sendCommand = async (_t, method) => {
    if (method === 'DOM.resolveNode') throw new Error('stale');
    return {};
  };
  const resolver = createElementResolver(sendCommand);
  await assert.rejects(
    () => resolver.resolveNodeFull(8, 4242),
    /Could not resolve element 4242/,
  );
});

// C.2 — snapshot-diff helpers
const { buildRefSummaryFromMap, diffRefMaps } =
  await import('./src/background/tool-handlers/read-page-core.js');

await test('buildRefSummaryFromMap extracts role/label/tag from selectorMap', () => {
  const sm = new Map();
  sm.set(1, { nodeName: 'BUTTON', axNode: { role: 'button', name: 'Submit' }, attributes: {} });
  sm.set(2, { nodeName: 'INPUT', axNode: { role: 'textbox' }, attributes: { 'aria-label': 'Email' } });
  sm.set(3, { nodeName: 'DIV', axNode: {}, attributes: {} });
  const out = buildRefSummaryFromMap(sm);
  assert.equal(out.get('1').label, 'Submit');
  assert.equal(out.get('1').role, 'button');
  assert.equal(out.get('1').tag, 'button');
  assert.equal(out.get('2').label, 'Email');
  assert.equal(out.get('2').role, 'textbox');
  return Promise.resolve();
});

await test('diffRefMaps detects added / removed / changed correctly', () => {
  const prev = new Map([
    ['10', { role: 'button', label: 'Apply', tag: 'button' }],
    ['11', { role: 'textbox', label: 'Email', tag: 'input' }],
    ['12', { role: 'button', label: 'Save', tag: 'button' }],
  ]);
  const cur = new Map([
    ['10', { role: 'button', label: 'Apply Now', tag: 'button' }], // changed (label)
    ['11', { role: 'textbox', label: 'Email', tag: 'input' }],     // unchanged
    ['13', { role: 'dialog', label: 'Modal', tag: 'div' }],        // added (12 removed)
  ]);
  const diff = diffRefMaps(prev, cur);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0].ref, '13');
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.removed[0].ref, '12');
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].ref, '10');
  assert.equal(diff.changed[0].to.label, 'Apply Now');
  return Promise.resolve();
});

await test('diffRefMaps with identical maps emits no changes', () => {
  const m = new Map([['1', { role: 'button', label: 'OK', tag: 'button' }]]);
  const other = new Map([['1', { role: 'button', label: 'OK', tag: 'button' }]]);
  const diff = diffRefMaps(m, other);
  assert.equal(diff.added.length, 0);
  assert.equal(diff.removed.length, 0);
  assert.equal(diff.changed.length, 0);
  return Promise.resolve();
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
