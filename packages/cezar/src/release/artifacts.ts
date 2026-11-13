/** Disk-side release invariants shared by stable, preview and release-line stamping. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ADAPTER_KEYS, type ReleaseManifests } from './manifests.ts';

export function adapterManifestWrites(
  dirs: Record<keyof ReleaseManifests, string>,
  before: ReleaseManifests,
  after: ReleaseManifests,
): Array<{ path: string; content: string }> {
  // Validate ALL inputs before writing anything. Missing/mismatched manifests must
  // fail the release, never produce an npm package the extension installer rejects.
  return ADAPTER_KEYS.map((key) => {
    const path = join(dirs[key], 'cezar-extension.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (manifest.version !== before[key].version) {
      throw new Error(`${key}: package.json and cezar-extension.json versions disagree`);
    }
    return { path, content: `${JSON.stringify({ ...manifest, version: after[key].version }, null, 2)}\n` };
  });
}

export function writeAdapterManifests(writes: ReturnType<typeof adapterManifestWrites>): void {
  for (const { path, content } of writes) writeFileSync(path, content, 'utf8');
}

/** Stamping changes the inputs to the bundled catalog/digests. Rebuild and run
 * the pack gate before any publish, including dry runs. Miniature test workspaces
 * may have no build; real repository releases always declare one. */
export function rebuildReleaseArtifacts(root: string): void {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  if (!pkg.scripts?.build) return;
  const npm = process.env.npm_execpath;
  execFileSync(npm ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm',
    npm ? [npm, 'run', 'build'] : ['run', 'build'], {
      cwd: root, stdio: 'inherit', timeout: 600_000,
      shell: !npm && process.platform === 'win32',
    });
}
