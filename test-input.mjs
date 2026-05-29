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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
