import { describe, expect, it } from 'vitest';
import {
  changelogSection,
  dropUnreleased,
  ensureChangelogEntry,
  insertChangelogEntry,
  stampCompanionManifest,
  stampLockfile,
} from './bump.ts';

const CHANGELOG = `# 0.15.2 (2026-10-14)

## Highlights
Things.

# 0.15.1 (2026-10-13)

- older
`;

describe('stampCompanionManifest', () => {
  it('moves the version and re-pins only the release-set siblings it declares', () => {
    const web = stampCompanionManifest(
      {
        name: 'web',
        version: '0.15.2',
        dependencies: { '@scope/client': '^0.15.2', react: '^19.0.0' },
        devDependencies: { '@scope/impl': '^0.15.2' },
      },
      '0.16.0',
      ['@scope/client', '@scope/impl', 'impl-cli'],
    );
    expect(web.version).toBe('0.16.0');
    expect(web.dependencies).toEqual({ '@scope/client': '^0.16.0', react: '^19.0.0' });
    expect(web.devDependencies).toEqual({ '@scope/impl': '^0.16.0' });
  });
});

describe('stampLockfile', () => {
  it('mirrors each workspace manifest into its lock entry and leaves the rest alone', () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        '': { name: 'root' },
        'packages/web': {
          name: 'web',
          version: '0.15.2',
          dependencies: { '@scope/client': '^0.15.2', react: '^19.0.0' },
        },
        'node_modules/react': { version: '19.0.0' },
      },
    };
    const out = stampLockfile(lock, {
      'packages/web': {
        name: 'web',
        version: '0.16.0',
        dependencies: { '@scope/client': '^0.16.0', react: '^19.0.0' },
      },
      'alias-cezar': { name: 'impl-cli', version: '0.16.0' }, // not a workspace: no lock entry
    });
    expect(out.packages!['packages/web']).toEqual({
      name: 'web',
      version: '0.16.0',
      dependencies: { '@scope/client': '^0.16.0', react: '^19.0.0' },
    });
    expect(out.packages!['node_modules/react']).toEqual({ version: '19.0.0' });
    expect(Object.keys(out.packages!)).toEqual(Object.keys(lock.packages));
  });
});

describe('ensureChangelogEntry', () => {
  it('keeps a hand-written entry for the version', () => {
    expect(ensureChangelogEntry(CHANGELOG, '0.15.2', '2026-10-20', 'generated')).toEqual({
      text: CHANGELOG,
      source: 'existing',
    });
  });

  it('renames a leading Unreleased section', () => {
    const { text, source } = ensureChangelogEntry(`# Unreleased\n\n- fix\n\n${CHANGELOG}`, '0.15.3', '2026-10-20', 'x');
    expect(source).toBe('unreleased');
    expect(text.startsWith('# 0.15.3 (2026-10-20)\n\n- fix\n')).toBe(true);
  });

  it('prepends the generated notes otherwise', () => {
    const { text, source } = ensureChangelogEntry(CHANGELOG, '0.15.3', '2026-10-20', "## What's Changed\n* fix (#1)\n");
    expect(source).toBe('generated');
    expect(text).toBe(`# 0.15.3 (2026-10-20)\n\n## What's Changed\n* fix (#1)\n\n${CHANGELOG}`);
  });

  it('never writes an empty entry', () => {
    expect(ensureChangelogEntry(CHANGELOG, '0.15.3', '2026-10-20', '  ').text).toContain('- Maintenance release.');
  });
});

describe('dropUnreleased', () => {
  it('removes a leading Unreleased section up to the next version', () => {
    expect(dropUnreleased(`# Unreleased\n\n- fix\n\n${CHANGELOG}`)).toBe(CHANGELOG);
  });

  it('leaves a changelog without one, or with one below a version, alone', () => {
    expect(dropUnreleased(CHANGELOG)).toBe(CHANGELOG);
    const below = `${CHANGELOG}\n# Unreleased\n\n- x\n`;
    expect(dropUnreleased(below)).toBe(below);
  });
});

describe('changelogSection', () => {
  it('returns one entry, up to the next version heading but not across subheadings', () => {
    expect(changelogSection(CHANGELOG, '0.15.2')).toEqual({
      heading: '# 0.15.2 (2026-10-14)',
      body: '## Highlights\nThings.',
    });
    expect(changelogSection(CHANGELOG, '0.15.1')?.body).toBe('- older');
    expect(changelogSection(CHANGELOG, '0.9.0')).toBeNull();
  });
});

describe('insertChangelogEntry', () => {
  const entry = '# 0.15.3 (2026-10-20)\n\n- fix\n';

  it('places a backported entry above the first older version, below newer ones and Unreleased', () => {
    const main = `# Unreleased\n\n- feature\n\n# 0.16.0 (2026-10-19)\n\n- big\n\n${CHANGELOG}`;
    const out = insertChangelogEntry(main, '0.15.3', entry);
    const order = ['# Unreleased', '# 0.16.0', '# 0.15.3', '# 0.15.2'].map((h) => out.indexOf(h));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(out).toContain('# 0.15.3 (2026-10-20)\n\n- fix\n\n# 0.15.2');
  });

  it('is a no-op when the branch already has the entry', () => {
    const once = insertChangelogEntry(CHANGELOG, '0.15.3', entry);
    expect(insertChangelogEntry(once, '0.15.3', entry)).toBe(once);
  });

  it('appends when every listed version is newer', () => {
    expect(insertChangelogEntry('# 1.0.0\n\n- x\n', '0.15.3', entry).trimEnd().endsWith('- fix')).toBe(true);
  });
});
