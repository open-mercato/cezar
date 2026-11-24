import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Android's Back and iOS's edge swipe run this script on the connect page (connect.js sets window.cezarBack).
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const android = read('android/app/src/main/java/com/openmercato/cezar/mobile/shell/PageBack.java').match(/SCRIPT = "(.*)";/)[1];
const ios = read('ios/App/App/Shell/NavigationPolicy.swift').match(/static let script = "(.*)"/)[1];

const run = (script, window) => vm.runInNewContext(script, { window });

test('both platforms ask the page the same question', () => {
  assert.equal(android, ios);
});

for (const [platform, script] of [['android', android], ['ios', ios]]) {
  test(`${platform}: the page takes Back when it has somewhere to go`, () => {
    let called = 0;
    assert.equal(run(script, { cezarBack: () => (called++, true) }), true);
    assert.equal(called, 1);
  });

  test(`${platform}: native keeps Back when the page declines or is not loaded`, () => {
    assert.equal(run(script, { cezarBack: () => false }), false);
    assert.equal(run(script, {}), false);
    assert.equal(run(script, { cezarBack: () => 'yes' }), false);
  });
}
