import { describe, expect, it } from 'vitest';
import {
  buildInstallLines,
  computeSnapshot,
  stampManifests,
  type ReleaseManifests,
  type SnapshotContext,
} from './snapshot.ts';

const base: SnapshotContext = {
  eventName: 'pull_request',
  refName: 'feat/some-branch',
  prNumber: 482,
  headRepo: 'open-mercato/cezar',
  repo: 'open-mercato/cezar',
  baseVersion: '0.1.5',
  runNumber: 123,
  runAttempt: 1,
};

describe('computeSnapshot', () => {
  it('publishes a same-repo PR under the pr-<N> dist-tag', () => {
    expect(computeSnapshot(base)).toEqual({
      channel: 'pr482',
      version: '0.1.5-pr482.123',
      distTag: 'pr-482',
    });
  });

  it('never publishes a fork PR, even when the workflow guard is bypassed', () => {
    expect(computeSnapshot({ ...base, headRepo: 'someone/cezar' })).toBeNull();
    expect(computeSnapshot({ ...base, headRepo: undefined })).toBeNull();
    expect(computeSnapshot({ ...base, repo: undefined })).toBeNull();
  });

  it('rejects a missing or invalid PR number', () => {
    expect(computeSnapshot({ ...base, prNumber: undefined })).toBeNull();
    expect(computeSnapshot({ ...base, prNumber: 0 })).toBeNull();
    expect(computeSnapshot({ ...base, prNumber: 1.5 })).toBeNull();
  });

  it('publishes push events only for develop', () => {
    const push = { ...base, eventName: 'push', prNumber: undefined };
    expect(computeSnapshot({ ...push, refName: 'develop' })).toEqual({
      channel: 'develop',
      version: '0.1.5-develop.123',
      distTag: 'develop',
    });
    // main never publishes a snapshot — stable releases are owner-driven.
    expect(computeSnapshot({ ...push, refName: 'main' })).toBeNull();
    expect(computeSnapshot({ ...push, refName: 'feat/other' })).toBeNull();
  });

  it('publishes nothing for other events', () => {
    expect(computeSnapshot({ ...base, eventName: 'workflow_dispatch' })).toBeNull();
    expect(computeSnapshot({ ...base, eventName: 'schedule' })).toBeNull();
  });

  describe('nightly', () => {
    const nightly: SnapshotContext = {
      ...base,
      eventName: 'schedule',
      refName: 'main',
      prNumber: undefined,
      requestedChannel: 'nightly',
      nightlyDate: '20260813',
    };

    it('cuts main under the nightly dist-tag, dated and run-numbered', () => {
      expect(computeSnapshot(nightly)).toEqual({
        channel: 'nightly',
        // Date first so the versions sort chronologically and a user can read the
        // age of their build; run number second so a same-day re-cut never collides.
        version: '0.1.5-nightly.20260813.123',
        distTag: 'nightly',
      });
    });

    it('cuts one on demand too — a manual dispatch of the nightly workflow', () => {
      expect(computeSnapshot({ ...nightly, eventName: 'workflow_dispatch' })?.distTag).toBe('nightly');
    });

    it('is reachable only by asking for it by name, never from the event alone', () => {
      // A workflow_dispatch or schedule that did NOT request the channel (ci.yml's
      // manual trigger, say) must publish nothing.
      expect(computeSnapshot({ ...nightly, requestedChannel: undefined })).toBeNull();
      // ...and an unrecognised request is a no-op, not a fallback to another channel.
      expect(computeSnapshot({ ...nightly, requestedChannel: 'nghtly' })).toBeNull();
      expect(computeSnapshot({ ...base, requestedChannel: 'latest' })).toBeNull();
    });

    it('cuts only from main, and only from a schedule or a dispatch', () => {
      expect(computeSnapshot({ ...nightly, refName: 'develop' })).toBeNull();
      expect(computeSnapshot({ ...nightly, refName: 'release/0.1.x' })).toBeNull();
      expect(computeSnapshot({ ...nightly, eventName: 'push' })).toBeNull();
      expect(computeSnapshot({ ...nightly, eventName: 'pull_request' })).toBeNull();
    });

    it('refuses to publish without a well-formed date', () => {
      expect(computeSnapshot({ ...nightly, nightlyDate: undefined })).toBeNull();
      expect(computeSnapshot({ ...nightly, nightlyDate: '2026-08-13' })).toBeNull();
      expect(computeSnapshot({ ...nightly, nightlyDate: '260813' })).toBeNull();
    });

    it('appends the run attempt on a re-run, like every other channel', () => {
      expect(computeSnapshot({ ...nightly, runAttempt: 2 })?.version).toBe('0.1.5-nightly.20260813.123.2');
    });
  });

  it('appends the run attempt only on re-runs, so no publish ever collides', () => {
    expect(computeSnapshot({ ...base, runAttempt: 1 })?.version).toBe('0.1.5-pr482.123');
    expect(computeSnapshot({ ...base, runAttempt: undefined })?.version).toBe('0.1.5-pr482.123');
    expect(computeSnapshot({ ...base, runAttempt: 2 })?.version).toBe('0.1.5-pr482.123.2');
  });

  it('rejects a missing base version or run number', () => {
    expect(computeSnapshot({ ...base, baseVersion: '' })).toBeNull();
    expect(computeSnapshot({ ...base, runNumber: 0 })).toBeNull();
  });

  it('never resolves to the latest dist-tag on any publishing input', () => {
    const events: SnapshotContext[] = [
      base,
      { ...base, eventName: 'push', refName: 'develop', prNumber: undefined },
      {
        ...base,
        eventName: 'schedule',
        refName: 'main',
        prNumber: undefined,
        requestedChannel: 'nightly',
        nightlyDate: '20260813',
      },
    ];
    for (const ctx of events) {
      const plan = computeSnapshot(ctx);
      expect(plan).not.toBeNull();
      expect(plan?.distTag).not.toBe('latest');
      // Prerelease version → npm would not implicitly treat it as latest either.
      expect(plan?.version).toContain('-');
    }
  });
});

describe('stampManifests', () => {
  const set = (): ReleaseManifests => ({
    contract: { name: '@open-mercato/cezar-contract', version: '0.1.5' },
    apiClient: { name: '@open-mercato/cezar-api-client', version: '0.1.5' },
    cezar: {
      name: '@open-mercato/cezar',
      version: '0.1.5',
      bin: { cezar: 'dist/index.js' },
      devDependencies: { '@open-mercato/cezar-api-client': '^0.1.5' },
    },
    alias: {
      name: 'cezar-cli',
      version: '0.1.5',
      dependencies: { '@open-mercato/cezar': '^0.1.5' },
    },
  });

  it('stamps every manifest to the snapshot version and pins each sibling exact', () => {
    const stamped = stampManifests(set(), '0.1.5-pr482.123');
    expect(stamped.apiClient.version).toBe('0.1.5-pr482.123');
    expect(stamped.cezar.version).toBe('0.1.5-pr482.123');
    expect(stamped.alias.version).toBe('0.1.5-pr482.123');
    // Exact, no range: `npx cezar-cli@<v>` must run this PR's code, and the service must
    // resolve the api-client it was cut with.
    expect(stamped.alias.dependencies).toEqual({ '@open-mercato/cezar': '0.1.5-pr482.123' });
    expect(stamped.cezar.devDependencies).toEqual({
      '@open-mercato/cezar-api-client': '0.1.5-pr482.123',
    });
  });

  it('pins against whatever the packages are currently named (rename-proof)', () => {
    const stamped = stampManifests(
      {
        contract: { name: '@old/contract', version: '0.1.5' },
        apiClient: { name: '@old/client', version: '0.1.5' },
        cezar: { name: '@pat-lewczuk/cezar', version: '0.1.5', dependencies: { '@old/client': '^0.1.5' } },
        alias: { name: 'cezar-cli', version: '0.1.5', dependencies: { '@pat-lewczuk/cezar': '^0.1.5' } },
      },
      '0.1.5-develop.7',
    );
    expect(stamped.alias.dependencies).toEqual({ '@pat-lewczuk/cezar': '0.1.5-develop.7' });
    expect(stamped.cezar.dependencies).toEqual({ '@old/client': '0.1.5-develop.7' });
  });

  it('does not mutate the inputs and passes unrelated fields through', () => {
    const manifests = set();
    const stamped = stampManifests(manifests, '0.1.5-main.9');
    expect(manifests.cezar.version).toBe('0.1.5');
    expect(manifests.alias.dependencies).toEqual({ '@open-mercato/cezar': '^0.1.5' });
    expect(stamped.cezar.bin).toEqual({ cezar: 'dist/index.js' });
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
    const stamped = stampManifests(manifests, '0.1.5-pr482.123');
    expect(stamped.alias.repository).toEqual(repository);
    expect(stamped.alias.homepage).toBe('https://example.test');
    expect(stamped.alias.bugs).toEqual({ url: 'https://example.test/issues' });
  });

  it('leaves the alias untouched when the service declares no repository', () => {
    expect('repository' in stampManifests(set(), '0.1.5-pr482.123').alias).toBe(false);
  });
});

describe('buildInstallLines', () => {
  it('renders exact-version npx commands from the actual alias name', () => {
    const lines = buildInstallLines('cezar-cli', '0.1.5-pr482.123');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      expect(line).toContain('npx cezar-cli@0.1.5-pr482.123');
    }
  });

  it('follows a renamed alias without code changes', () => {
    const lines = buildInstallLines('some-future-name', '1.0.0-pr9.1');
    expect(lines[0]).toContain('npx some-future-name@1.0.0-pr9.1');
  });
});
