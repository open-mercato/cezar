/**
 * The managed install layout (PoC of the self-update design):
 *
 *   ~/.cezar/versions/<id>/                       one `npm install --prefix` tree per version
 *   ~/.cezar/versions/<id>/.cezar-install.json    manifest: version, source, installedAt
 *   ~/.cezar/versions/<id>/node_modules/@open-mercato/cezar/dist/index.js   the entry
 *   ~/.cezar/versions/current  →  <id>            the active version (a symlink; a junction on
 *                                                 Windows)
 *   ~/.cezar/bin/cezar, cez                       launchers that exec `current`'s entry
 *
 * `<id>` is the version string, plus `+local` for a build installed from a checkout so it never
 * collides with the registry release it was cut from.
 *
 * A LINKED checkout (`cezar link`, source `link`) is the development variant: instead of a copy,
 * `versions/<version>+<branch>/node_modules/@open-mercato/cezar` is a symlink (a junction on
 * Windows) to a worktree's `packages/cezar`. Node runs the entry through its realpath, so the
 * checkout's own `node_modules` resolve, and every rebuild of that worktree is live on the next
 * restart. Anything that reads `current` — the launchers, the desktop shell — runs it unchanged.
 * Removing a link removes the link, never the checkout. Everything is under `cezarHomeDir()` so
 * `CEZ_HOME` keeps tests off the real home. Delete the whole directory and `cezar install`
 * rebuilds it — state, never configuration.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';

import { cezarHomeDir } from '../paths.ts';

export const PACKAGE_NAME = '@open-mercato/cezar';
export const CURRENT_LINK = 'current';
const MANIFEST_FILE = '.cezar-install.json';

export type InstallKind = 'managed' | 'global-npm' | 'npx' | 'checkout' | 'unknown';

export function versionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(cezarHomeDir(env), 'versions');
}

export function binDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(cezarHomeDir(env), 'bin');
}

/**
 * A version id becomes a DIRECTORY NAME under `versions/`, and `installSpec` `rm -rf`s the path
 * it resolves to — so an id that can climb out of `versions/` is a wipe of whatever it lands on.
 * The wire schema (`selfUpdateApplyRequestSchema`) bounds the charset but still admits `..`, and
 * npm rejecting `@open-mercato/cezar@..` today is a coincidence of npm's parser, not a guard we
 * own. Require a leading alphanumeric and forbid `..` outright: every real version id
 * (`0.12.0`, `0.12.0+local`, `0.12.0-nightly.20260927.60`) passes untouched.
 */
export function assertSafeId(id: string): string {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(id) || id.includes('..')) throw new Error(`invalid version id: ${id}`);
  return id;
}

export function versionDir(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(versionsDir(env), assertSafeId(id));
}

/** The entry file inside one installed version's tree. */
export function versionEntry(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(versionDir(id, env), 'node_modules', ...PACKAGE_NAME.split('/'), 'dist', 'index.js');
}

/** The entry the launcher execs: through `current`, so a swap never edits the launcher. */
export function currentEntry(env: NodeJS.ProcessEnv = process.env): string {
  return join(versionsDir(env), CURRENT_LINK, 'node_modules', ...PACKAGE_NAME.split('/'), 'dist', 'index.js');
}

const manifestSchema = z
  .object({
    version: z.string(),
    source: z.enum(['registry', 'local', 'link']),
    installedAt: z.string(),
    /** `link` only: the linked package root (`<worktree>/packages/cezar`) and its branch. */
    checkout: z.string().optional(),
    branch: z.string().optional(),
  })
  .passthrough();
export type InstallManifest = z.infer<typeof manifestSchema>;

export function readManifest(id: string, env: NodeJS.ProcessEnv = process.env): InstallManifest | null {
  try {
    const parsed = manifestSchema.safeParse(JSON.parse(readFileSync(join(versionDir(id, env), MANIFEST_FILE), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeManifest(id: string, manifest: InstallManifest, env: NodeJS.ProcessEnv = process.env): void {
  const dir = versionDir(id, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Directory id for a version from a given source — local builds get the `+local` suffix. */
export function installId(version: string, source: 'registry' | 'local'): string {
  return source === 'local' ? `${version}+local` : version;
}

export interface InstalledEntry extends InstallManifest {
  id: string;
  active: boolean;
}

/** Every complete install under `versions/` (a manifest AND an entry file), newest first. */
export function listInstalled(env: NodeJS.ProcessEnv = process.env): InstalledEntry[] {
  const dir = versionsDir(env);
  if (!existsSync(dir)) return [];
  const active = activeId(env);
  const out: InstalledEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (name === CURRENT_LINK || name.startsWith('.')) continue;
    const manifest = readManifest(name, env);
    if (!manifest || !existsSync(versionEntry(name, env))) continue;
    out.push({ ...manifest, id: name, active: name === active });
  }
  return out.sort((a, b) => b.installedAt.localeCompare(a.installedAt));
}

/** Resolve an apply target to an installed entry: an exact id (`0.11.1+local`) first, else a
 *  REGISTRY install of that version — a local build never stands in for the published release
 *  it was cut from, or `cezar update` on a checkout would only ever re-activate the checkout. */
export function findInstalled(target: string, env: NodeJS.ProcessEnv = process.env): InstalledEntry | undefined {
  const installed = listInstalled(env);
  return installed.find((entry) => entry.id === target) ?? installed.find((entry) => entry.source === 'registry' && entry.version === target);
}

/** The id `current` points at, or null when nothing is activated. */
export function activeId(env: NodeJS.ProcessEnv = process.env): string | null {
  const link = join(versionsDir(env), CURRENT_LINK);
  // Read, never check-then-read: `readlink` on something that is not a link fails, and that
  // failure is what selects the text-file fallback.
  try {
    return basename(readlinkSync(link));
  } catch {
    try {
      return readFileSync(link, 'utf8').trim() || null;
    } catch {
      return null;
    }
  }
}

/**
 * Point `current` at `id`. Atomic on POSIX: the new link is created beside the old one and
 * renamed over it, so a reader never sees a missing `current`.
 *
 * Windows links with a JUNCTION — a directory link that needs no privilege, where a symlink
 * needs developer mode or elevation. Two things differ there: a junction's target must be
 * absolute (Node resolves a relative one against the working directory, not against the link),
 * and Windows will not rename a link over an existing one, so the old link is removed first.
 * The desktop shell does the same (`activate` in packages/desktop/src-tauri/src/lib.rs).
 */
/** Remove `current` itself — a junction, a symlink or the legacy text file — and never the
 *  version behind it: `unlink` and `rmdir` both act on a link, not through it. */
function removeLink(link: string): void {
  for (const remove of [unlinkSync, rmdirSync]) {
    try {
      remove(link);
      return;
    } catch {
      // Not that kind of entry, or not there at all: the next one, then the create decides.
    }
  }
}

export function activate(id: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(versionEntry(id, env))) throw new Error(`version ${id} is not installed`);
  const dir = versionsDir(env);
  const link = join(dir, CURRENT_LINK);
  const tmp = join(dir, `.${CURRENT_LINK}.${process.pid}.tmp`);
  if (process.platform === 'win32') {
    removeLink(link);
    symlinkSync(versionDir(id, env), link, 'junction');
    return;
  }
  rmSync(tmp, { force: true });
  symlinkSync(id, tmp, 'dir');
  renameSync(tmp, link);
}

export function removeInstalled(id: string, env: NodeJS.ProcessEnv = process.env): void {
  if (id === activeId(env)) throw new Error(`version ${id} is active — switch first`);
  // `rmSync` never follows symlinks, so a linked checkout loses its link, not its files.
  rmSync(versionDir(id, env), { recursive: true, force: true });
}

/** Build metadata for a branch name: `cez/cb28888e` → `cez-cb28888e`. */
export function branchSlug(branch: string): string {
  return branch
    .replace(/[^0-9A-Za-z-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** The id a linked checkout gets: `<version>+<branch slug>` — semver build metadata, so it
 *  orders as its version everywhere and still reads as the branch in every version list. */
export function linkId(version: string, branch: string): string {
  const slug = branchSlug(branch) || 'checkout';
  return assertSafeId(`${version}+${slug}`);
}

export interface LinkResult {
  id: string;
  version: string;
  entry: string;
}

/**
 * Register a built checkout's package root (the directory holding `@open-mercato/cezar`'s
 * package.json and `dist/index.js`) as a version: a link, not a copy. Re-linking the same
 * checkout replaces its previous entry (the version or branch may have moved since); a
 * DIFFERENT checkout that would get the same id gets a path-derived suffix instead.
 */
export function linkCheckout(packageRoot: string, branch: string, env: NodeJS.ProcessEnv = process.env): LinkResult {
  let root = resolve(packageRoot);
  try {
    root = realpathSync(root);
  } catch {
    // Missing: the package.json read below says so.
  }
  let pkg: { name?: unknown; version?: unknown } | null = null;
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
  } catch {
    pkg = null;
  }
  if (!pkg || pkg.name !== PACKAGE_NAME || typeof pkg.version !== 'string') throw new Error(`${root} is not a ${PACKAGE_NAME} package`);
  if (!existsSync(join(root, 'dist', 'index.js'))) throw new Error(`${root} is not built — run \`npm run build\` in the checkout first`);
  const version = pkg.version;

  const installed = listLinks(env);
  for (const entry of installed) {
    if (entry.checkout === root && entry.id !== activeId(env)) removeInstalled(entry.id, env);
  }
  let id = linkId(version, branch);
  const clash = readManifest(id, env);
  if (clash && clash.checkout !== root) id = assertSafeId(`${id}.${shortHash(root)}`);

  const scopeDir = join(versionDir(id, env), 'node_modules', ...PACKAGE_NAME.split('/').slice(0, -1));
  const link = join(scopeDir, PACKAGE_NAME.split('/').pop()!);
  mkdirSync(scopeDir, { recursive: true });
  removeLink(link);
  symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
  writeManifest(id, { version, source: 'link', installedAt: new Date().toISOString(), checkout: root, branch }, env);
  return { id, version, entry: versionEntry(id, env) };
}

/** Every linked checkout, dangling ones included (a worktree that was removed) — `listInstalled`
 *  hides those, but they still need finding to be pruned or replaced. */
export function listLinks(env: NodeJS.ProcessEnv = process.env): InstalledEntry[] {
  const dir = versionsDir(env);
  if (!existsSync(dir)) return [];
  const active = activeId(env);
  const out: InstalledEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (name === CURRENT_LINK || name.startsWith('.')) continue;
    const manifest = readManifest(name, env);
    if (manifest?.source === 'link') out.push({ ...manifest, id: name, active: name === active });
  }
  return out;
}

function shortHash(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  return hash.toString(36).slice(0, 6);
}

/**
 * How the running entry file was installed. Decides what the dialog offers:
 *   managed     → `~/.cezar/versions/…` — self-update works
 *   global-npm  → `npm i -g` prefix (`…/lib/node_modules/@open-mercato/cezar/…`) — update via npm
 *   npx         → the `_npx` cache — nothing to update in place; offer `cezar install`
 *   checkout    → a git checkout (`packages/cezar/dist/index.js` beside `src/`) — dev mode
 */
export function detectInstallKind(entry: string, env: NodeJS.ProcessEnv = process.env): InstallKind {
  const normalized = resolve(entry).split(sep).join('/');
  const managedRoot = resolve(versionsDir(env)).split(sep).join('/');
  if (normalized.startsWith(`${managedRoot}/`)) return 'managed';
  if (normalized.includes('/_npx/')) return 'npx';
  if (normalized.includes('/node_modules/')) return 'global-npm';
  // A checkout: dist/index.js with a sibling src/ (published tarballs ship no src/).
  const packageRoot = dirname(dirname(resolve(entry)));
  if (existsSync(join(packageRoot, 'src')) && existsSync(join(packageRoot, 'package.json'))) return 'checkout';
  return 'unknown';
}

/** The package root (the directory holding package.json) for a running entry file. */
export function packageRootOf(entry: string): string {
  return dirname(dirname(resolve(entry)));
}
