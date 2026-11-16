import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { iosNeeded } from '../scripts/ios-needed.mjs';

test('iOS code, the bundled page, Swift tests and shared build config run the iOS job', () => {
  for (const path of [
    'packages/mobile/ios/App/App/Shell/Relay/LoopbackProxy.swift',
    'packages/mobile/connect/connect.js',
    'packages/mobile/test/swift/relay/LoopbackProxyTest.swift',
    'packages/mobile/package.json',
    'packages/mobile/package-lock.json',
    'packages/mobile/capacitor.config.json',
    'packages/mobile/scripts/test-swift.sh',
    'packages/mobile/demo/index.html',
    'packages/mobile/somewhere-new/file.txt',
    'test-vectors/relay/proof.json',
    '.github/workflows/mobile-check.yml',
  ]) assert.equal(iosNeeded([path]), true, path);
});

test('Android-only code, store listings and prose skip it', () => {
  assert.equal(iosNeeded([
    'packages/mobile/android/app/src/main/java/com/openmercato/cezar/mobile/shell/relay/RelayLink.java',
    'packages/mobile/store/listing.md',
    'packages/mobile/store/screenshots/android/1.png',
    'packages/mobile/README.md',
    'packages/cezar/src/relay/connection.ts',
    'docs/site/content/docs/03-features/setup-and-integrations/mobile-app.mdx',
  ]), false);
});

test('one iOS-relevant path among Android-only ones still runs it', () => {
  assert.equal(iosNeeded(['packages/mobile/android/build.gradle', 'packages/mobile/ios/App/Podfile']), true);
});

test('an empty or unreadable change list fails toward running it', () => {
  assert.equal(iosNeeded([]), true);
  assert.equal(iosNeeded(['', '  ']), true);
});

test('the CLI prints a GITHUB_OUTPUT line', () => {
  const run = (input) => execFileSync('node', ['scripts/ios-needed.mjs'], { input, encoding: 'utf8' }).trim();
  assert.equal(run('packages/mobile/android/x.java\n'), 'ios=false');
  assert.equal(run('packages/mobile/ios/x.swift\n'), 'ios=true');
});

test('the workflow gates the iOS job on the changes job and keeps the cheap checks unconditional', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/mobile-check.yml', import.meta.url), 'utf8');
  assert.match(workflow, /node packages\/mobile\/scripts\/ios-needed\.mjs/);
  assert.match(workflow, /\n {2}ios:\n(?:.*\n)*? {4}needs: changes\n {4}if: needs\.changes\.outputs\.ios == 'true'/);
  assert.doesNotMatch(workflow.split('\n  android:')[0], /\n {4}if:/);
});
