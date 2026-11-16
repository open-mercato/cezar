// Capacitor is not finally accepted (spec Q2), so the auth classes must survive dropping it:
// only the listed adapters may name the framework. `--selftest` proves the patterns still bite.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLAIN_DIRS = ['android/app/src/main/java/com/openmercato/cezar/mobile/shell', 'ios/App/App/Shell'];
const FRAMEWORK = [/\bimport\s+(static\s+)?com\.getcapacitor\b/, /\bcom\.getcapacitor\./, /\bimport\s+(class\s+|struct\s+|func\s+)?Capacitor\b/, /\bimport\s+Cordova\b/, /\borg\.apache\.cordova\b/, /\bCAP[A-Z]\w+/];
// The classes the assignment names. A rename must not quietly drop one out of the check.
const REQUIRED = {
  android: ['BasicChallengeResponder.java', 'CredentialStore.java', 'HealthProbe.java', 'StartDecision.java', 'ServerActivity.java'],
  ios: ['BasicChallengeResponder.swift', 'CredentialStore.swift', 'HealthProbe.swift', 'StartDecision.swift', 'ServerViewController.swift'],
};

export function offenders(source) {
  return source.split('\n').flatMap((line, index) => (FRAMEWORK.some((pattern) => pattern.test(line)) ? [`${index + 1}: ${line.trim()}`] : []));
}

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(java|kt|swift)$/.test(name) ? [path] : [];
  });
}

if (process.argv.includes('--selftest')) {
  const hits = ['import com.getcapacitor.Plugin;', 'import Capacitor', 'import class Capacitor.CAPPlugin', 'final class X: CAPPlugin {}', 'import Cordova'];
  const missed = hits.filter((line) => offenders(line).length === 0);
  const falseHit = offenders('import Foundation\nimport android.webkit.WebView;\n// Capacitor hosts the connect page only.');
  if (missed.length || falseHit.length) {
    console.error('selftest failed', { missed, falseHit });
    process.exit(1);
  }
  console.log('selftest ok');
  process.exit(0);
}

let failed = false;
for (const [index, dir] of PLAIN_DIRS.entries()) {
  const files = sources(join(root, dir));
  const names = files.map((file) => file.split('/').pop());
  for (const name of Object.values(REQUIRED)[index]) {
    if (!names.includes(name)) {
      console.error(`missing plain class: ${dir}/${name}`);
      failed = true;
    }
  }
  for (const file of files) {
    for (const hit of offenders(readFileSync(file, 'utf8'))) {
      console.error(`${relative(root, file)}:${hit}`);
      failed = true;
    }
  }
}
if (failed) {
  console.error('A plain native class names the framework. Move that line to an adapter.');
  process.exit(1);
}
console.log('plain native classes are framework-free');
