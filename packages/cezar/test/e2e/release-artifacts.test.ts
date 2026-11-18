import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { adapterManifestWrites, writeAdapterManifests } from '../../src/release/artifacts.ts';
import { ADAPTER_KEYS, type ReleaseManifests } from '../../src/release/manifests.ts';
import { stampStableManifests } from '../../src/release/stable.ts';
import { stampManifests } from '../../src/release/snapshot.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const locations = {
  extensionSdk: 'packages/extension-sdk', telegram: 'packages/chat-plugins/telegram',
  contract: 'packages/contract', apiClient: 'packages/api-client', cezar: 'packages/cezar',
  alias: 'alias-cezar', runAlias: 'alias-cezar-run',
};

for (const channel of ['stable', 'snapshot'] as const) {
  test(`${channel} preserves the npm installation version invariant in actual packed manifests`, { timeout: 120_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), 'cezar-release-artifacts-'));
    try {
      const before = Object.fromEntries(Object.entries(locations).map(([key, dir]) =>
        [key, JSON.parse(readFileSync(join(repo, dir, 'package.json'), 'utf8'))])) as unknown as ReleaseManifests;
      const dirs = Object.fromEntries(Object.entries(locations).map(([key, dir]) => [key, join(root, dir)])) as Record<keyof ReleaseManifests, string>;
      for (const key of ADAPTER_KEYS) {
        mkdirSync(dirs[key], { recursive: true });
        writeFileSync(join(dirs[key], 'cezar-extension.json'), readFileSync(join(repo, locations[key], 'cezar-extension.json')));
      }
      const after = channel === 'stable' ? stampStableManifests(before, '0.99.0') : stampManifests(before, '0.99.0-pr77.5');
      writeAdapterManifests(adapterManifestWrites(dirs, before, after));
      for (const key of ADAPTER_KEYS) {
        writeFileSync(join(dirs[key], 'package.json'), JSON.stringify(after[key]));
        const output = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--ignore-scripts', '--offline', '--json'],
          { cwd: dirs[key], encoding: 'utf8', timeout: 30_000, shell: process.platform === 'win32' });
        const filename = (JSON.parse(output) as Array<{ filename: string }>)[0]!.filename;
        const extract = (name: string) => JSON.parse(execFileSync('tar', ['-xOf', join(dirs[key], filename), `package/${name}`], { encoding: 'utf8', timeout: 10_000 }));
        const pkg = extract('package.json');
        const extension = extract('cezar-extension.json');
        assert.equal(extension.version, pkg.version);
        assert.equal(pkg.version, channel === 'stable' ? before[key].version : `${before[key].version}-pr77.5`);
        assert.equal(extension.id, `open-mercato.${key}`);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
