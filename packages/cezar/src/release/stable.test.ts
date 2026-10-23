import { describe, expect, it } from 'vitest';
import {
  compareStableVersions,
  computeStableVersion,
  isReleaseBump,
  nextMinorVersion,
  parseReleaseBranch,
  planRelease,
  releaseBranchFor,
  resolveStableDistTag,
  stampStableManifests,
  type ReleaseManifests,
} from './stable.ts';
import { isPublishable } from './manifests.ts';

describe('computeStableVersion', () => {
  it('increments each semver component the way npm version does', () => {
    expect(computeStableVersion('patch', '0.1.5')).toBe('0.1.6');
    expect(computeStableVersion('minor', '0.1.5')).toBe('0.2.0');
    expect(computeStableVersion('major', '0.1.5')).toBe('1.0.0');
  });

  it('returns the base verbatim for the existing bump', () => {
    expect(computeStableVersion('existing', '0.1.5')).toBe('0.1.5');
    expect(computeStableVersion('existing', '2.3.4')).toBe('2.3.4');
  });

  it('rejects a non-plain base version so a snapshot can never be released', () => {
    expect(computeStableVersion('patch', '0.1.5-pr482.123')).toBeNull();
    expect(computeStableVersion('patch', 'not-a-version')).toBeNull();
    expect(computeStableVersion('patch', '')).toBeNull();
  });
});

describe('isReleaseBump', () => {
  it('accepts the four supported modes and nothing else', () => {
    expect(isReleaseBump('patch')).toBe(true);
    expect(isReleaseBump('existing')).toBe(true);
    expect(isReleaseBump('snapshot')).toBe(false);
    expect(isReleaseBump('')).toBe(false);
  });
});

describe('stampStableManifests', () => {
  const set = (): ReleaseManifests => ({
    contract: { name: '@scope/contract', version: '0.1.5' },
    apiClient: { name: '@scope/client', version: '0.1.5' },
    cezar: {
      name: '@scope/impl',
      version: '0.1.5',
      files: ['dist'],
      devDependencies: { '@scope/client': '^0.1.5' },
    },
    alias: { name: 'impl-cli', version: '0.1.5', dependencies: { '@scope/impl': '^0.1.5' } },
    runAlias: { name: 'impl-run', version: '0.1.5', dependencies: { '@scope/impl': '^0.1.5' } },
  });

  it('stamps every manifest and keeps caret ranges on the intra-release pins', () => {
    const stamped = stampStableManifests(set(), '0.1.6');

    expect(stamped.apiClient.version).toBe('0.1.6');
    expect(stamped.cezar.version).toBe('0.1.6');
    expect(stamped.alias.version).toBe('0.1.6');
    expect(stamped.cezar.files).toEqual(['dist']); // passthrough untouched
    // Caret, not an exact pin — the opposite of the snapshot stamper.
    expect(stamped.alias.dependencies).toEqual({ '@scope/impl': '^0.1.6' });
    expect(stamped.runAlias.version).toBe('0.1.6');
    expect(stamped.runAlias.dependencies).toEqual({ '@scope/impl': '^0.1.6' });
    expect(stamped.cezar.devDependencies).toEqual({ '@scope/client': '^0.1.6' });
  });

  it('re-pins the api-client wherever it is declared, so the dev→runtime move is transparent', () => {
    // Today the service only needs the client in its tests; the phase that single-sources the
    // DTOs moves it to `dependencies`. The release pipeline must not need to be told.
    const manifests = set();
    manifests.cezar = {
      name: '@scope/impl',
      version: '0.1.5',
      dependencies: { '@scope/client': '^0.1.5', hono: '^4.6.0' },
    };

    const stamped = stampStableManifests(manifests, '0.1.6');

    expect(stamped.cezar.dependencies).toEqual({ '@scope/client': '^0.1.6', hono: '^4.6.0' });
    expect(stamped.cezar.devDependencies).toBeUndefined();
  });

  it('lets the alias inherit repository/homepage/bugs from the service so provenance validates', () => {
    const repository = { type: 'git', url: 'https://github.com/open-mercato/cezar' };
    const manifests = set();
    manifests.cezar = {
      ...manifests.cezar,
      repository,
      homepage: 'https://example.test',
      bugs: { url: 'https://example.test/issues' },
    };

    const stamped = stampStableManifests(manifests, '0.1.6');

    expect(stamped.alias.repository).toEqual(repository);
    expect(stamped.alias.homepage).toBe('https://example.test');
    expect(stamped.alias.bugs).toEqual({ url: 'https://example.test/issues' });
    expect(stamped.runAlias.repository).toEqual(repository);
  });

  it('leaves the alias untouched when the service declares no repository', () => {
    expect('repository' in stampStableManifests(set(), '0.1.6').alias).toBe(false);
  });

  it('stamps a private package like any other — it is in the release, just not on the registry', () => {
    // The api-client is consumed inside the workspace long before it is offered to anyone
    // else. Freezing its version would leave the service's pin against it pointing at a build
    // the release was never cut from, which is the drift this pipeline exists to prevent.
    const manifests = set();
    manifests.apiClient = { ...manifests.apiClient, private: true };

    const stamped = stampStableManifests(manifests, '0.1.6');

    expect(stamped.apiClient.version).toBe('0.1.6');
    expect(stamped.apiClient.private).toBe(true);
    expect(isPublishable(stamped.apiClient)).toBe(false);
    // …and the service's pin against it still moves.
    expect(stamped.cezar.devDependencies).toEqual({ '@scope/client': '^0.1.6' });
  });

  it('treats a manifest with no `private` flag as publishable', () => {
    expect(isPublishable(set().cezar)).toBe(true);
    expect(isPublishable({ name: 'x', version: '1.0.0', private: false })).toBe(true);
  });

  it('does not mutate its inputs', () => {
    const manifests = set();
    stampStableManifests(manifests, '0.1.6');
    expect(manifests.cezar.version).toBe('0.1.5');
    expect(manifests.alias.dependencies).toEqual({ '@scope/impl': '^0.1.5' });
  });
});

describe('release lines', () => {
  it('names the maintenance branch of a version and parses it back', () => {
    expect(releaseBranchFor('0.15.2')).toBe('release/v0.15.x');
    expect(parseReleaseBranch('refs/heads/release/v0.15.x')).toEqual({ major: 0, minor: 15 });
    expect(parseReleaseBranch('release/0.9.x')).toBeNull();
    expect(parseReleaseBranch('main')).toBeNull();
    expect(nextMinorVersion('0.15.2')).toBe('0.16.0');
  });

  it('orders versions numerically, not as strings', () => {
    expect(compareStableVersions('0.15.10', '0.15.9')).toBeGreaterThan(0);
    expect(compareStableVersions('v0.16.0', '0.15.99')).toBeGreaterThan(0);
    expect(compareStableVersions('1.0.0', '1.0.0')).toBe(0);
  });
});

describe('planRelease', () => {
  const tags = ['v0.14.0', 'v0.15.0', 'v0.15.1', 'v0.15.2', 'desktop-v0.1.7'];

  it('bumps the patch first once the committed version is tagged', () => {
    expect(planRelease({ branch: 'release/v0.15.x', manifestVersion: '0.15.2', tags })).toEqual({
      ok: true,
      version: '0.15.3',
      bumped: true,
      previousTag: 'v0.15.2',
    });
  });

  it("ships a fresh line's x.y.0 as committed", () => {
    expect(planRelease({ branch: 'release/v0.16.x', manifestVersion: '0.16.0', tags })).toEqual({
      ok: true,
      version: '0.16.0',
      bumped: false,
      previousTag: 'v0.15.2',
    });
  });

  it('skips past versions already tagged by an earlier, half-finished run', () => {
    const plan = planRelease({ branch: 'release/v0.15.x', manifestVersion: '0.15.1', tags });
    expect(plan).toMatchObject({ ok: true, version: '0.15.3', bumped: true });
  });

  it('takes the previous tag from below the version, even when a newer line exists', () => {
    const plan = planRelease({ branch: 'release/v0.15.x', manifestVersion: '0.15.2', tags: [...tags, 'v0.16.0'] });
    expect(plan).toMatchObject({ version: '0.15.3', previousTag: 'v0.15.2' });
  });

  it('refuses a branch that is not a release line, or manifests from another line', () => {
    expect(planRelease({ branch: 'main', manifestVersion: '0.16.0', tags }).ok).toBe(false);
    expect(planRelease({ branch: 'release/v0.15.x', manifestVersion: '0.16.0', tags }).ok).toBe(false);
    expect(planRelease({ branch: 'release/v0.15.x', manifestVersion: '0.15.2-nightly.1', tags }).ok).toBe(false);
  });
});

describe('resolveStableDistTag', () => {
  it('moves latest only for the newest line', () => {
    expect(resolveStableDistTag('0.15.3', '0.15.2')).toBe('latest');
    expect(resolveStableDistTag('0.16.0', '0.15.3')).toBe('latest');
    expect(resolveStableDistTag('0.15.4', '0.16.0')).toBe('latest-0.15');
  });

  it('treats a registry with no stable latest as nothing to protect', () => {
    expect(resolveStableDistTag('0.1.0', null)).toBe('latest');
    expect(resolveStableDistTag('0.1.0', 'garbage')).toBe('latest');
  });
});
