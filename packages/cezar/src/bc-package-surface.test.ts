import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The `BACKWARD_COMPATIBILITY.md` §6 package-surface drift guard (#853).
 *
 * §6 declares the published npm surface protected, but the declaration is prose and nothing
 * verified it against the manifest it describes. It didn't match: the package split (#695)
 * added an `exports` map and dropped `web/open-mercato.svg` from `files` while §6 kept saying
 * "there is **no** `exports`/library API" and kept listing the svg, and the `cezar-cli` bin had
 * been missing from §1 and §6 since it was added.
 *
 * That drift was not cosmetic. The undocumented `exports` map silently governed resolution:
 * once a package declares one, Node serves ONLY the listed subpaths and hard-blocks the rest,
 * so the alias's `import('@open-mercato/cezar/dist/index.js')` died with
 * ERR_PACKAGE_PATH_NOT_EXPORTED at every user (#851, fixed in #852) — an undocumented surface
 * breaking a documented one. `test/e2e/alias-bin-exports.test.ts` pins that specific resolution;
 * this pins the *description*, so the next manifest change cannot ship undocumented.
 *
 * Like the §2 route inventory guard (`server/bc-route-inventory.test.ts`), this is the cause fix
 * rather than the instance fix — it would have failed on the commit that introduced each of the
 * three drifts above.
 *
 * Deliberately loose about prose, strict about lists: it reads only the enumerations §6 spells
 * out in backticks, so the section can be rewritten, reordered or expanded freely as long as the
 * names it names stay true. Manifest paths are package-relative and §6 sometimes says where a
 * path lands in the repo, which is why the `files` comparison normalizes the `packages/cezar/`
 * prefix away rather than demanding one spelling.
 */

const REPO_ROOT = join(import.meta.dirname, '../../..');
const doc = readFileSync(join(REPO_ROOT, 'BACKWARD_COMPATIBILITY.md'), 'utf8');
const manifest = JSON.parse(
  readFileSync(join(REPO_ROOT, 'packages/cezar/package.json'), 'utf8'),
) as { bin: Record<string, string>; files: string[]; exports: Record<string, string> };

/** The text of one `## <n>. …` section, up to the next one. */
export function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  if (start === -1) throw new Error(`BACKWARD_COMPATIBILITY.md has no "${heading}" section`);
  const end = markdown.indexOf('\n## ', start + heading.length);
  return markdown.slice(start, end === -1 ? undefined : end);
}

/** Every `backticked` token in a slice of prose. */
export function backticked(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] as string);
}

/**
 * The backticked names in the clause introduced by `label`, which runs to the next `;` — the
 * shape §6 writes its two inline enumerations in ("`bin` entries `a`, `b` + `c`; published
 * `files`: …"). The label itself is dropped, so its own backticks never leak into the result.
 */
export function clauseNames(text: string, label: string): string[] {
  const start = text.indexOf(label);
  if (start === -1) throw new Error(`§6 no longer contains the "${label}" clause`);
  const from = start + label.length;
  const end = text.indexOf(';', from);
  return backticked(text.slice(from, end === -1 ? undefined : end));
}

/** `packages/cezar/web/dist` and `web/dist` are the same published entry, said two ways. */
function normalizeFile(path: string): string {
  return path.replace(/^packages\/cezar\//, '').replace(/\/+$/, '');
}

const packageSurface = section(doc, '## 6. npm package surface');

describe('BACKWARD_COMPATIBILITY.md §6 package surface', () => {
  it('names exactly the manifest bin entries', () => {
    expect(new Set(clauseNames(packageSurface, '`bin` entries'))).toEqual(
      new Set(Object.keys(manifest.bin)),
    );
  });

  it('names exactly the manifest files entries', () => {
    expect(new Set(clauseNames(packageSurface, 'published `files`:').map(normalizeFile))).toEqual(
      new Set(manifest.files.map(normalizeFile)),
    );
  });

  it('names exactly the manifest exports subpaths', () => {
    // The bullet names both sides of the map (`./app-type` → `./dist/server/app-type.js`); the
    // targets are what the subpaths resolve TO, not subpaths themselves, so they are folded away
    // and what remains has to be the keys. Anything else backticked in the bullet — prose, error
    // codes, file paths — is not `.`-rooted and never enters the comparison.
    //
    // `./package.json` maps to itself, so folding targets blindly would fold a real subpath out
    // of the comparison and let it vanish from the docs unnoticed: only targets that are not
    // themselves keys count as targets.
    const subpaths = new Set(Object.keys(manifest.exports));
    const targets = new Set(Object.values(manifest.exports).filter((to) => !subpaths.has(to)));
    const bullet = packageSurface
      .split('\n')
      .find((line) => line.includes('`exports`') && line.includes('subpaths'));
    expect(bullet, '§6 no longer has a bullet describing the `exports` subpaths').toBeDefined();

    const named = backticked(bullet!).filter((token) => /^\.(\/\S*)?$/.test(token));
    expect(new Set(named.filter((token) => !targets.has(token)))).toEqual(subpaths);
  });

  it('says an exports change is breaking', () => {
    // The map is the whole reason #851 was reachable; §6 promising to keep it is the point of
    // documenting it at all, so a rewrite that quietly drops the promise fails here.
    const breaking = packageSurface.slice(packageSurface.indexOf('\nBreaking:'));
    expect(breaking).toMatch(/`exports`/);
  });

  it('reads a non-trivial number of names on both sides — guards against a vacuous pass', () => {
    // Without this, a parser that silently stopped seeing the enumerations would pass the guards
    // above by comparing two empty sets, which is the one failure mode a drift guard must not
    // have. The manifest side is asserted too: a manifest read that returned `{}` would be just
    // as invisible.
    expect(clauseNames(packageSurface, '`bin` entries').length).toBeGreaterThan(2);
    expect(clauseNames(packageSurface, 'published `files`:').length).toBeGreaterThan(3);
    expect(Object.keys(manifest.bin).length).toBeGreaterThan(2);
    expect(Object.keys(manifest.exports).length).toBeGreaterThan(2);
  });
});

describe('BACKWARD_COMPATIBILITY.md §1 bins', () => {
  it('names exactly the manifest bin entries', () => {
    // §1 lists the bins too, from the CLI's side. It drifted the same way §6 did (`cezar-cli`
    // missing from both), so it gets the same guard — a doc that contradicts itself is worse
    // than one that is merely stale.
    const cli = section(doc, '## 1. CLI commands');
    const bins = cli.split('\n').find((line) => line.startsWith('- **Bins:**'));
    expect(bins, '§1 no longer has a `- **Bins:**` line').toBeDefined();
    const named = backticked(bins!.slice(0, bins!.indexOf('(')));
    expect(new Set(named)).toEqual(new Set(Object.keys(manifest.bin)));
  });
});
