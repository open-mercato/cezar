import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { currentEntry, activate, activeId, assertSafeId, detectInstallKind, installId, listInstalled, versionDir, versionEntry, versionsDir, writeManifest } from './layout.ts';
import { fetchPackageDocument, registryPath } from './registry.ts';
import { restartArgs } from './restart.ts';
import { classifyVersion, compareVersions, isNewer } from './semver.ts';

describe('semver', () => {
  it('orders releases numerically, not lexically', () => {
    expect(compareVersions('1.2.10', '1.2.9')).toBe(1);
    expect(compareVersions('0.11.1', '0.9.2')).toBe(1);
    expect(compareVersions('0.11.1', '0.11.1')).toBe(0);
  });

  it('ranks a release above every prerelease of the same core, and nightlies by date', () => {
    expect(isNewer('0.11.1', '0.11.1-nightly.20260924.49')).toBe(true);
    expect(isNewer('0.11.1-nightly.20260924.49', '0.11.1')).toBe(false);
    expect(isNewer('0.11.1-nightly.20260925.50', '0.11.1-nightly.20260924.49')).toBe(true);
    expect(isNewer('0.11.2-nightly.20260901.1', '0.11.1')).toBe(true);
  });

  it('classifies dist-tag families from the prerelease identifier', () => {
    expect(classifyVersion('0.11.1')).toBe('stable');
    expect(classifyVersion('0.11.1-nightly.20260924.49')).toBe('nightly');
    expect(classifyVersion('0.9.2-pr743.1156.2')).toBe('preview');
    expect(classifyVersion('0.1.5-develop.124')).toBe('preview');
  });

  // An unparseable version must never reach the picker as a release: `status()` keeps only
  // non-preview entries, so `preview` is what drops registry junk instead of offering it.
  it('treats an unparseable version as a preview, never as a stable release', () => {
    expect(classifyVersion('not-a-version')).toBe('preview');
    expect(classifyVersion('')).toBe('preview');
    expect(classifyVersion('0.11')).toBe('preview');
  });
});

describe('managed layout', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-self-update-'));
    env = { ...process.env, CEZ_HOME: home };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const fakeInstall = (id: string, version: string, source: 'registry' | 'local') => {
    const entry = versionEntry(id, env);
    mkdirSync(join(entry, '..'), { recursive: true });
    writeFileSync(entry, '// entry\n');
    writeManifest(id, { version, source, installedAt: new Date(Date.parse('2026-09-25T10:00:00Z') + (source === 'local' ? 1 : 0)).toISOString() }, env);
  };

  it('lists complete installs only and flips `current` atomically', () => {
    fakeInstall('0.11.0', '0.11.0', 'registry');
    fakeInstall('0.11.1+local', '0.11.1', 'local');
    // A manifest without an entry file is a torn install and must not be offered.
    writeManifest('0.10.0', { version: '0.10.0', source: 'registry', installedAt: '2026-09-01T00:00:00Z' }, env);

    expect(listInstalled(env).map((entry) => entry.id)).toEqual(['0.11.1+local', '0.11.0']);
    expect(activeId(env)).toBeNull();

    activate('0.11.0', env);
    expect(activeId(env)).toBe('0.11.0');
    // The link's NAME is the id on every platform; its target is relative on POSIX and
    // absolute on Windows, where `current` is a junction.
    expect(basename(readlinkSync(join(versionsDir(env), 'current')))).toBe('0.11.0');
    expect(existsSync(currentEntry(env))).toBe(true);

    activate('0.11.1+local', env);
    expect(activeId(env)).toBe('0.11.1+local');
    expect(listInstalled(env).find((entry) => entry.active)?.id).toBe('0.11.1+local');
    // Replacing a link leaves the version it used to point at in place.
    expect(existsSync(currentEntry(env))).toBe(true);
    expect(existsSync(versionEntry('0.11.0', env))).toBe(true);
    expect(existsSync(join(versionsDir(env), `.current.${process.pid}.tmp`))).toBe(false);
    expect(() => activate('9.9.9', env)).toThrow(/not installed/);
  });

  it('derives the install id from the source', () => {
    expect(installId('0.11.1', 'registry')).toBe('0.11.1');
    expect(installId('0.11.1', 'local')).toBe('0.11.1+local');
  });

  // `versionDir` is the path `installSpec` rm -rf's before it renames staging into place, so an
  // id that climbs out of `versions/` is a wipe of whatever it lands on. The wire schema's
  // charset alone still admits `..`; the layout has to refuse it itself.
  it('refuses a version id that could escape the versions directory', () => {
    for (const id of ['..', '.', '.hidden', '0.11.1/../..', 'a..b', '']) {
      expect(() => assertSafeId(id)).toThrow(/invalid version id/);
      expect(() => versionDir(id, env)).toThrow(/invalid version id/);
    }
    for (const id of ['0.12.0', '0.12.0+local', '0.12.0-nightly.20260927.60', '0.9.2-pr743.1156.2']) {
      expect(assertSafeId(id)).toBe(id);
      expect(versionDir(id, env)).toBe(join(versionsDir(env), id));
    }
  });

  // A bad id must not take the listing down with it. `versionDir` throws for these names now,
  // so the graceful skip has to come from `readManifest`'s own catch — none of them is
  // dot-prefixed, so the pre-existing `startsWith('.')` skip cannot be what saves the listing.
  it('skips an unsafe directory name instead of throwing out of listInstalled', () => {
    fakeInstall('0.11.0', '0.11.0', 'registry');
    for (const junk of ['a..b', '-weird', 'has space', '0.1.0;rm']) {
      mkdirSync(join(versionsDir(env), junk), { recursive: true });
    }
    expect(listInstalled(env).map((entry) => entry.id)).toEqual(['0.11.0']);
  });

  it('tells install kinds apart by where the entry file lives', () => {
    expect(detectInstallKind(versionEntry('0.11.1', env), env)).toBe('managed');
    expect(detectInstallKind('/Users/x/.npm/_npx/abc123/node_modules/@open-mercato/cezar/dist/index.js', env)).toBe('npx');
    expect(detectInstallKind('/opt/homebrew/lib/node_modules/@open-mercato/cezar/dist/index.js', env)).toBe('global-npm');
    const checkout = join(home, 'repo', 'packages', 'cezar');
    mkdirSync(join(checkout, 'src'), { recursive: true });
    mkdirSync(join(checkout, 'dist'), { recursive: true });
    writeFileSync(join(checkout, 'package.json'), '{}');
    expect(detectInstallKind(join(checkout, 'dist', 'index.js'), env)).toBe('checkout');
    expect(detectInstallKind(join(home, 'elsewhere', 'index.js'), env)).toBe('unknown');
  });
});

describe('restart args', () => {
  it('keeps the command and flags, pins the port and never opens a second tab', () => {
    expect(restartArgs(['serve', '--repo', '/x', '--port', '4000'], 4321)).toEqual(['serve', '--repo', '/x', '--port', '4321', '--no-open']);
    expect(restartArgs(['-p', '4000', '--no-open'], 4321)).toEqual(['--port', '4321', '--no-open']);
    expect(restartArgs(['--port=4000'], 4321)).toEqual(['--port', '4321', '--no-open']);
  });
});

describe('registry document', () => {
  it('sorts versions newest first, stamps channels and publish dates, and survives a bad payload', async () => {
    const doc = await fetchPackageDocument('@open-mercato/cezar', (async () =>
      new Response(
        JSON.stringify({
          'dist-tags': { latest: '0.11.1', nightly: '0.11.1-nightly.20260924.49' },
          versions: { '0.11.0': {}, '0.11.1': {}, '0.11.1-nightly.20260924.49': {}, '0.9.2-pr743.1156.2': {} },
          time: { '0.11.1': '2026-09-20T00:00:00.000Z' },
        }),
        { status: 200 },
      )) as unknown as typeof fetch);
    expect(doc?.versions.map((entry) => entry.version)).toEqual(['0.11.1', '0.11.1-nightly.20260924.49', '0.11.0', '0.9.2-pr743.1156.2']);
    expect(doc?.versions[0]).toMatchObject({ channel: 'stable', publishedAt: '2026-09-20T00:00:00.000Z' });
    expect(doc?.versions[1]?.channel).toBe('nightly');
    expect(doc?.distTags.nightly).toBe('0.11.1-nightly.20260924.49');

    expect(await fetchPackageDocument('x', (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch)).toBeNull();
    expect(await fetchPackageDocument('x', (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toBeNull();
  });
});

describe('registryPath', () => {
  it('keeps the scope marker and encodes everything after it', () => {
    expect(registryPath('@open-mercato/cezar')).toBe('@open-mercato%2Fcezar');
    expect(registryPath('cezar-cli')).toBe('cezar-cli');
    expect(registryPath('@a/b@c')).toBe('@a%2Fb%40c');
  });
});

describe('activeId without a symlink', () => {
  it('reads the text-file fallback, and answers null when nothing is there', () => {
    const home = mkdtempSync(join(tmpdir(), 'cez-active-'));
    const env = { ...process.env, CEZ_HOME: home };
    try {
      expect(activeId(env)).toBeNull();
      mkdirSync(versionsDir(env), { recursive: true });
      writeFileSync(join(versionsDir(env), 'current'), '0.11.1\n');
      expect(activeId(env)).toBe('0.11.1');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
