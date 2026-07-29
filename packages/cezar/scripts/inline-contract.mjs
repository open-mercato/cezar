/**
 * Inline `@open-mercato/cezar-contract` into `dist` after `tsc`.
 *
 * The contract is a real workspace package — that is how the source reads, and how every
 * developer and the api-client consume it. But this package IS published and the contract is not,
 * so a `dist` that imported it by name would install broken: `npm i -g @open-mercato/cezar` would
 * fail to resolve it. Inlining at the artifact level keeps both properties — a clean package
 * dependency in source, a self-contained tarball on npm — and is the ordinary thing a bundler
 * would do, except this package builds with plain `tsc`.
 *
 * Deliberately NOT a source-level copy: the earlier attempt copied `src/` between packages, which
 * hid the dependency from the package graph. Here the source always names the package; only the
 * emitted output is rewritten.
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
const from = join(here, '..', '..', 'contract', 'dist');
const to = join(dist, 'contract');

const SPEC = /(['"])@open-mercato\/cezar-contract\1/g;

/** Every emitted file that names the package, so the copy only happens when it is actually used. */
const referrers = [];
const scan = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (p !== to) scan(p);
    } else if (/\.(js|d\.ts|js\.map)$/.test(entry.name)) {
      SPEC.lastIndex = 0;
      if (SPEC.test(readFileSync(p, 'utf8'))) referrers.push(p);
    }
  }
};
scan(dist);

// Nothing in the shipped output names it — today the server uses the contract only from tests,
// which never reach `dist`. Copying anyway would put dead files in the published tarball.
rmSync(to, { recursive: true, force: true });
if (referrers.length === 0) {
  console.log('inline-contract ok — nothing in dist references the contract, nothing inlined');
  process.exit(0);
}

if (!statSync(from, { throwIfNoEntry: false })) {
  throw new Error('inline-contract: packages/contract/dist is missing — build the contract first');
}
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
let rewritten = 0;
for (const p of referrers) {
  // `./contract` relative to THIS file, so nesting depth is handled rather than assumed.
  let rel = relative(dirname(p), join(to, 'index.js')).replaceAll('\\', '/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  writeFileSync(p, readFileSync(p, 'utf8').replace(SPEC, `'${rel}'`), 'utf8');
  rewritten += 1;
}
console.log(`inline-contract ok — contract inlined, ${rewritten} file(s) repointed`);
