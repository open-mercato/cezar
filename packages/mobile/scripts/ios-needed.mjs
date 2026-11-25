// Decides whether mobile-check's macOS iOS job must run for a change. It runs unless every changed
// path is known not to reach the iOS build or the Swift tests, so a new directory runs it by default.
// Reads changed paths (one per line) on stdin and prints `ios=true|false` for $GITHUB_OUTPUT.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MOBILE = 'packages/mobile/';
// Under packages/mobile: Android-only code, store listings and prose never reach iOS.
const NOT_IOS = [/^android\//, /^store\//, /\.md$/];
// Outside packages/mobile: only these feed the iOS job (the Swift tests read the relay vectors).
const IOS_FROM_OUTSIDE = [/^test-vectors\/relay\//, /^\.github\/workflows\/mobile-check\.yml$/];

/** `true` when any changed path can affect the iOS build or the Swift tests; no paths at all is `true`. */
export function iosNeeded(paths) {
  const changed = paths.map((path) => path.trim()).filter(Boolean);
  if (changed.length === 0) return true;
  return changed.some((path) => {
    if (path.startsWith(MOBILE)) return !NOT_IOS.some((pattern) => pattern.test(path.slice(MOBILE.length)));
    return IOS_FROM_OUTSIDE.some((pattern) => pattern.test(path));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`ios=${iosNeeded(readFileSync(0, 'utf8').split('\n'))}`);
}
