import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// The start and resume watchdogs over a server page read this script: both shells must ask the same question.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** The string a constant is set to, its concatenated literals joined. */
function constant(source, name) {
  const match = source.match(new RegExp(`${name}\\s*=\\s*((?:"(?:[^"\\\\]|\\\\.)*"\\s*\\+?\\s*)+)[;\\n]`));
  assert.ok(match, `${name} not found`);
  return [...match[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((literal) => JSON.parse(`"${literal[1]}"`)).join('');
}

const android = constant(read('android/app/src/main/java/com/openmercato/cezar/mobile/shell/PageCheck.java'), 'SCRIPT');
const ios = constant(read('ios/App/App/Shell/PageCheck.swift'), 'static let script');

function check(document, protocol = 'http:') {
  return vm.runInNewContext(android, { document, location: { protocol } });
}

function page({ readyState, root }) {
  return { readyState, getElementById: (id) => (id === 'root' ? root : null) };
}

test('Android and iOS run the same page check', () => {
  assert.equal(ios, android);
  assert.ok(android.includes("getElementById('root')"));
});

test('a cockpit with children in #root has painted', () => {
  assert.equal(check(page({ readyState: 'interactive', root: { childElementCount: 2 } })), 'painted');
});

test('a loaded cockpit with an empty #root is blank: the black screen', () => {
  // A shell naming bundle files the server no longer has, or a boot crash, leaves exactly this.
  assert.equal(check(page({ readyState: 'complete', root: { childElementCount: 0 } })), 'blank');
  assert.equal(check(page({ readyState: 'interactive', root: { childElementCount: 0 } })), 'blank');
});

test('a page with no #root is a page once it has loaded', () => {
  assert.equal(check(page({ readyState: 'complete', root: null })), 'page');
  assert.equal(check(page({ readyState: 'interactive', root: null })), 'loading');
});

test('nothing counts while the document is still loading', () => {
  assert.equal(check(page({ readyState: 'loading', root: { childElementCount: 3 } })), 'loading');
});

test("the web view's about:blank is none", () => {
  assert.equal(check(page({ readyState: 'complete', root: null }), 'about:'), 'none');
  assert.equal(check(page({ readyState: 'complete', root: null }), 'https:'), 'page');
});
