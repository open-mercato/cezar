import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// The cover over a server page goes when this script says so: both shells must ask the same question.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** The string a constant is set to, its concatenated literals joined. */
function constant(source, name) {
  const match = source.match(new RegExp(`${name}\\s*=\\s*((?:"(?:[^"\\\\]|\\\\.)*"\\s*\\+?\\s*)+)[;\\n]`));
  assert.ok(match, `${name} not found`);
  return [...match[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((literal) => JSON.parse(`"${literal[1]}"`)).join('');
}

const android = constant(read('android/app/src/main/java/com/openmercato/cezar/mobile/shell/FirstPaint.java'), 'SCRIPT');
const ios = constant(read('ios/App/App/Shell/FirstPaint.swift'), 'static let script');

function painted(document, protocol = 'http:') {
  return vm.runInNewContext(android, { document, location: { protocol } });
}

function page({ readyState, root }) {
  return { readyState, getElementById: (id) => (id === 'root' ? root : null) };
}

test('Android and iOS run the same first-paint script', () => {
  assert.equal(ios, android);
  assert.ok(android.includes("getElementById('root')"));
});

test('the cockpit has painted once #root has children', () => {
  assert.equal(painted(page({ readyState: 'complete', root: { childElementCount: 0 } })), false);
  assert.equal(painted(page({ readyState: 'interactive', root: { childElementCount: 2 } })), true);
});

test('a page with no #root counts once it has loaded', () => {
  assert.equal(painted(page({ readyState: 'complete', root: null })), true);
  assert.equal(painted(page({ readyState: 'interactive', root: null })), false);
});

test('nothing counts while the document is still loading', () => {
  assert.equal(painted(page({ readyState: 'loading', root: { childElementCount: 3 } })), false);
  assert.equal(painted(page({ readyState: 'loading', root: null })), false);
});

test("the web view's first about:blank never drops the cover", () => {
  assert.equal(painted(page({ readyState: 'complete', root: null }), 'about:'), false);
  assert.equal(painted(page({ readyState: 'complete', root: null }), 'https:'), true);
});
