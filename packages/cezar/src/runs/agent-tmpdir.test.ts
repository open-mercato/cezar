import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentTempDirError,
  agentTmpDir,
  agentTmpDirEnabled,
  agentTmpEnv,
  removeAgentTmpDir,
  securePrivateDir,
  sweepAgentTmpDirs,
} from './agent-tmpdir.ts';
import { execFile } from 'node:child_process';

function gitInsideWorktree(path: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['-C', path, 'rev-parse', '--is-inside-work-tree'], (error, stdout) => {
      resolve(error ? '' : stdout.trim());
    });
  });
}

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
    expect(env.TMPDIR).not.toContain(dataDir);
    expect(existsSync(env.TMPDIR as string)).toBe(true);
  });

  it('honors an explicit CEZ_HOME and keeps it outside the checkout', () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-agent-home-'));
    const env = { CEZ_HOME: home };
    try {
      expect(agentTmpEnv(dataDir, 'explicit-home', env).TMPDIR)
        .toBe(agentTmpDir(dataDir, 'explicit-home', env));
      expect(agentTmpDir(dataDir, 'explicit-home', env)).toContain(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('falls back outside the checkout when CEZ_HOME is inside it', () => {
    const inside = join(dataDir, 'state');
    const env = { CEZ_HOME: inside };
    const path = agentTmpDir(dataDir, 'inside-home', env);
    expect(path.startsWith(`${dataDir}/`)).toBe(false);
    expect(agentTmpEnv(dataDir, 'inside-home', env).TMPDIR).toBe(path);
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

  it('keeps scratch outside a checkout when CEZ_HOME is a sibling repo directory', async () => {
    const repo = mkdtempSync(join(realpathSync(tmpdir()), 'cez-agent-boundary-repo-'));
    try {
      await new Promise<void>((resolve, reject) => {
        execFile('git', ['init', '-q', repo], (error) => (error ? reject(error) : resolve()));
      });
      const checkoutData = join(repo, '.ai', 'cezar');
      const scratch = agentTmpDir(checkoutData, 'run-boundary', {
        CEZ_HOME: join(repo, '.cezar'),
      });
      expect(relative(repo, scratch)).toMatch(/^\.\./);
      expect(await gitInsideWorktree(scratch)).not.toBe('true');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('fails with a named, actionable error when the directory cannot be created', () => {
    // The hashed project namespace occupied by a FILE — mkdir cannot make the
    // run's directory. Deterministic and portable, unlike simulating a quota.
    mkdirSync(dirname(dirname(agentTmpDir(dataDir, 'run-c'))), { recursive: true });
    writeFileSync(dirname(agentTmpDir(dataDir, 'run-c')), 'not a directory', 'utf8');
    let thrown: unknown;
    try {
      agentTmpEnv(dataDir, 'run-c', {});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AgentTempDirError);
    expect((thrown as Error).message).toContain('agent temp directory is not writable');
    expect((thrown as Error).message).toContain(agentTmpDir(dataDir, 'run-c'));
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
      mkdirSync(dirname(dirname(agentTmpDir(dataDir, 'run-h'))), { recursive: true });
      writeFileSync(dirname(agentTmpDir(dataDir, 'run-h')), 'not a directory', 'utf8');
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

/**
 * The scratch tree is the agent's whole `TMPDIR`, and the Claude backend
 * round-trips each command's stdout and stderr through a file in it. Default
 * permissions make that world-readable, and the platform-temp fallback root is a
 * fixed path in a directory every local user can write — the pair CodeQL flagged
 * as `js/insecure-temporary-file` (high) on #1129.
 */
describe('agent scratch is private to its owner (#999)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(realpathSync(tmpdir()), 'cez-agent-tmpdir-perm-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('mints the run directory owner-only', () => {
    const dir = agentTmpEnv(dataDir, 'run-private', {}).TMPDIR as string;
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  // The fallback is reached only through CEZ_HOME-inside-the-checkout, so this is
  // also the end-to-end proof that agentTmpEnv vets the shared root before use.
  it.skipIf(process.platform === 'win32')('mints the platform-temp fallback root owner-only', () => {
    const env = { CEZ_HOME: join(dataDir, 'state') };
    const dir = agentTmpEnv(dataDir, 'run-fallback', env).TMPDIR as string;
    expect(dir.startsWith(`${dataDir}/`)).toBe(false);
    // <platform tmp>/cez-agent/<hashed project>/<runId>
    expect(statSync(dirname(dirname(dir))).mode & 0o777).toBe(0o700);
  });

  describe('securePrivateDir', () => {
    it.skipIf(process.platform === 'win32')('creates a missing base owner-only', () => {
      const base = join(dataDir, 'nested', 'base');
      securePrivateDir(base);
      expect(statSync(base).mode & 0o777).toBe(0o700);
    });

    // The realistic case on a long-lived box: a base minted before this guard
    // existed, left group- and world-readable by the ambient umask.
    it.skipIf(process.platform === 'win32')('re-tightens a loose base it owns', () => {
      const base = join(dataDir, 'loose');
      mkdirSync(base, { recursive: true, mode: 0o755 });
      chmodSync(base, 0o755);
      securePrivateDir(base);
      expect(statSync(base).mode & 0o777).toBe(0o700);
    });

    // The attack the fixed fallback path invites: pre-create it as a symlink into
    // a directory the attacker reads, and every agent's scratch lands there.
    it('refuses a symlinked base instead of following it', () => {
      const target = join(dataDir, 'attacker');
      const base = join(dataDir, 'link');
      mkdirSync(target, { recursive: true });
      symlinkSync(target, base);
      expect(() => securePrivateDir(base)).toThrow(AgentTempDirError);
      expect(readdirSync(target)).toEqual([]);
    });

    // The thread footer renders this message and nothing else, so the one thing it
    // tells the reader to do has to be the thing that helps.
    it('names a remedy that fits, not “free disk space”', () => {
      const base = join(dataDir, 'link-remedy');
      mkdirSync(join(dataDir, 'elsewhere'), { recursive: true });
      symlinkSync(join(dataDir, 'elsewhere'), base);
      expect(() => securePrivateDir(base)).toThrow(/remove or take ownership of that path/);
      expect(() => securePrivateDir(base)).not.toThrow(/free disk space/);
      expect(() => securePrivateDir(base)).toThrow(/CEZ_AGENT_TMPDIR=0/);
    });

    it('is idempotent across runs sharing the base', () => {
      const base = join(dataDir, 'shared');
      securePrivateDir(base);
      expect(() => securePrivateDir(base)).not.toThrow();
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

  it('is a no-op before any run has minted a directory', () => {
    expect(sweepAgentTmpDirs(dataDir, [])).toEqual([]);
  });
});
