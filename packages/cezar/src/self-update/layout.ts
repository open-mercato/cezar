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
 * collides with the registry release it was cut from. Everything is under `cezarHomeDir()` so
 * `CEZ_HOME` keeps tests off the real home. Delete the whole directory and `cezar install`
 * rebuilds it — state, never configuration.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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
    source: z.enum(['registry', 'local']),
    installedAt: z.string(),
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
  rmSync(versionDir(id, env), { recursive: true, force: true });
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
