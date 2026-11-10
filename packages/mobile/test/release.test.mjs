import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { releaseVersion } from '../scripts/release-version.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('release versions map to increasing codes, an rc below its final release', () => {
  assert.deepEqual(releaseVersion('0.1.0'), { name: '0.1.0', code: 10099, marketing: '0.1.0', prerelease: false });
  assert.deepEqual(releaseVersion('mobile-v1.2.3-rc.4'), { name: '1.2.3-rc.4', code: 1020304, marketing: '1.2.3', prerelease: true });
  const order = ['0.1.0-rc.1', '0.1.0', '0.1.1', '0.2.0-rc.98', '0.2.0', '1.0.0', '99.99.99'];
  const codes = order.map((v) => releaseVersion(v).code);
  assert.deepEqual([...codes].sort((a, b) => a - b), codes);
  assert.ok(releaseVersion('2099.99.99').code <= 2_100_000_000, 'Play caps versionCode at 2100000000');
});

test('release versions outside the scheme are refused', () => {
  for (const bad of ['1.2', 'v1.2.3', '1.2.3-beta.1', '1.100.0', '1.0.100', '1.0.0-rc.0', '1.0.0-rc.99', '2100.0.0']) {
    assert.throws(() => releaseVersion(bad), undefined, bad);
  }
});

test('the Gradle formula is the same as the script', () => {
  const gradle = read('android/app/build.gradle');
  assert.match(gradle, /major \* 1000000 \+ minor \* 10000 \+ patch \* 100 \+ build/);
  assert.match(gradle, /m\.group\(4\) == null \? 99/);
});

test('user CAs and extra cleartext stay in the debug network config', () => {
  const release = read('android/app/src/main/res/xml/network_security_config.xml');
  const debug = read('android/app/src/debug/res/xml/network_security_config.xml');
  assert.doesNotMatch(release, /debug-overrides|src="user"/);
  assert.match(debug, /<debug-overrides[\s\S]*src="user"/);
  // The debug copy replaces main's, so it must keep every release rule and may only add to them.
  const domains = (xml) => [...xml.matchAll(/<domain[^>]*>([^<]+)<\/domain>/g)].map((m) => m[1]);
  for (const d of domains(release)) assert.ok(domains(debug).includes(d), `debug config keeps ${d}`);
  assert.match(debug, /<base-config cleartextTrafficPermitted="false"/);
  assert.match(release, /<base-config cleartextTrafficPermitted="false"/);
});

test('the release check reads cleartext rules from aapt2 output', async () => {
  const { cleartextRules } = await import('../scripts/check-release.mjs');
  const tree = (base, domainOn, ...hosts) => [
    'E: network-security-config (line=3)',
    '    E: base-config (line=4)',
    `      A: cleartextTrafficPermitted=${base}`,
    '    E: domain-config (line=6)',
    `      A: cleartextTrafficPermitted=${domainOn}`,
    ...hosts.flatMap((h) => ['        E: domain (line=7)', '          A: includeSubdomains=false', `            T: '${h}'`]),
  ].join('\n');
  assert.deepEqual(cleartextRules(tree(false, true, '127.0.0.1')), { base: false, hosts: ['127.0.0.1'] });
  assert.deepEqual(cleartextRules(tree(false, false, 'example.com')), { base: false, hosts: [] });
  assert.deepEqual(cleartextRules(tree(true, true, '127.0.0.1', 'localhost')), { base: true, hosts: ['127.0.0.1', 'localhost'] });
  assert.deepEqual(cleartextRules(tree('(type 0x12)0xffffffff', false)), { base: true, hosts: [] });
});
