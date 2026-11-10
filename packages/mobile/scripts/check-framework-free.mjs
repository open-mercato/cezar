// Capacitor is not finally accepted (spec Q2), so the auth classes must survive dropping it:
// only the listed adapters may name the framework. Firebase stays in its adapter too, and the push
// logic names no Android at all, so the JVM tests run it as shipped. `--selftest` proves the patterns still bite.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLAIN_DIRS = ['android/app/src/main/java/com/openmercato/cezar/mobile/shell', 'ios/App/App/Shell'];
const FRAMEWORK = [/\bimport\s+(static\s+)?com\.getcapacitor\b/, /\bcom\.getcapacitor\./, /\bimport\s+(class\s+|struct\s+|func\s+)?Capacitor\b/, /\bimport\s+Cordova\b/, /\borg\.apache\.cordova\b/, /\bCAP[A-Z]\w+/,
  /\bcom\.google\.firebase\b/, /\bcom\.google\.android\.gms\b/, /\bimport\s+Firebase\w*\b/];
// Stricter still: plain Java with no platform, under the JVM tests.
const PLATFORM_FREE_DIRS = ['android/app/src/main/java/com/openmercato/cezar/mobile/shell/push'];
const PLATFORM = [/\bimport\s+(static\s+)?androidx?\./, /\bandroidx?\.[a-z]+\.[A-Z]/];
// The classes the assignment names. A rename must not quietly drop one out of the check.
const REQUIRED = {
  android: ['BasicChallengeResponder.java', 'CredentialStore.java', 'HealthProbe.java', 'StartDecision.java', 'ServerActivity.java', 'PushCoordinator.java', 'GrantClient.java', 'PushTap.java'],
  ios: ['BasicChallengeResponder.swift', 'CredentialStore.swift', 'HealthProbe.swift', 'StartDecision.swift', 'ServerViewController.swift'],
};

export function offenders(source, patterns = FRAMEWORK) {
  return source.split('\n').flatMap((line, index) => (patterns.some((pattern) => pattern.test(line)) ? [`${index + 1}: ${line.trim()}`] : []));
}

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(java|kt|swift)$/.test(name) ? [path] : [];
  });
}

if (process.argv.includes('--selftest')) {
  const hits = ['import com.getcapacitor.Plugin;', 'import Capacitor', 'import class Capacitor.CAPPlugin', 'final class X: CAPPlugin {}', 'import Cordova',
    'import com.google.firebase.messaging.FirebaseMessaging;', 'import com.google.android.gms.tasks.Tasks;', 'import FirebaseMessaging'];
  const missed = hits.filter((line) => offenders(line).length === 0);
  const falseHit = offenders('import Foundation\nimport android.webkit.WebView;\n// Capacitor hosts the connect page only.');
  const platformHits = ['import android.content.Context;', 'import androidx.core.app.NotificationCompat;', 'android.util.Log.d("x", "y");'];
  const platformMissed = platformHits.filter((line) => offenders(line, PLATFORM).length === 0);
  const platformFalseHit = offenders('import okhttp3.OkHttpClient;\nimport org.json.JSONObject;\n// android push token', PLATFORM);
  if (missed.length || falseHit.length || platformMissed.length || platformFalseHit.length) {
    console.error('selftest failed', { missed, falseHit, platformMissed, platformFalseHit });
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
for (const dir of PLATFORM_FREE_DIRS) {
  for (const file of sources(join(root, dir))) {
    for (const hit of offenders(readFileSync(file, 'utf8'), PLATFORM)) {
      console.error(`${relative(root, file)}:${hit}`);
      failed = true;
    }
  }
}
if (failed) {
  console.error('A plain native class names the framework, Firebase, or (under shell/push) Android. Move that line to an adapter.');
  process.exit(1);
}
console.log('plain native classes are framework-free');
