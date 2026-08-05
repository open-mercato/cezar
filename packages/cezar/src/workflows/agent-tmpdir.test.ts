import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunStore } from '../runs/store.ts';
import { AgentTempDirError, agentTmpDir } from '../runs/agent-tmpdir.ts';
import { registerProject } from '../workspace/projects.ts';
import { RunManager, agentDirectories } from './run.ts';

/**
 * #785 wiring: the per-run temp directory has to reach the SPAWN, be gone when
 * the run ends, and fail the run loudly when it cannot be had.
 *
 * Exercised at the `agentEnvForStep` seam — the last common path before every
 * backend spawn — for the same reason the agent-profile tests use it: the point
 * under test is the exact environment handed to the child, and a dry run would
 * prove nothing (the mock CLI does not echo its environment).
 */
describe('RunManager — task-scoped agent TMPDIR (#785)', () => {
  const savedHome = process.env.CEZ_HOME;
  let home: string;
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let manager: RunManager;

  type Seam = {
    agentEnvForStep(
      runId: string,
      backend: 'claude' | 'codex' | 'opencode',
      options?: { generateFollowups?: boolean; recordedProfileId?: string },
    ): Promise<{ env: Record<string, string>; profileId: string }>;
    dropActive(runId: string): void;
  };
  const seam = () => manager as unknown as Seam;

  beforeEach(async () => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-agent-tmpdir-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-agent-tmpdir-repo-'));
    dataDir = join(repoRoot, '.ai/cezar');
    process.env.CEZ_HOME = home;
    store = RunStore.open(dataDir);
    manager = new RunManager(store, repoRoot);
    await registerProject(repoRoot);
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
  });

  const newRun = () =>
    store.createRun({
      title: 't',
      workflow: 'w',
      task: 't',
      steps: [{ id: 's', name: 's', kind: 'agent' }],
    });

  it('hands the spawn a TMPDIR under <dataDir>/tmp/<runId>, already created', async () => {
    const run = newRun();
    const { env } = await seam().agentEnvForStep(run.id, 'claude');
    expect(env.TMPDIR).toBe(agentTmpDir(dataDir, run.id));
    expect(env.TEMP).toBe(env.TMPDIR);
    expect(env.TMP).toBe(env.TMPDIR);
    // Created BEFORE the backend spawns — the backend roots its own scratch tree
    // at `os.tmpdir()` the moment it starts.
    expect(existsSync(env.TMPDIR as string)).toBe(true);
  });

  it('gives two runs on the same machine separate directories', async () => {
    const [a, b] = [newRun(), newRun()];
    const envA = (await seam().agentEnvForStep(a.id, 'claude')).env;
    const envB = (await seam().agentEnvForStep(b.id, 'claude')).env;
    expect(envA.TMPDIR).not.toBe(envB.TMPDIR);
  });

  it('reaps the directory when the run leaves the active registry', async () => {
    const run = newRun();
    const { env } = await seam().agentEnvForStep(run.id, 'claude');
    writeFileSync(join(env.TMPDIR as string, 'scratch'), 'x', 'utf8');
    seam().dropActive(run.id);
    expect(existsSync(env.TMPDIR as string)).toBe(false);
  });

  it('a Continue after that reap mints the directory again', async () => {
    const run = newRun();
    const { env } = await seam().agentEnvForStep(run.id, 'claude');
    seam().dropActive(run.id);
    const again = await seam().agentEnvForStep(run.id, 'claude');
    expect(again.env.TMPDIR).toBe(env.TMPDIR);
    expect(existsSync(again.env.TMPDIR as string)).toBe(true);
  });

  // The whole point of the preflight: refuse to start rather than spawn an agent
  // whose every shell command will come back empty.
  it('fails before spawning when the temp directory cannot be had', async () => {
    const run = newRun();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'tmp'), 'not a directory', 'utf8');
    await expect(seam().agentEnvForStep(run.id, 'claude')).rejects.toBeInstanceOf(AgentTempDirError);
  });

  // A crash never reaches the terminal-transition reap, so without the startup
  // sweep the directories would accumulate exactly the way `/tmp` did.
  it('sweeps orphaned directories at startup', async () => {
    const dead = newRun();
    const { env } = await seam().agentEnvForStep(dead.id, 'claude');
    store.updateRun(dead.id, { status: 'done', finishedAt: new Date().toISOString() });
    expect(existsSync(env.TMPDIR as string)).toBe(true);

    await manager.recover();
    expect(existsSync(env.TMPDIR as string)).toBe(false);
  });

  it('the error names the path and the way out, so the thread footer is actionable', async () => {
    const run = newRun();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'tmp'), 'not a directory', 'utf8');
    await expect(seam().agentEnvForStep(run.id, 'claude')).rejects.toThrow(
      /agent temp directory is not writable: .* — free disk space, or set CEZ_AGENT_TMPDIR=0/,
    );
  });

  describe('CEZ_AGENT_TMPDIR=0', () => {
    const saved = process.env.CEZ_AGENT_TMPDIR;
    beforeEach(() => {
      process.env.CEZ_AGENT_TMPDIR = '0';
    });
    afterEach(() => {
      if (saved === undefined) delete process.env.CEZ_AGENT_TMPDIR;
      else process.env.CEZ_AGENT_TMPDIR = saved;
    });

    it('restores the pre-#785 environment: no override, no directory', async () => {
      const run = newRun();
      const { env } = await seam().agentEnvForStep(run.id, 'claude');
      expect(env.TMPDIR).toBeUndefined();
      expect(existsSync(agentTmpDir(dataDir, run.id))).toBe(false);
      // The handoff contract is untouched by the opt-out.
      expect(env.CEZ_TASK_ID).toBe(run.id);
    });

    // A run that started before #785 must still start with the hatch set — the
    // preflight is part of what the hatch turns off, or it is not an escape.
    it('still spawns when the temp directory could not have been created', async () => {
      const run = newRun();
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, 'tmp'), 'not a directory', 'utf8');
      await expect(seam().agentEnvForStep(run.id, 'claude')).resolves.toMatchObject({
        env: { CEZ_TASK_ID: run.id },
      });
    });
  });
});

/**
 * An agent handed a TMPDIR its file tools may not write to would trade one silent
 * failure for another, so the grant travels with the variable.
 */
describe('agentDirectories (#785)', () => {
  it('grants the run’s temp directory alongside the run-state folder', () => {
    expect(agentDirectories('/data/runs', { TMPDIR: '/data/tmp/run-1' }))
      .toEqual(['/data/runs', '/data/tmp/run-1']);
  });

  it('is exactly the pre-#785 list when the run has no temp directory', () => {
    expect(agentDirectories('/data/runs', {})).toEqual(['/data/runs']);
  });
});
