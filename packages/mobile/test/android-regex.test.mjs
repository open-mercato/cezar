import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

// Android's java.util.regex is ICU, which throws on these flags; the JVM the unit tests run on accepts
// them, so only a device would notice (PR #2340: a crash on every launch, from Avatar's static init).
const UNSUPPORTED = ['UNICODE_CHARACTER_CLASS', 'CANON_EQ'];
const main = new URL('../android/app/src/main/java/', import.meta.url);

function javaFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) return javaFiles(path);
    return entry.name.endsWith('.java') ? [path] : [];
  });
}

test('no app source compiles a regex with a flag Android rejects', () => {
  const files = javaFiles(main);
  assert.ok(files.length > 20, 'found the Android sources');
  const hits = files.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return UNSUPPORTED.filter((flag) => new RegExp(`Pattern\\.${flag}\\b`).test(source)).map((flag) => `${file.pathname.split('/java/').at(-1)}: ${flag}`);
  });
  assert.deepEqual(hits, []);
});
