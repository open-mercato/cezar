import { afterEach, describe, expect, it } from 'vitest';

import {
  forgetLearnedMinimums,
  LATEST_TTL_MS,
  LatestVersions,
  minimumVersion,
  newestInMajor,
  noteAgentErrorVersion,
  requiredVersionFrom,
  type FetchLike,
} from './agent-cli-versions.ts';

const answering = (body: unknown, calls: string[] = []): FetchLike => async (url) => {
  calls.push(url);
  return { ok: true, json: async () => body };
};

describe('LatestVersions', () => {
  it('reads npm once per window and caches the answer', async () => {
    const calls: string[] = [];
    let now = 0;
    const latest = new LatestVersions({ env: {}, now: () => now, fetch: answering({ version: '0.64.0' }, calls) });
    expect(await latest.latest('codex')).toBe('0.64.0');
    expect(await latest.latest('codex')).toBe('0.64.0');
    expect(calls).toEqual(['https://registry.npmjs.org/@openai/codex/latest']);
    now = LATEST_TTL_MS + 1;
    await latest.latest('codex');
    expect(calls).toHaveLength(2);
  });

  it('stays inside the major cezar can drive', async () => {
    const latest = new LatestVersions({ env: {}, fetch: answering({ versions: { '1.18.0': {}, '1.21.3': {}, '2.0.1': {}, '1.22.0-beta.1': {} } }) });
    expect(await latest.latest('opencode')).toBe('1.21.3');
  });

  it('asks nothing for an agent that is not on npm, when turned off, or in dry-run', async () => {
    const calls: string[] = [];
    expect(await new LatestVersions({ env: {}, fetch: answering({}, calls) }).latest('cursor')).toBeNull();
    expect(await new LatestVersions({ env: { CEZ_AGENT_VERSION_CHECK: '0' }, fetch: answering({}, calls) }).latest('claude')).toBeNull();
    expect(await new LatestVersions({ env: { CEZ_DRY_RUN: '1' }, fetch: answering({}, calls) }).latest('claude')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('answers null offline or on a malformed body, never throws', async () => {
    const offline = new LatestVersions({ env: {}, fetch: async () => { throw new Error('offline'); } });
    expect(await offline.latest('claude')).toBeNull();
    expect(await new LatestVersions({ env: {}, fetch: answering({ version: 'banana' }) }).latest('claude')).toBeNull();
  });
});

describe('newestInMajor', () => {
  it('skips prereleases and other majors', () => {
    expect(newestInMajor(['1.2.0', '1.10.0', '1.11.0-rc.1', '2.0.0'], 1)).toBe('1.10.0');
    expect(newestInMajor(['2.0.0'], 1)).toBeNull();
  });
});

describe('minimums an agent states at runtime', () => {
  afterEach(() => forgetLearnedMinimums());

  it('reads the version from the vendor sentence', () => {
    expect(requiredVersionFrom('OpenCode 1.18.0 or newer is required to use the free tier')).toBe('1.18.0');
    expect(requiredVersionFrom('this feature requires v2.1 or later')).toBe('2.1.0');
    expect(requiredVersionFrom('something else failed')).toBeNull();
  });

  it('keeps the highest one per agent and ignores unknown backends', () => {
    noteAgentErrorVersion('opencode', 'OpenCode 1.18.0 or newer is required');
    noteAgentErrorVersion('opencode', 'OpenCode 1.16.0 or newer is required');
    noteAgentErrorVersion('nope', 'X 9.0.0 or newer is required');
    noteAgentErrorVersion(undefined, 'X 9.0.0 or newer is required');
    expect(minimumVersion('opencode')).toBe('1.18.0');
    expect(minimumVersion('codex')).toBeNull();
  });

  it('learns only a minimum the sentence says is the agent’s own (an allowlist)', () => {
    // Someone else's minimum: a runtime, git, the OS. Update could never clear these.
    noteAgentErrorVersion('claude', 'Node.js 20.0.0 or newer is required');
    noteAgentErrorVersion('claude', 'Node.js requires version 22.0 or newer');
    noteAgentErrorVersion('codex', 'git 2.38 or newer is required');
    noteAgentErrorVersion('gemini', 'macOS 13.0 or later is required');
    noteAgentErrorVersion('kimi', 'Something 3.0.0 or newer is required');
    expect(minimumVersion('claude')).toBeNull();
    expect(minimumVersion('codex')).toBeNull();
    expect(minimumVersion('gemini')).toBeNull();
    expect(minimumVersion('kimi')).toBeNull();
    // The agent's own: its name, or "version", right before the number.
    noteAgentErrorVersion('claude', 'Claude Code version 2.1 or later is required for this model');
    noteAgentErrorVersion('copilot', 'This feature requires v1.0.90 or newer');
    expect(minimumVersion('claude')).toBe('2.1.0');
    expect(minimumVersion('copilot')).toBe('1.0.90');
  });
});
