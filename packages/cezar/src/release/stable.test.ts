import { describe, expect, it } from 'vitest';
import {
  computeStableVersion,
  isReleaseBump,
  stampStableManifests,
  type ReleaseManifests,
} from './stable.js';

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
    apiClient: { name: '@scope/client', version: '0.1.5' },
    cezar: {
      name: '@scope/impl',
      version: '0.1.5',
      files: ['dist'],
      devDependencies: { '@scope/client': '^0.1.5' },
    },
    alias: { name: 'impl-cli', version: '0.1.5', dependencies: { '@scope/impl': '^0.1.5' } },
  });

  it('stamps every manifest and keeps caret ranges on the intra-release pins', () => {
    const stamped = stampStableManifests(set(), '0.1.6');

    expect(stamped.apiClient.version).toBe('0.1.6');
    expect(stamped.cezar.version).toBe('0.1.6');
    expect(stamped.alias.version).toBe('0.1.6');
    expect(stamped.cezar.files).toEqual(['dist']); // passthrough untouched
    // Caret, not an exact pin — the opposite of the snapshot stamper.
    expect(stamped.alias.dependencies).toEqual({ '@scope/impl': '^0.1.6' });
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
  });

  it('leaves the alias untouched when the service declares no repository', () => {
    expect('repository' in stampStableManifests(set(), '0.1.6').alias).toBe(false);
  });

  it('does not mutate its inputs', () => {
    const manifests = set();
    stampStableManifests(manifests, '0.1.6');
    expect(manifests.cezar.version).toBe('0.1.5');
    expect(manifests.alias.dependencies).toEqual({ '@scope/impl': '^0.1.5' });
  });
});
