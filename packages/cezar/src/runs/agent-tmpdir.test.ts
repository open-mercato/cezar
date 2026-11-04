import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AgentTempDirError,
  agentTmpDir,
  agentTmpDirEnabled,
  agentTmpEnv,
  removeAgentTmpDir,
  sweepAgentTmpDirs,
} from './agent-tmpdir.ts';

/**
 * #785: every agent shared the host's temp directory, and when that directory
 * stopped accepting writes the Claude backend's output capture silently
 * truncated to nothing. These cover the two properties that fix it — a per-run
 * directory, and a preflight that fails loudly instead of spawning blind — plus
 * the reaping that keeps the first one from becoming its own leak.
 */
describe('agentTmpEnv — per-run temp directory (#785)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(realpathSync(tmpdir()), 'cez-agent-tmpdir-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('gives the run its own directory and creates it before the backend spawns', () => {
    const env = agentTmpEnv(dataDir, 'run-a', {});
    expect(env.TMPDIR).toBe(agentTmpDir(dataDir, 'run-a'));
    expect(env.TMPDIR).toBe(join(dataDir, 'tmp', 'run-a'));
    expect(existsSync(env.TMPDIR as string)).toBe(true);
  });

  // A tool that reads TMP (or TEMP) would otherwise follow the host value straight
  // back to the exhausted directory this whole change exists to escape.
  it('sets all three spellings, so nothing falls back to the host value', () => {
    const env = agentTmpEnv(dataDir, 'run-b', {});
    expect(env.TEMP).toBe(env.TMPDIR);
    expect(env.TMP).toBe(env.TMPDIR);
  });

  it('keeps runs out of each other’s scratch', () => {
    expect(agentTmpEnv(dataDir, 'run-a', {}).TMPDIR)
      .not.toBe(agentTmpEnv(dataDir, 'run-b', {}).TMPDIR);
  });

  it('fails with a named, actionable error when the directory cannot be created', () => {
    // `<dataDir>/tmp` occupied by a FILE — mkdir cannot make the run's directory
    // under it. Deterministic and portable, unlike simulating a quota.
    writeFileSync(join(dataDir, 'tmp'), 'not a directory', 'utf8');
    let thrown: unknown;
    try {
      agentTmpEnv(dataDir, 'run-c', {});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AgentTempDirError);
    expect((thrown as Error).message).toContain('agent temp directory is not writable');
    expect((thrown as Error).message).toContain(join(dataDir, 'tmp', 'run-c'));
    // The remedy names the opt-out, so the message alone is enough to act on.
    expect((thrown as Error).message).toContain('CEZ_AGENT_TMPDIR=0');
  });

  // The failure this exists for is a directory that exists and accepts an inode but
  // rejects the write (`EDQUOT`). A read-only directory is the portable stand-in —
  // skipped under root, which ignores the mode bits.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails when the directory exists but rejects writes',
    () => {
      const dir = agentTmpDir(dataDir, 'run-d');
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o500);
      try {
        expect(() => agentTmpEnv(dataDir, 'run-d', {})).toThrow(AgentTempDirError);
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );

  it('a writable directory passes, and the probe leaves nothing behind', () => {
    const env = agentTmpEnv(dataDir, 'run-e', {});
    expect(readdirSync(env.TMPDIR as string)).toEqual([]);
  });

  describe('CEZ_AGENT_TMPDIR=0 opt-out', () => {
    it('leaves the host TMPDIR in force and mints no directory', () => {
      const host = mkdtempSync(join(realpathSync(tmpdir()), 'cez-host-tmp-'));
      try {
        const env = agentTmpEnv(dataDir, 'run-f', { CEZ_AGENT_TMPDIR: '0', TMPDIR: host });
        expect(env).toEqual({});
        expect(existsSync(agentTmpDir(dataDir, 'run-f'))).toBe(false);
      } finally {
        rmSync(host, { recursive: true, force: true });
      }
    });

    // The hatch turns the whole feature off, preflight included. An escape hatch
    // that still imposed the new check would be one you cannot escape through,
    // and a run that used to start must still start with it set.
    it('does not preflight anything either, however broken the host TMPDIR is', () => {
      expect(() =>
        agentTmpEnv(dataDir, 'run-g', {
          CEZ_AGENT_TMPDIR: '0',
          TMPDIR: join(dataDir, 'does-not-exist'),
        }),
      ).not.toThrow();
    });

    it('is not fooled by an unusable directory it would otherwise have minted', () => {
      writeFileSync(join(dataDir, 'tmp'), 'not a directory', 'utf8');
      expect(agentTmpEnv(dataDir, 'run-h', { CEZ_AGENT_TMPDIR: '0' })).toEqual({});
    });

    it('only an exact "0" disables it', () => {
      expect(agentTmpDirEnabled({})).toBe(true);
      expect(agentTmpDirEnabled({ CEZ_AGENT_TMPDIR: '1' })).toBe(true);
      expect(agentTmpDirEnabled({ CEZ_AGENT_TMPDIR: 'false' })).toBe(true);
      expect(agentTmpDirEnabled({ CEZ_AGENT_TMPDIR: '0' })).toBe(false);
    });
  });
});

describe('reaping the per-run temp directories (#785)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(realpathSync(tmpdir()), 'cez-agent-tmpdir-reap-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('removes one run’s directory and everything in it', () => {
    const dir = agentTmpEnv(dataDir, 'run-a', {}).TMPDIR as string;
    writeFileSync(join(dir, 'scratch.txt'), 'x', 'utf8');
    removeAgentTmpDir(dataDir, 'run-a');
    expect(existsSync(dir)).toBe(false);
  });

  it('is idempotent and never throws on a directory that is already gone', () => {
    expect(() => removeAgentTmpDir(dataDir, 'never-existed')).not.toThrow();
  });

  // Path-traversal guard: a run id is a uuid, and nothing that is not one may ever
  // reach a recursive rmSync.
  it('refuses a run id that is not a plain identifier', () => {
    const sibling = join(dataDir, 'runs');
    mkdirSync(sibling, { recursive: true });
    removeAgentTmpDir(dataDir, '../runs');
    expect(existsSync(sibling)).toBe(true);
  });

  // The one input that turns this helper into data loss: `join(dataDir, 'tmp', '..')`
  // is `<dataDir>` itself, so a guard that admits it would recursively remove every
  // run's state — runs.json included.
  it.each(['.', '..'])('refuses the relative id %j, which would resolve onto dataDir', (id) => {
    writeFileSync(join(dataDir, 'runs.json'), '[]', 'utf8');
    agentTmpEnv(dataDir, 'live', {});
    removeAgentTmpDir(dataDir, id);
    expect(existsSync(join(dataDir, 'runs.json'))).toBe(true);
    expect(existsSync(agentTmpDir(dataDir, 'live'))).toBe(true);
  });

  it('sweeps orphans left by a crash while keeping the live runs', () => {
    agentTmpEnv(dataDir, 'live', {});
    agentTmpEnv(dataDir, 'orphan-1', {});
    agentTmpEnv(dataDir, 'orphan-2', {});
    const reaped = sweepAgentTmpDirs(dataDir, ['live']);
    expect(reaped.sort()).toEqual(['orphan-1', 'orphan-2']);
    expect(existsSync(agentTmpDir(dataDir, 'live'))).toBe(true);
    expect(existsSync(agentTmpDir(dataDir, 'orphan-1'))).toBe(false);
  });

  // BACKWARD_COMPATIBILITY §3: `.ai/cezar/` is a protected surface. The sweep is
  // confined to its own `tmp/` subtree and must never see a sibling.
  it('never touches sibling run state', () => {
    agentTmpEnv(dataDir, 'orphan', {});
    mkdirSync(join(dataDir, 'runs'), { recursive: true });
    writeFileSync(join(dataDir, 'runs.json'), '[]', 'utf8');
    writeFileSync(join(dataDir, 'runs', 'a.ndjson'), '{}', 'utf8');
    sweepAgentTmpDirs(dataDir, []);
    expect(existsSync(join(dataDir, 'runs.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'runs', 'a.ndjson'))).toBe(true);
  });

  // The recursive delete used to be a synchronous rimraf on the main thread; on a slow volume
  // an agent temp dir full of browser-profile files froze the cockpit for minutes. The path
  // must be free the moment the reap returns, so a Continue can re-create it safely, and the
  // delete must finish in the background.
  it('frees the run path at once and deletes the tree in the background', async () => {
    const dir = agentTmpEnv(dataDir, 'run-bg', {}).TMPDIR as string;
    mkdirSync(join(dir, 'profile', 'Default'), { recursive: true });
    writeFileSync(join(dir, 'profile', 'Default', 'Cookies'), 'x', 'utf8');
    removeAgentTmpDir(dataDir, 'run-bg');
    expect(existsSync(dir)).toBe(false);
    // Nothing was deleted on the calling tick: the tree was only detached.
    expect(readdirSync(join(dataDir, 'tmp')).filter((n) => n.startsWith('.trash-run-bg-'))).toHaveLength(1);
    // A Continue re-creates the directory while the old tree is still being deleted.
    const again = agentTmpEnv(dataDir, 'run-bg', {}).TMPDIR as string;
    writeFileSync(join(again, 'fresh.txt'), 'x', 'utf8');
    await vi.waitFor(() => {
      expect(readdirSync(join(dataDir, 'tmp'))).toEqual(['run-bg']);
    });
    expect(existsSync(join(again, 'fresh.txt'))).toBe(true);
  });

  it('finishes trash an interrupted background delete left behind', async () => {
    const trash = join(dataDir, 'tmp', '.trash-run-old-1-1');
    mkdirSync(join(trash, 'nested'), { recursive: true });
    writeFileSync(join(trash, 'nested', 'f'), 'x', 'utf8');
    agentTmpEnv(dataDir, 'live', {});
    expect(sweepAgentTmpDirs(dataDir, ['live'])).toEqual([]);
    await vi.waitFor(() => {
      expect(existsSync(trash)).toBe(false);
    });
    expect(existsSync(agentTmpDir(dataDir, 'live'))).toBe(true);
  });

  it('is a no-op before any run has minted a directory', () => {
    expect(sweepAgentTmpDirs(dataDir, [])).toEqual([]);
  });
});
