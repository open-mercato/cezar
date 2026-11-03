import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalizeAdvisorRefs } from './advisor-identity.js';
import { acquireIssueClaim, releaseIssueClaim } from './issue-claim.js';
import {
  HARNESS_PROMPT_BUDGET_BYTES,
  promptBudgetError,
  promptExcerpt,
  boundedFindings,
  advisorCouncilTimeoutMs,
} from './prompt-budget.js';
import { harnessStageResultSchema, samePathSet } from './stage-result.js';
import { harnessPhaseSkills } from './skill-routing.js';
import { createClaudeStageOnlySettings, stageOnlyDeniedReads } from './claude-guard.js';

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

describe('harness safety primitives', () => {
  it('[925-7] renders severity first and excerpts evidence within a byte budget', () => {
    const rendered = boundedFindings([
      { severity: 'nit', title: 'cosmetic', evidence: '界'.repeat(4_000) },
      { severity: 'blocker', title: 'critical', evidence: '界'.repeat(4_000) },
    ], '/artifacts/full.json', 2_500);
    expect(rendered.indexOf('critical')).toBeGreaterThan(0);
    expect(rendered.indexOf('cosmetic')).toBe(-1);
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(2_500);
    expect(rendered).toContain('/artifacts/full.json');
    expect(rendered).toContain('Additional findings/evidence');
  });

  it('[925-6] budgets part waves using each advisor input and timeout bounds', () => {
    expect(advisorCouncilTimeoutMs([{ timeoutMs: 600_000 }], 1_000, 10_000)).toBe(720_000);
    expect(advisorCouncilTimeoutMs([{ timeoutMs: 1_800_000, maxInputBytes: 80_000 }], 800_000, 10_000))
      .toBeGreaterThanOrEqual(8 * 1_800_000 + 120_000);
  });

  it('rejects advisor family tampering and returns the trusted family', () => {
    const models = { deepseek: { family: 'deepseek' } };
    expect(
      canonicalizeAdvisorRefs(
        [{ runner: 'harness', model: 'deepseek', family: 'openai' }],
        models,
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining('trusted configuration') });
    expect(
      canonicalizeAdvisorRefs(
        [{ runner: 'harness', model: 'deepseek' }],
        models,
      ),
    ).toEqual({
      ok: true,
      refs: [{ runner: 'harness', model: 'deepseek', family: 'deepseek' }],
    });
  });

  it('rejects auth-store credentials redirected away from their official endpoint', () => {
    const ref = [{ runner: 'harness', model: 'deepseek', family: 'deepseek' }];
    const official = {
      deepseek: {
        adapter: 'preset',
        preset: 'deepseek-api',
        family: 'deepseek',
        endpoint: 'https://api.deepseek.com/chat/completions',
        authStoreProvider: 'deepseek',
      },
    };
    expect(canonicalizeAdvisorRefs(ref, official)).toMatchObject({ ok: true });
    expect(
      canonicalizeAdvisorRefs(ref, {
        deepseek: { ...official.deepseek, endpoint: 'https://example.invalid/completions' },
      }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('official preset, provider, and endpoint'),
    });
  });

  it('budgets the complete prompt and marks model-facing excerpts', () => {
    expect(promptBudgetError('small')).toBeNull();
    expect(promptBudgetError('x'.repeat(HARNESS_PROMPT_BUDGET_BYTES + 1))).toMatch(
      /exceeding/,
    );
    expect(promptExcerpt('abcdefgh', 4)).toContain('abcd\n…');
  });

  it('parses explicit stage results with bounded paths and compares path sets', () => {
    expect(
      harnessStageResultSchema.safeParse({
        status: 'ready',
        stagedPaths: ['src/a.ts'],
      }).success,
    ).toBe(true);
    // the set is git-derived and proven by `samePathSet`, so its size is not capped.
    expect(
      harnessStageResultSchema.safeParse({
        status: 'ready',
        stagedPaths: Array.from({ length: 201 }, (_, index) => `src/${index}.ts`),
      }).success,
    ).toBe(true);
    expect(
      harnessStageResultSchema.safeParse({ status: 'ready', stagedPaths: [`src/${'x'.repeat(1_001)}.ts`] }).success,
    ).toBe(false);
    expect(samePathSet(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(samePathSet(['a'], ['a', 'b'])).toBe(false);
  });

  it('holds one local issue lease, permits same-run recovery, and releases by owner', () => {
    const cwd = tempDir('cez-claim-');
    execFileSync('git', ['init', '-b', 'main'], { cwd, stdio: 'ignore' });
    const first = acquireIssueClaim(cwd, 'run-a', '642');
    expect(first.ok).toBe(true);
    expect(acquireIssueClaim(cwd, 'run-a', '642')).toMatchObject({ ok: true });
    expect(acquireIssueClaim(cwd, 'run-b', '642')).toMatchObject({
      ok: false,
      error: expect.stringContaining('run-a'),
    });
    if (!first.ok) throw new Error(first.error);
    expect(releaseIssueClaim(first.claim.path, 'run-b')).toMatchObject({ ok: false });
    expect(releaseIssueClaim(first.claim.path, 'run-a')).toEqual({ ok: true });
    expect(acquireIssueClaim(cwd, 'run-b', '642')).toMatchObject({ ok: true });
  });

  // a claim whose run was deleted (or whose `.ai/cezar/` was) had no release path,
  // so every later harness run on that issue failed preflight until someone found the file.
  it('takes over a claim this project no longer knows, never one another project holds', () => {
    const cwd = tempDir('cez-claim-stale-');
    execFileSync('git', ['init', '-b', 'main'], { cwd, stdio: 'ignore' });
    const owner = (dataDir: string, live: string[]) => ({ dataDir, runExists: (id: string) => live.includes(id) });

    expect(acquireIssueClaim(cwd, 'run-a', '642', owner('/p/one', ['run-a']))).toMatchObject({ ok: true });
    // Live in this project: still refused.
    expect(acquireIssueClaim(cwd, 'run-b', '642', owner('/p/one', ['run-a', 'run-b']))).toMatchObject({ ok: false });
    // Another project's claim: never judged by this project's ledgers.
    expect(acquireIssueClaim(cwd, 'run-b', '642', owner('/p/two', ['run-b']))).toMatchObject({ ok: false });
    // run-a is gone from this project: its claim is stale and passes to run-b.
    const taken = acquireIssueClaim(cwd, 'run-b', '642', owner('/p/one', ['run-b']));
    expect(taken).toMatchObject({ ok: true });
    if (!taken.ok) throw new Error(taken.error);
    expect(JSON.parse(readFileSync(taken.claim.path, 'utf8'))).toMatchObject({ runId: 'run-b', dataDir: '/p/one' });
  });

  // Read, Grep and Glob run in-process, outside the Bash sandbox and its denyRead,
  // so a phase could read a host key and stage it.
  it('refuses Read, Grep and Glob of host credential stores', () => {
    const root = tempDir('cez-claude-reads-');
    const worktree = join(root, 'worktree');
    const artifacts = join(root, 'artifacts');
    mkdirSync(worktree);
    const guard = createClaudeStageOnlySettings(artifacts, worktree, join(artifacts, 'agent-output', 'phase-x'), 'linux');
    const hook = (JSON.parse(readFileSync(guard.settingsPath, 'utf8')) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    }).hooks.PreToolUse[0]!;
    expect(hook.matcher.split('|')).toEqual(expect.arrayContaining(['Read', 'Grep', 'Glob']));
    const guardPath = JSON.parse(hook.hooks[0]!.command.slice('node '.length)) as string;
    const invoke = (tool_name: string, tool_input: Record<string, string>) =>
      execFileSync(process.execPath, [guardPath], {
        input: JSON.stringify({ tool_name, tool_input }),
        env: { ...process.env, ...guard.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    const home = homedir();
    expect(() => invoke('Read', { file_path: join(home, '.ssh', 'id_ed25519') })).toThrow();
    expect(() => invoke('Read', { file_path: join(home, '.codex', 'auth.json') })).toThrow();
    expect(() => invoke('Grep', { pattern: 'BEGIN', path: home })).toThrow();
    expect(() => invoke('Glob', { pattern: '*', path: join(home, '.aws') })).toThrow();
    expect(() => invoke('Read', { file_path: join(worktree, 'src', 'a.ts') })).not.toThrow();
    expect(() => invoke('Grep', { pattern: 'x' })).not.toThrow();
    expect(() => invoke('Read', { file_path: '/etc/hosts' })).not.toThrow();
  });

  // every reviewer shared one writable output root, so one could write another's
  // verdict and the driver counted it toward quorum.
  it('confines each session to its own output directory', () => {
    const root = tempDir('cez-claude-sessions-');
    const worktree = join(root, 'worktree');
    const artifacts = join(root, 'artifacts');
    const own = join(artifacts, 'agent-output', 'phase-review-r1');
    const sibling = join(artifacts, 'agent-output', 'phase-review-r2');
    mkdirSync(worktree);

    const linux = createClaudeStageOnlySettings(artifacts, worktree, own, 'linux');
    const linuxSibling = createClaudeStageOnlySettings(artifacts, worktree, sibling, 'linux');
    expect(linux.settingsPath).not.toBe(linuxSibling.settingsPath);
    const allowed = (path: string) =>
      (JSON.parse(readFileSync(path, 'utf8')) as { sandbox: { filesystem: { allowWrite: string[] } } }).sandbox.filesystem.allowWrite;
    expect(allowed(linux.settingsPath)).toEqual([own]);
    expect(allowed(linuxSibling.settingsPath)).toEqual([sibling]);

    const mac = createClaudeStageOnlySettings(artifacts, worktree, own, 'darwin');
    const macRuntime = JSON.parse(readFileSync(join(dirname(mac.settingsPath), 'sandbox-runtime.json'), 'utf8')) as {
      filesystem: { allowWrite: string[] };
    };
    expect(macRuntime.filesystem.allowWrite).toContain(own);
    expect(macRuntime.filesystem.allowWrite).not.toContain(sibling);

    const command = (JSON.parse(readFileSync(mac.settingsPath, 'utf8')) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    }).hooks.PreToolUse[0]!.hooks[0]!.command;
    const invoke = (file_path: string) =>
      execFileSync(process.execPath, [JSON.parse(command.slice('node '.length)) as string], {
        input: JSON.stringify({ tool_input: { file_path } }),
        env: { ...process.env, ...mac.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    expect(() => invoke(join(own, 'result.json'))).not.toThrow();
    expect(() => invoke(join(sibling, 'result.json'))).toThrow();
  });

  it('materializes a strict Claude sandbox and rejects writes outside its two roots', () => {
    const root = tempDir('cez-claude-guard-');
    const worktree = join(root, 'worktree');
    const artifacts = join(root, 'artifacts');
    const output = join(artifacts, 'agent-output');
    mkdirSync(worktree);
    const guard = createClaudeStageOnlySettings(artifacts, worktree, output);
    const settings = JSON.parse(readFileSync(guard.settingsPath, 'utf8')) as {
      sandbox?: {
        enabled: boolean;
        failIfUnavailable: boolean;
        allowUnsandboxedCommands: boolean;
        filesystem: { allowWrite: string[] };
      };
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    if (process.platform === 'darwin') {
      expect(settings.sandbox).toBeUndefined();
      expect(guard.env.CLAUDE_CODE_SHELL_PREFIX).toBe(guard.sandboxWrapperPath);
    } else {
      expect(settings.sandbox).toMatchObject({
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        filesystem: { allowWrite: [output] },
      });
    }
    const command = settings.hooks.PreToolUse[0]!.hooks[0]!.command;
    const guardPath = JSON.parse(command.slice('node '.length)) as string;
    const invoke = (toolInput: Record<string, string>) =>
      execFileSync(process.execPath, [guardPath], {
        input: JSON.stringify({ tool_input: toolInput }),
        env: { ...process.env, ...guard.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    expect(() => invoke({ file_path: join(worktree, 'src', 'safe.ts') })).not.toThrow();
    expect(() => invoke({ file_path: join(output, 'phase-result.json') })).not.toThrow();
    expect(() => invoke({ file_path: join(root, 'outside.ts') })).toThrow();
    // host git follows the worktree's .git pointer.
    expect(() => invoke({ file_path: join(worktree, '.git') })).toThrow();
    expect(() => invoke({ file_path: join(worktree, '.git', 'config') })).toThrow();
    expect(() => invoke({ file_path: join(worktree, '.github', 'ci.yml') })).not.toThrow();
    // a dangling link "did not exist", so a write through it reached any host path.
    const hostTarget = join(root, 'outside-not-yet', 'planted.plist');
    symlinkSync(hostTarget, join(worktree, 'innocent.txt'));
    expect(() => invoke({ file_path: join(worktree, 'innocent.txt') })).toThrow();
    mkdirSync(join(worktree, 'src'), { recursive: true });
    symlinkSync(join(root, 'no-such-dir'), join(worktree, 'src', 'linked'));
    expect(() => invoke({ file_path: join(worktree, 'src', 'linked', 'x.ts') })).toThrow();
    // ...and on a case-insensitive filesystem `.GIT` is the pointer.
    if (process.platform === 'darwin' || process.platform === 'win32') {
      expect(() => invoke({ file_path: join(worktree, '.GIT') })).toThrow();
      expect(() => invoke({ file_path: join(worktree, '.Git', 'config') })).toThrow();
    }
    expect(() => invoke({ command: 'git push origin HEAD' })).toThrow();
    expect(() => invoke({ command: 'git -C . push origin HEAD' })).toThrow();
    expect(() => invoke({ command: '/usr/bin/git --no-pager commit -m unsafe' })).toThrow();
    expect(() => invoke({ command: 'gh --repo owner/repo pr create --fill' })).toThrow();
    expect(() => invoke({ command: 'gh issue edit 42 --add-assignee @me' })).toThrow();
    expect(() => invoke({ command: 'gh pr review 42 --approve' })).toThrow();
    expect(() => invoke({ command: 'gh issue view 42 --json title' })).not.toThrow();
    expect(() => invoke({ command: 'gh api -X POST repos/o/r/pulls' })).toThrow();
    expect(() => invoke({ command: 'gh api --method=DELETE repos/o/r/git/refs/heads/x' })).toThrow();
    // MCP tools run outside the sandbox and the path checks alike.
    const invokeTool = (toolName: string) =>
      execFileSync(process.execPath, [guardPath], {
        input: JSON.stringify({ tool_name: toolName, tool_input: {} }),
        env: { ...process.env, ...guard.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    expect((settings.hooks.PreToolUse[0] as { matcher?: string }).matcher).toContain('mcp__.*');
    expect(() => invokeTool('mcp__github__create_pull_request')).toThrow();
    expect(() => invokeTool('Read')).not.toThrow();
    expect(() => invoke({ command: 'gh api repos/o/r/issues/1/comments -f body=hi' })).toThrow();
    expect(() => invoke({ command: "gh api graphql -f query='mutation { closeIssue }'" })).toThrow();
    expect(() => invoke({ command: 'gh api repos/o/r/issues/1 --jq .title' })).not.toThrow();
    expect(() => invoke({ command: 'printf "git"; echo push' })).not.toThrow();

    const incompleteEnv = { ...process.env };
    delete incompleteEnv.CEZ_HARNESS_WORKTREE;
    let missingRootExit: number | undefined;
    try {
      execFileSync(process.execPath, [guardPath], {
        input: JSON.stringify({ tool_input: { command: 'printf allowed' } }),
        env: incompleteEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      missingRootExit = (error as { status?: number }).status;
    }
    expect(missingRootExit).toBe(2);

    if (process.platform === 'darwin') {
      const wrapper = guard.sandboxWrapperPath!;
      const worktreeFile = join(worktree, 'safe.txt');
      const outputFile = join(output, 'result.json');
      const outsideFile = join(root, 'outside.txt');
      const claudeCwdMarker = join('/tmp', `claude-cez-${process.pid}-cwd`);
      const unrelatedTmpFile = join('/tmp', `cez-unrelated-${process.pid}`);
      temporary.push(claudeCwdMarker, unrelatedTmpFile);
      execFileSync(wrapper, [`printf safe > ${JSON.stringify(worktreeFile)}`], {
        env: { ...process.env, ANTHROPIC_API_KEY: 'must-not-reach-tools' },
      });
      execFileSync(wrapper, [`printf result > ${JSON.stringify(outputFile)}`], {
        env: process.env,
      });
      execFileSync(wrapper, [`printf cwd > ${JSON.stringify(claudeCwdMarker)}`], {
        env: process.env,
      });
      expect(existsSync(worktreeFile)).toBe(true);
      expect(existsSync(outputFile)).toBe(true);
      expect(existsSync(claudeCwdMarker)).toBe(true);
      expect(() =>
        execFileSync(wrapper, [`printf unsafe > ${JSON.stringify(outsideFile)}`], {
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      ).toThrow();
      expect(existsSync(outsideFile)).toBe(false);
      expect(() =>
        execFileSync(wrapper, [`printf unsafe > ${JSON.stringify(unrelatedTmpFile)}`], {
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      ).toThrow();
      expect(existsSync(unrelatedTmpFile)).toBe(false);
      expect(() =>
        execFileSync(wrapper, ['test -z "$ANTHROPIC_API_KEY"'], {
          env: { ...process.env, ANTHROPIC_API_KEY: 'must-not-reach-tools' },
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      ).not.toThrow();
    }
  }, 15_000);

  it('retains Claude native sandboxing with the phase-output allowance off macOS', () => {
    const root = tempDir('cez-claude-native-sandbox-');
    const worktree = join(root, 'worktree');
    const artifacts = join(root, 'artifacts');
    const output = join(artifacts, 'agent-output');
    mkdirSync(worktree);

    const guard = createClaudeStageOnlySettings(artifacts, worktree, output, 'linux');
    const settings = JSON.parse(readFileSync(guard.settingsPath, 'utf8')) as {
      sandbox: {
        enabled: boolean;
        failIfUnavailable: boolean;
        allowUnsandboxedCommands: boolean;
        filesystem: { allowWrite: string[] };
      };
    };

    expect(settings.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { allowWrite: [output] },
    });
    expect(guard.env.CLAUDE_CODE_SHELL_PREFIX).toBeUndefined();
    expect(guard.sandboxWrapperPath).toBeUndefined();
  });

  // a readable gh/git token plus GitHub egress publishes without moving a local ref.
  it('gives sandboxed Bash no egress and no host credential stores on either platform', () => {
    const root = tempDir('cez-claude-sandbox-egress-');
    const worktree = join(root, 'worktree');
    mkdirSync(worktree);
    const denied = stageOnlyDeniedReads();
    expect(denied).toEqual(expect.arrayContaining([
      join(homedir(), '.ssh'),
      join(homedir(), '.config', 'gh'),
      join(homedir(), '.git-credentials'),
      join(homedir(), '.netrc'),
    ]));

    const nativeArtifacts = join(root, 'native');
    const native = createClaudeStageOnlySettings(nativeArtifacts, worktree, join(nativeArtifacts, 'out'), 'linux');
    const nativeSandbox = (JSON.parse(readFileSync(native.settingsPath, 'utf8')) as {
      sandbox: { network: { allowedDomains: string[] }; filesystem: { denyRead: string[]; denyWrite: string[] } };
    }).sandbox;
    expect(nativeSandbox.network.allowedDomains).toEqual([]);
    expect(nativeSandbox.filesystem.denyRead).toEqual(denied);
    // The guard hook runs outside the sandbox; host git follows the pointer.
    expect(nativeSandbox.filesystem.denyWrite).toEqual([
      join(worktree, '.git'),
      join(nativeArtifacts, 'claude-guard'),
    ]);

    const macArtifacts = join(root, 'mac');
    const mac = createClaudeStageOnlySettings(macArtifacts, worktree, join(macArtifacts, 'out'), 'darwin');
    const runtime = JSON.parse(readFileSync(join(dirname(mac.settingsPath), 'sandbox-runtime.json'), 'utf8')) as {
      network: { allowedDomains: string[] };
      filesystem: { denyRead: string[]; denyWrite: string[] };
    };
    expect(runtime.network.allowedDomains).toEqual([]);
    expect(runtime.filesystem.denyRead).toEqual(denied);
    expect(runtime.filesystem.denyWrite).toEqual([join(worktree, '.git'), join(macArtifacts, 'claude-guard')]);
  });

  it('routes generic repositories to complete bundled Cezar skills by default', () => {
    expect(harnessPhaseSkills()).toEqual({
      specWriting: 'cez-spec-writing',
      preImplement: 'cez-pre-implement-spec',
      implementSpec: 'cez-implement-spec',
      codeReview: 'cez-code-review',
      qualify: 'cez-verify-in-repo',
      diagnose: 'cez-root-cause',
      fix: 'cez-fix',
    });
  });

  it('routes Open Mercato repositories to the exact canonical om-* skills', () => {
    expect(harnessPhaseSkills('open-mercato')).toEqual({
      specWriting: 'om-spec-writing',
      preImplement: 'om-pre-implement-spec',
      implementSpec: 'om-implement-spec',
      codeReview: 'om-code-review',
      qualify: 'om-verify-in-repo',
      diagnose: 'om-root-cause',
      fix: 'om-fix',
    });
  });
});
