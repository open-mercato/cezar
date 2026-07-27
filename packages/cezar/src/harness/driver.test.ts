import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadLedger, saveLedger, createLedger, startPhase, finishPhase } from './ledger.js';
import { HARNESS_FIX_ISSUE, HARNESS_IMPLEMENT_FEATURE } from './workflows.js';
import {
  harnessArtifactDir,
  runHarnessDriver,
  snapshotHarnessReviewSubject,
  snapshotHarnessStageSubject,
  type HarnessDriverDeps,
  type HarnessDriverHost,
  type HarnessAgentPhaseRequest,
} from './driver.js';
import { probeKey, type ProbeVerdict } from './probe.js';

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
}

function makeHarness(dir: string) {
  const calls: FakeCall[] = [];
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  const steps = new Map<string, string>();

  /** Per-phase agent behavior — the default writes a plausible result file. */
  const agentBehavior = new Map<string, (req: HarnessAgentPhaseRequest) => string | null>();
  const defaultResults: Record<string, unknown> = {
    qualify: { outcome: 'work_needed', evidence: 'bug reproduced on main' },
    diagnose: { summary: 'race in flushQueued', files: ['src/runs/store.ts'], regressionTest: 'store.replay-race' },
    implement: { changedPaths: ['src/runs/store.ts', 'test/unit/store.test.ts'], suggestedCommit: 'fix(runs): guard replay' },
    'packet-plan': {
      summary: 'one bounded packet',
      packets: [
        {
          version: 1,
          id: 'PK-01',
          title: 'Replay guard',
          objective: 'Guard queued replay',
          risk: 'medium',
          allowedPaths: ['src/runs/store.ts', 'test/unit/store.test.ts'],
          invariants: ['queued messages are delivered once'],
          acceptanceCriteria: ['the replay race has a regression test'],
          dependencies: [],
          nonGoals: [],
          referencePatterns: [],
        },
      ],
    },
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
      calls.push({ kind: 'agent', id: req.phaseId });
      const base = req.phaseId.replace(/-\d+$/, '');
      // Exact phase id first, then the base name — so `review` behavior also
      // drives `review-2` unless a test pins the round explicitly.
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

  /** The sealed runtime's digest as the driver will observe it. A test flips
   *  this mid-run to simulate the runtime being rewritten under us. */
  let sealedDigest = 'sealed-sha';
  const sealDigest = () => sealedDigest;

  const ops: FakeCall[] = [];
  /** Per-model probe verdicts, keyed by `roleRefId`. Empty = everything ready. */
  const probeVerdicts = new Map<string, ProbeVerdict>();

  /** Scripted council-op outcome. Returns undefined to take the default
   *  "everyone approves" behavior. */
  let councilBehavior: (ids: string[]) =>
    | { ok: boolean; stderr?: string; result?: unknown }
    | undefined = () => undefined;
  const setCouncilBehavior = (fn: typeof councilBehavior) => {
    councilBehavior = fn;
  };
  let packetRunBehavior: (call: number) => 'awaiting_validation' | 'implementing' = () =>
    'awaiting_validation';
  let packetRunCalls = 0;
  const setPacketRunBehavior = (fn: typeof packetRunBehavior) => {
    packetRunBehavior = fn;
  };

  const deps: HarnessDriverDeps = {
    resolveScript: () => join(dir, 'harness.mjs'),
    // The sealed-runtime seam (2026-07-27). Tests never materialize a real
    // skill tree, so seal to a stable fake and keep its digest constant —
    // `sealDigest` below lets a test simulate tampering.
    sealRuntime: () => ({ script: join(dir, 'sealed-harness.mjs'), sha256: sealDigest() }),
    scriptDigest: () => sealDigest(),
    createRuntime: () => ({
      run: async (op: string, args: string[]) => {
        ops.push({ kind: 'op', id: op, args });
        calls.push({ kind: 'op', id: op, args });
        if (op === 'capture') {
          writeFileSync(join(harnessArtifactDir(host.dataDir, host.runId), 'start-state.json'), '{"refs":{}}', 'utf8');
        }
        if (op === 'worker') {
          const promptPath = args[args.indexOf('--prompt-file') + 1]!;
          const prompt = readFileSync(promptPath, 'utf8');
          const resultPath =
            /result file at (?:the path in )?(.+?\.json) of the shape:/.exec(prompt)?.[1];
          if (resultPath) {
            mkdirSync(dirname(resultPath), { recursive: true });
            writeFileSync(
              resultPath,
              JSON.stringify({
                changedPaths: ['src/fix.ts'],
                summary: 'implemented by trusted worker adapter',
              }),
              'utf8',
            );
          }
        }
        if (op === 'stage') {
          const output = args[args.indexOf('--output') + 1];
          if (output) {
            writeFileSync(output, JSON.stringify({ status: 'ready', stagedPaths: [] }), 'utf8');
          }
        }
        if (op === 'packet-run') {
          packetRunCalls += 1;
          const manifestPath = args[args.indexOf('--manifest') + 1]!;
          const runDir = args[args.indexOf('--run-dir') + 1]!;
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
            id: string;
            allowedPaths: string[];
          };
          const packetDir = join(runDir, 'packets', manifest.id);
          mkdirSync(packetDir, { recursive: true });
          const state = packetRunBehavior(packetRunCalls);
          writeFileSync(
            join(packetDir, 'packet-result.json'),
            JSON.stringify({
              version: 1,
              state,
              packet: manifest,
              currentDiff: {
                sha256: 'a'.repeat(64),
                changedPaths: manifest.allowedPaths,
              },
              error: null,
            }),
            'utf8',
          );
          if (state !== 'awaiting_validation') {
            return {
              ok: false,
              exitCode: 143,
              stdout: '',
              stderr: 'worker process interrupted',
              durationMs: 5,
            };
          }
        }
        if (op === 'packet-gate') {
          const runDir = args[args.indexOf('--run-dir') + 1]!;
          const packetId = args[args.indexOf('--packet') + 1]!;
          const resultPath = join(runDir, 'packets', packetId, 'packet-result.json');
          const packet = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
          writeFileSync(resultPath, JSON.stringify({ ...packet, state: 'gated' }), 'utf8');
        }
        if (op === 'packet-release') {
          const runDir = args[args.indexOf('--run-dir') + 1]!;
          const packetId = args[args.indexOf('--packet') + 1]!;
          const resultPath = join(runDir, 'packets', packetId, 'packet-result.json');
          const packet = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
          writeFileSync(resultPath, JSON.stringify({ ...packet, state: 'aborted' }), 'utf8');
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
    }),
    loadAgentic: async () => ({ baseBranch: 'main', validationCommands: ['echo ok'], agentHarness: undefined }),
    validate: async (commands: string[]) =>
      commands.map((command) => ({ command, status: 'passed' as const, exitCode: 0, evidence: 'ok' })),
    exportConfig: async () => null,
    snapshotReviewSubject: async () => 'stable-review-subject',
    snapshotStageSubject: async () => 'stable-stage-subject',
    // Preflight probes every binding on its real transport; in tests that must
    // never spawn a CLI or reach the network. Individual tests override
    // `probeVerdicts` to exercise the unreachable-model path.
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
  };

  return {
    host,
    deps,
    calls,
    ops,
    events,
    steps,
    agentBehavior,
    probeVerdicts,
    setCouncilBehavior,
    setPacketRunBehavior,
    /** Simulate the sealed runtime being rewritten under a live run. */
    tamperRuntime: (digest = 'tampered-sha') => {
      sealedDigest = digest;
    },
  };
}

describe('harness driver — standard fix-issue graph', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-driver-'));
    mkdirSync(join(dir, '.ai/cezar/runs'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const input = { workflow: HARNESS_FIX_ISSUE, task: 'Fix issue #642', profile: 'standard' as const, issueId: '642' };
  const highAssuranceAgentic = () => ({
    baseBranch: 'main',
    validationCommands: ['echo ok'],
    agentHarness: {
      models: {
        codex: {
          family: 'openai',
          model: 'gpt-5.6-sol',
          roles: ['worker', 'reviewer'] as Array<'worker' | 'reviewer'>,
          commands: { worker: ['codex', 'exec'], review: ['codex', 'exec'] },
        },
        deepseek: {
          family: 'deepseek',
          model: 'deepseek-v4-pro',
          roles: ['reviewer'] as Array<'reviewer'>,
          adapter: 'preset' as const,
        },
      },
      profiles: {
        'high-assurance': {
          workers: ['codex'],
          reviewers: ['codex', 'deepseek'],
          reviewPolicy: { mode: 'all-required' as const },
        },
      },
    },
  });

  it('runs the full graph in order and stages the declared allowlist', async () => {
    const h = makeHarness(dir);
    const error = await runHarnessDriver(h.host, input, h.deps);
    expect(error).toBeNull();

    const order = h.calls.map((c) => c.id);
    // Sequencing: agent phases sandwiched by capture first and stage last.
    expect(order[0]).toBe('capture');
    expect(order[order.length - 1]).toBe('stage');
    expect(order.indexOf('qualify')).toBeLessThan(order.indexOf('diagnose'));
    expect(order.indexOf('diagnose')).toBeLessThan(order.indexOf('implement'));
    expect(order.indexOf('implement')).toBeLessThan(order.indexOf('review'));

    // The stage op received the start state and the allowlist file, whose
    // content is the implement phase's declared paths.
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
      error: 'ended without a valid result file',
    });
    const resultPath = join(
      harnessArtifactDir(h.host.dataDir, h.host.runId),
      'phase-qualify-result.json',
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

  it('stages after maxFixRounds with the surviving findings named, instead of discarding the work', async () => {
    const h = makeHarness(dir);
    h.agentBehavior.set('review', (req) => {
      writeFileSync(
        req.resultPath,
        JSON.stringify({ verdict: 'request_changes', findings: [{ severity: 'blocker', title: 'still broken' }] }),
        'utf8',
      );
      return null;
    });
    for (const id of ['fix-2', 'fix-3']) {
      h.agentBehavior.set(id, (req) => {
        writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['src/runs/store.ts'] }), 'utf8');
        return null;
      });
    }
    const error = await runHarnessDriver(h.host, input, h.deps);
    // Bounded rounds still apply; what changed is what happens at the bound —
    // stage-only delivery hands the human the work plus what is unresolved.
    expect(error).toBeNull();
    expect(h.calls.filter((c) => c.id.startsWith('review'))).toHaveLength(3);
    expect(h.calls.map((c) => c.id)).toContain('stage');
    const notes = h.events.filter((e) => e.type === 'note').map((e) => String(e.message));
    expect(notes.some((n) => n.includes('fix loop exhausted') && n.includes('still broken'))).toBe(true);
  });

  /**
   * Regression (review 2026-07-27): a reviewer that lists a blocker and still
   * labels the pass "approve" used to end the fix loop and stage the run as
   * ready — `mergedVerdict === 'approve'` short-circuited before any contested
   * outcome was recorded. The verdict is derived from the findings now, exactly
   * as the vendored runtime already did for advisor reviews.
   */
  it('coerces a self-contradicting "approve" and never stages blockers as ready', async () => {
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
    for (const id of ['fix-2', 'fix-3']) {
      h.agentBehavior.set(id, (req) => {
        writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['src/runs/store.ts'] }), 'utf8');
        return null;
      });
    }

    const error = await runHarnessDriver(h.host, input, h.deps);

    expect(error).toBeNull();
    // The "approve" label no longer ends the loop: the fix rounds actually run.
    expect(h.calls.filter((c) => c.id.startsWith('review')).length).toBeGreaterThan(1);
    const ledger = loadLedger(h.host.dataDir, h.host.runId);
    expect(ledger?.outcome.status).toBe('contested');
    expect(ledger?.outcome.blockingReasons.join(' ')).toContain('Auth check removed');
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
    // Sealed OUT of the worktree — the path the worker can write is not the
    // path that runs.
    expect(pinned?.path).not.toContain('.claude/skills');
  });

  it('refuses to execute a runtime that changed mid-run', async () => {
    const h = makeHarness(dir);
    // The implement phase "rewrites" the runtime, exactly as a prompt-injected
    // worker would, then the next op tries to run it.
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

  it('changes the real review-subject hash when a tracked edit moves into the index', async () => {
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
    const staged = await snapshotHarnessReviewSubject(repo);
    const stagedStageSubject = await snapshotHarnessStageSubject(repo);

    expect(staged).not.toBe(unstaged);
    expect(stagedStageSubject).toBe(unstagedStageSubject);
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

  it('rejects a configured profile when its agentHarness bindings are absent', async () => {
    const h = makeHarness(dir);
    const error = await runHarnessDriver(h.host, { ...input, profile: 'multi' }, h.deps);
    expect(error).toMatch(/multi/);
    expect(error).toMatch(/cez-setup-harness/);
    expect(h.calls).toHaveLength(0);
  });

  it.each(['optimized', 'multi', 'multi-optimized', 'high-assurance'] as const)(
    'drives the configured %s profile without silently changing it',
    async (profile) => {
      const h = makeHarness(dir);
      h.deps.loadAgentic = async () => ({
        baseBranch: 'main',
        validationCommands: ['echo ok'],
        agentHarness: {
          models: {
            codex: {
              family: 'openai',
              model: 'gpt-5.6-sol',
              roles: ['worker', 'reviewer'],
              commands: { worker: ['codex', 'exec'], review: ['codex', 'exec'] },
            },
            deepseek: {
              family: 'deepseek',
              model: 'deepseek-v4-pro',
              roles: ['reviewer'],
              adapter: 'preset',
            },
          },
          profiles: {
            optimized: { workers: ['codex'], reviewers: [], reviewPolicy: { mode: 'advisory' } },
            multi: {
              workers: [],
              reviewers: ['codex', 'deepseek'],
              reviewPolicy: { mode: 'all-required' },
            },
            'multi-optimized': {
              workers: ['codex'],
              reviewers: ['codex', 'deepseek'],
              reviewPolicy: { mode: 'all-required' },
            },
            'high-assurance': {
              workers: ['codex'],
              reviewers: ['codex', 'deepseek'],
              reviewPolicy: { mode: 'all-required' },
            },
          },
        },
      });

      const error = await runHarnessDriver(h.host, { ...input, profile }, h.deps);

      expect(error).toBeNull();
      const ledger = loadLedger(h.host.dataDir, h.host.runId);
      expect(ledger?.effectiveProfile).toBe(profile);
      if (profile === 'high-assurance') {
        expect(h.ops.map((operation) => operation.id)).toEqual(
          expect.arrayContaining(['packet-run', 'packet-gate']),
        );
        expect(ledger?.packets).toEqual([
          expect.objectContaining({ originalId: 'PK-01', state: 'gated' }),
        ]);
      }
    },
  );

  it('releases an interrupted packet lease and resumes with one bounded replacement attempt', async () => {
    const h = makeHarness(dir);
    h.setPacketRunBehavior((call) => (call === 1 ? 'implementing' : 'awaiting_validation'));
    h.deps.loadAgentic = async () => ({
      baseBranch: 'main',
      validationCommands: ['echo ok'],
      agentHarness: {
        models: {
          codex: {
            family: 'openai',
            model: 'gpt-5.6-sol',
            roles: ['worker', 'reviewer'],
            commands: { worker: ['codex', 'exec'], review: ['codex', 'exec'] },
          },
          deepseek: {
            family: 'deepseek',
            model: 'deepseek-v4-pro',
            roles: ['reviewer'],
            adapter: 'preset',
          },
        },
        profiles: {
          'high-assurance': {
            workers: ['codex'],
            reviewers: ['codex', 'deepseek'],
            reviewPolicy: { mode: 'all-required' },
          },
        },
      },
    });

    const first = await runHarnessDriver(
      h.host,
      { ...input, profile: 'high-assurance' },
      h.deps,
    );
    expect(first).toMatch(/packet PK-01 failed/i);
    const second = await runHarnessDriver(
      h.host,
      { ...input, profile: 'high-assurance' },
      h.deps,
    );

    expect(second).toBeNull();
    expect(h.ops.map((operation) => operation.id)).toEqual(
      expect.arrayContaining(['packet-release', 'packet-gate']),
    );
    const ledger = loadLedger(h.host.dataDir, h.host.runId);
    expect(ledger?.packets).toEqual([
      expect.objectContaining({
        originalId: 'PK-01',
        effectiveId: 'PK-01-resume-2',
        attempt: 2,
        state: 'gated',
      }),
    ]);
    expect(
      ledger?.invocations.find((invocation) => invocation.id === 'packet-release:PK-01:1'),
    ).toMatchObject({
      status: 'completed',
      artifactPath: expect.any(String),
      artifactSha256: expect.any(String),
    });
  });

  it('reconciles an awaiting-validation packet after a crash before worker completion persisted', async () => {
    const first = makeHarness(dir);
    first.deps.loadAgentic = async () => highAssuranceAgentic();
    expect(
      await runHarnessDriver(first.host, { ...input, profile: 'high-assurance' }, first.deps),
    ).toBeNull();
    const packetPath = join(
      harnessArtifactDir(first.host.dataDir, first.host.runId),
      'packet-runtime',
      'packets',
      'PK-01',
      'packet-result.json',
    );
    const packetState = JSON.parse(readFileSync(packetPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(packetPath, JSON.stringify({ ...packetState, state: 'awaiting_validation' }), 'utf8');
    const ledger = loadLedger(first.host.dataDir, first.host.runId)!;
    const worker = ledger.invocations.find(
      (invocation) => invocation.id === 'packet-run:PK-01:1',
    )!;
    worker.status = 'interrupted';
    worker.artifactPath = undefined;
    worker.artifactSha256 = undefined;
    ledger.invocations = ledger.invocations.filter(
      (invocation) => invocation.id !== 'packet-gate:PK-01:1',
    );
    saveLedger(first.host.dataDir, first.host.runId, ledger);

    const resumed = makeHarness(dir);
    resumed.deps.loadAgentic = async () => highAssuranceAgentic();
    expect(
      await runHarnessDriver(
        resumed.host,
        { ...input, profile: 'high-assurance' },
        resumed.deps,
      ),
    ).toBeNull();

    expect(resumed.ops.map((operation) => operation.id)).not.toContain('packet-run');
    expect(resumed.ops.map((operation) => operation.id)).toContain('packet-gate');
    expect(
      loadLedger(resumed.host.dataDir, resumed.host.runId)?.invocations.find(
        (invocation) => invocation.id === 'packet-run:PK-01:1',
      ),
    ).toMatchObject({ status: 'completed', artifactSha256: expect.any(String) });
  });

  it('reconciles a gated packet after a crash before gate completion persisted', async () => {
    const first = makeHarness(dir);
    first.deps.loadAgentic = async () => highAssuranceAgentic();
    expect(
      await runHarnessDriver(first.host, { ...input, profile: 'high-assurance' }, first.deps),
    ).toBeNull();
    const ledger = loadLedger(first.host.dataDir, first.host.runId)!;
    const gate = ledger.invocations.find(
      (invocation) => invocation.id === 'packet-gate:PK-01:1',
    )!;
    gate.status = 'interrupted';
    gate.artifactPath = undefined;
    gate.artifactSha256 = undefined;
    saveLedger(first.host.dataDir, first.host.runId, ledger);

    const resumed = makeHarness(dir);
    resumed.deps.loadAgentic = async () => highAssuranceAgentic();
    expect(
      await runHarnessDriver(
        resumed.host,
        { ...input, profile: 'high-assurance' },
        resumed.deps,
      ),
    ).toBeNull();

    expect(resumed.ops.map((operation) => operation.id)).not.toContain('packet-gate');
    expect(
      loadLedger(resumed.host.dataDir, resumed.host.runId)?.invocations.find(
        (invocation) => invocation.id === 'packet-gate:PK-01:1',
      ),
    ).toMatchObject({ status: 'completed', artifactSha256: expect.any(String) });
  });

  it('reconciles an aborted packet after a crash before release completion persisted', async () => {
    const first = makeHarness(dir);
    first.setPacketRunBehavior(() => 'implementing');
    first.deps.loadAgentic = async () => highAssuranceAgentic();
    expect(
      await runHarnessDriver(first.host, { ...input, profile: 'high-assurance' }, first.deps),
    ).toMatch(/packet PK-01 failed/i);
    const packetPath = join(
      harnessArtifactDir(first.host.dataDir, first.host.runId),
      'packet-runtime',
      'packets',
      'PK-01',
      'packet-result.json',
    );
    const packetState = JSON.parse(readFileSync(packetPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(packetPath, JSON.stringify({ ...packetState, state: 'aborted' }), 'utf8');
    const releaseReason =
      'cezar recovered an interrupted packet process and is starting one bounded replacement attempt';
    const releaseInputSha256 = createHash('sha256')
      .update(
        JSON.stringify({
          inputHashVersion: 2,
          operation: 'packet-release',
          packetId: 'PK-01',
          state: 'implementing',
          reason: releaseReason,
        }),
      )
      .digest('hex');
    const ledger = loadLedger(first.host.dataDir, first.host.runId)!;
    ledger.invocations.push({
      id: 'packet-release:PK-01:1',
      phaseId: 'packet-PK-01',
      role: 'recovery',
      binding: { runner: 'harness', model: 'packet-release' },
      status: 'interrupted',
      attempt: 1,
      inputSha256: releaseInputSha256,
    });
    saveLedger(first.host.dataDir, first.host.runId, ledger);

    const resumed = makeHarness(dir);
    resumed.deps.loadAgentic = async () => highAssuranceAgentic();
    expect(
      await runHarnessDriver(
        resumed.host,
        { ...input, profile: 'high-assurance' },
        resumed.deps,
      ),
    ).toBeNull();

    expect(resumed.ops.map((operation) => operation.id)).not.toContain('packet-release');
    expect(
      loadLedger(resumed.host.dataDir, resumed.host.runId)?.packets[0],
    ).toMatchObject({ effectiveId: 'PK-01-resume-2', state: 'gated' });
    expect(
      loadLedger(resumed.host.dataDir, resumed.host.runId)?.invocations.find(
        (invocation) => invocation.id === 'packet-release:PK-01:1',
      ),
    ).toMatchObject({ status: 'completed', artifactSha256: expect.any(String) });
  });

  it('rejects parent/child path overlap across high-assurance packets before a worker runs', async () => {
    const h = makeHarness(dir);
    h.agentBehavior.set('packet-plan', (req) => {
      const packet = (id: string, path: string) => ({
        version: 1,
        id,
        title: id,
        objective: 'bounded work',
        risk: 'medium',
        allowedPaths: [path],
        invariants: ['preserve behavior'],
        acceptanceCriteria: ['validation passes'],
        dependencies: [],
        nonGoals: [],
        referencePatterns: [],
      });
      writeFileSync(
        req.resultPath,
        JSON.stringify({
          summary: 'overlapping plan',
          packets: [packet('PK-01', 'src/orders'), packet('PK-02', 'src/orders/api.ts')],
        }),
        'utf8',
      );
      return null;
    });
    h.deps.loadAgentic = async () => ({
      baseBranch: 'main',
      validationCommands: ['echo ok'],
      agentHarness: {
        models: {
          codex: {
            family: 'openai',
            model: 'gpt-5.6-sol',
            roles: ['worker', 'reviewer'],
            commands: { worker: ['codex', 'exec'], review: ['codex', 'exec'] },
          },
          deepseek: { family: 'deepseek', model: 'deepseek-v4-pro', roles: ['reviewer'] },
        },
        profiles: {
          'high-assurance': {
            workers: ['codex'],
            reviewers: ['codex', 'deepseek'],
            reviewPolicy: { mode: 'all-required' },
          },
        },
      },
    });

    const error = await runHarnessDriver(h.host, { ...input, profile: 'high-assurance' }, h.deps);

    expect(error).toContain('packet plans overlap on paths src/orders and src/orders/api.ts');
    expect(h.ops.map((operation) => operation.id)).not.toContain('packet-run');
  });

  it('topologically orders a valid high-assurance packet plan before dispatch', async () => {
    const h = makeHarness(dir);
    const packet = (id: string, path: string, dependencies: string[]) => ({
      version: 1,
      id,
      title: id,
      objective: 'bounded work',
      risk: 'medium',
      allowedPaths: [path],
      invariants: ['preserve behavior'],
      acceptanceCriteria: ['validation passes'],
      dependencies,
      nonGoals: [],
      referencePatterns: [],
    });
    h.agentBehavior.set('packet-plan', (req) => {
      writeFileSync(
        req.resultPath,
        JSON.stringify({
          summary: 'valid plan emitted in reverse dependency order',
          packets: [
            packet('PK-02', 'src/two.ts', ['PK-01']),
            packet('PK-01', 'src/one.ts', []),
          ],
        }),
        'utf8',
      );
      return null;
    });
    h.deps.loadAgentic = async () => highAssuranceAgentic();

    expect(
      await runHarnessDriver(h.host, { ...input, profile: 'high-assurance' }, h.deps),
    ).toBeNull();

    const packetIds = h.ops
      .filter((operation) => operation.id === 'packet-run')
      .map((operation) => {
        const args = operation.args!;
        const manifest = JSON.parse(
          readFileSync(args[args.indexOf('--manifest') + 1]!, 'utf8'),
        ) as { id: string };
        return manifest.id;
      });
    expect(packetIds).toEqual(['PK-01', 'PK-02']);
  });

  it('rejects cyclic high-assurance packet dependencies and persists a blocked outcome', async () => {
    const h = makeHarness(dir);
    const packet = (id: string, path: string, dependencies: string[]) => ({
      version: 1,
      id,
      title: id,
      objective: 'bounded work',
      risk: 'medium',
      allowedPaths: [path],
      invariants: ['preserve behavior'],
      acceptanceCriteria: ['validation passes'],
      dependencies,
      nonGoals: [],
      referencePatterns: [],
    });
    h.agentBehavior.set('packet-plan', (req) => {
      writeFileSync(
        req.resultPath,
        JSON.stringify({
          summary: 'cyclic plan',
          packets: [
            packet('PK-01', 'src/one.ts', ['PK-02']),
            packet('PK-02', 'src/two.ts', ['PK-01']),
          ],
        }),
        'utf8',
      );
      return null;
    });
    h.deps.loadAgentic = async () => highAssuranceAgentic();

    const error = await runHarnessDriver(
      h.host,
      { ...input, profile: 'high-assurance' },
      h.deps,
    );

    expect(error).toMatch(/dependency graph contains a cycle/i);
    expect(h.ops.map((operation) => operation.id)).not.toContain('packet-run');
    expect(loadLedger(h.host.dataDir, h.host.runId)?.outcome).toMatchObject({
      status: 'blocked',
      blockingReasons: [expect.stringMatching(/cycle/i)],
    });
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

  it('reruns legacy v1 model phases instead of blessing old approvals with current hashes', async () => {
    const first = makeHarness(dir);
    expect(await runHarnessDriver(first.host, input, first.deps)).toBeNull();
    const path = join(first.host.dataDir, 'runs', `${first.host.runId}.harness.json`);
    const current = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const {
      invocations: _invocations,
      pendingMessages: _pendingMessages,
      outcome: _outcome,
      ...legacy
    } = current;
    writeFileSync(path, JSON.stringify({ ...legacy, version: 1 }), 'utf8');

    const resumed = makeHarness(dir);
    resumed.deps.snapshotReviewSubject = async () => 'changed-review-subject';
    expect(await runHarnessDriver(resumed.host, input, resumed.deps)).toBeNull();

    expect(resumed.calls.map((call) => call.id)).toContain('review');
    expect(
      loadLedger(resumed.host.dataDir, resumed.host.runId)?.invocations.find(
        (invocation) => invocation.phaseId === 'review',
      ),
    ).toMatchObject({ status: 'completed', inputSha256: expect.any(String) });
  });

  it('retries a changed completed artifact and invalidates every downstream gate', async () => {
    const first = makeHarness(dir);
    expect(await runHarnessDriver(first.host, input, first.deps)).toBeNull();

    const qualifyPath = join(
      harnessArtifactDir(first.host.dataDir, first.host.runId),
      'phase-qualify-result.json',
    );
    writeFileSync(
      qualifyPath,
      JSON.stringify({ outcome: 'work_needed', evidence: 'tampered after completion' }),
      'utf8',
    );

    const resumed = makeHarness(dir);
    expect(await runHarnessDriver(resumed.host, input, resumed.deps)).toBeNull();

    expect(resumed.calls.map((call) => call.id)).toContain('qualify');
    // The upstream decision reran, but the hash-bound staged subject itself
    // remained identical, so the deterministic stage invocation is reusable.
    expect(resumed.calls.map((call) => call.id)).not.toContain('stage');
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

  it('reruns code review when the materialized review rubric changes', async () => {
    const rubricDir = join(dir, '.claude', 'skills', 'cez-code-review');
    mkdirSync(rubricDir, { recursive: true });
    writeFileSync(join(rubricDir, 'SKILL.md'), '# Review rubric v1\n', 'utf8');
    const first = makeHarness(dir);
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

    writeFileSync(join(rubricDir, 'SKILL.md'), '# Review rubric v2\n', 'utf8');
    const resumed = makeHarness(dir);
    expect(await runHarnessDriver(resumed.host, input, resumed.deps)).toBeNull();

    expect(resumed.calls.map((call) => call.id)).toContain('review');
    expect(
      loadLedger(resumed.host.dataDir, resumed.host.runId)?.invocations.find(
        (invocation) => invocation.phaseId === 'review',
      ),
    ).toMatchObject({ attempt: 1, status: 'completed' });
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
  });

  it('persists a runner PID and ownership token before awaiting paid agent work', async () => {
    const h = makeHarness(dir);
    let observedProcess: unknown;
    h.agentBehavior.set('qualify', (req) => {
      expect(req.env.CEZ_PROCESS_TOKEN).toMatch(/^[0-9a-f-]{36}$/);
      req.onSpawn?.(4242, true);
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
      group: true,
    });
    expect(
      loadLedger(h.host.dataDir, h.host.runId)?.invocations.find(
        (invocation) => invocation.id === 'agent:qualify:claude',
      )?.process,
    ).toBeUndefined();
  });

  it('fails closed when a recorded PID no longer has the invocation identity', async () => {
    const h = makeHarness(dir);
    const ledger = createLedger({
      workflow: HARNESS_FIX_ISSUE,
      requestedProfile: 'standard',
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
    saveLedger(h.host.dataDir, h.host.runId, ledger);
    h.deps.reconcileProcess = async () => ({
      status: 'mismatch',
      error: 'pid 4242 no longer belongs to this harness invocation',
    });

    const error = await runHarnessDriver(h.host, input, h.deps);

    expect(error).toMatch(/recovery blocked.*pid 4242/i);
    expect(h.calls).toHaveLength(0);
    expect(loadLedger(h.host.dataDir, h.host.runId)?.outcome).toMatchObject({
      status: 'blocked',
    });
  });

  it('delivers a durable boundary message to the next agent phase and records consumption', async () => {
    const h = makeHarness(dir);
    const ledger = createLedger({
      workflow: HARNESS_FIX_ISSUE,
      requestedProfile: 'standard',
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
        profiles: {
          multi: {
            workers: [],
            reviewers: ['codex', 'deepseek'],
            reviewPolicy: { mode: 'all-required' },
          },
        },
      },
    });
    h.deps.validate = async (commands) => {
      const external = loadLedger(h.host.dataDir, h.host.runId)!;
      if (!external.pendingMessages.some((message) => message.id === 'during-validation')) {
        external.pendingMessages.push({
          id: 'during-validation',
          text: 'Confirm the compatibility alias in council.',
          createdAt: '2026-07-26T10:03:00.000Z',
        });
        saveLedger(h.host.dataDir, h.host.runId, external);
      }
      return commands.map((command) => ({
        command,
        status: 'passed' as const,
        exitCode: 0,
        evidence: 'ok',
      }));
    };

    expect(
      await runHarnessDriver(h.host, { ...input, profile: 'multi' }, h.deps),
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
    issueId: '642',
    roles,
  };

  const phaseDefaults: Record<string, unknown> = {
    qualify: { outcome: 'work_needed', evidence: 'bug reproduced on main' },
    diagnose: { summary: 'race', files: ['src/a.ts'], regressionTest: 't' },
    implement: { changedPaths: ['src/a.ts'], suggestedCommit: 'fix: x' },
  };

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
    // The codex reviewer is a structured call, NOT an agent session.
    expect(h.calls.filter((c) => c.kind === 'agent' && c.id === 'review')).toHaveLength(1);
    expect(h.ops.some((o) => o.id === 'review')).toBe(true);
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
    // The parts are carried separately so no surface has to re-split `id`
    // (which is `runner/model` and doubles up for gateway-qualified ids).
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
        { runner: 'opencode' as const, model: 'opencode/mimo-v2.5-free' },
      ],
    },
  };

  /**
   * Regression: a run spent 5.3M tokens and $12, two reviewers had completed,
   * and the whole thing was discarded because a third produced nothing.
   */
  it('fails closed when one selected council reviewer does not complete', async () => {
    const h = makeHarness(dir);
    h.setCouncilBehavior((ids) => ({
      ok: true,
      result: {
        verdict: 'approve',
        reviewers: ids.map((id) => ({
          id,
          status: id.includes('mimo') ? 'failed' : 'completed',
          ...(id.includes('mimo') ? {} : { review: { verdict: 'approve', findings: [] } }),
        })),
      },
    }));

    const error = await runHarnessDriver(h.host, threeReviewerInput, h.deps);

    expect(error).toMatch(/required reviewers/i);
    expect(h.calls.map((c) => c.id)).not.toContain('stage');
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
            status: councilCalls.length === 1 && id.includes('mimo') ? 'failed' : 'completed',
            ...(councilCalls.length === 1 && id.includes('mimo')
              ? {}
              : { review: { verdict: 'approve', findings: [] } }),
          })),
        },
      };
    });

    const first = await runHarnessDriver(h.host, threeReviewerInput, h.deps);
    expect(first).toMatch(/required reviewers/i);
    const second = await runHarnessDriver(h.host, threeReviewerInput, h.deps);

    expect(second).toBeNull();
    expect(councilCalls).toHaveLength(2);
    expect(councilCalls[0]).toEqual(
      expect.arrayContaining(['cez-codex-gpt-5.6-sol', 'cez-opencode-mimo-v2.5-free']),
    );
    expect(councilCalls[1]).toHaveLength(1);
    expect(councilCalls[1]?.[0]).toContain('mimo');
    expect(h.calls.filter((call) => call.kind === 'agent' && call.id === 'review')).toHaveLength(1);
    const ledger = loadLedger(h.host.dataDir, h.host.runId);
    expect(
      ledger?.invocations.filter(
        (invocation) =>
          invocation.status === 'completed' && invocation.role === 'reviewer',
      ),
    ).toHaveLength(3);
  });

  it('recovers a valid council result rejected by a shared subject-change false positive', async () => {
    const h = makeHarness(dir);
    let subject = 'stable-review-subject';
    let councilCalls = 0;
    h.deps.snapshotReviewSubject = async () => subject;
    h.setCouncilBehavior((ids) => {
      councilCalls += 1;
      subject = 'changed-during-council';
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
    expect(councilCalls).toBe(1);

    // Existing production ledgers contain the pre-fix wording. Recovery must
    // remain compatible with them so clicking Continue can adopt the result
    // that was already paid for.
    const failedLedger = loadLedger(h.host.dataDir, h.host.runId)!;
    for (const invocation of failedLedger.invocations) {
      if (invocation.id.startsWith('advisor:impl:')) {
        invocation.error =
          'advisor reviewer mutated the worktree or index; every result from this council was rejected and the changed subject was preserved for manual recovery';
      }
    }
    saveLedger(h.host.dataDir, h.host.runId, failedLedger);

    subject = 'stable-review-subject';
    h.setCouncilBehavior(() => {
      throw new Error('the recovered council must not invoke reviewers again');
    });

    await expect(runHarnessDriver(h.host, threeReviewerInput, h.deps)).resolves.toBeNull();

    expect(councilCalls).toBe(1);
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
    // Both structured reviewers fail; only the claude session remains.
    h.setCouncilBehavior((ids) => ({
      ok: true,
      result: { verdict: 'approve', reviewers: ids.map((id) => ({ id, status: 'failed' })) },
    }));

    const error = await runHarnessDriver(h.host, threeReviewerInput, h.deps);

    expect(error).toMatch(/quorum/);
    expect(error).toMatch(/required reviewers/);
    expect(h.calls.map((c) => c.id)).not.toContain('stage');
  });

  it('keeps the completed reviewers when the council op itself fails', async () => {
    const h = makeHarness(dir);
    h.setCouncilBehavior(() => ({ ok: false, stderr: 'runtime exploded' }));

    const error = await runHarnessDriver(h.host, threeReviewerInput, h.deps);

    // The claude session still reviewed; quorum reports what was missing.
    expect(error).toMatch(/quorum/);
    expect(error).toMatch(/runtime exploded|no valid review/);
  });

  /**
   * Regression: three rounds of genuine spec revision were discarded because
   * one reviewer raised three fresh majors every round and would never sign
   * off. Delivery is stage-only — the human is the final gate — so a
   * non-converging council must hand over the work, not delete it.
   */
  it('stages the work when the council will not converge, naming what is unresolved', async () => {
    const h = makeHarness(dir);
    // Every round: one reviewer approves, the other raises a fresh major.
    let round = 0;
    h.setCouncilBehavior((ids) => {
      round += 1;
      // Rounds 1–3 are the spec council refusing to converge; anything after is
      // the implementation review, which approves so the run reaches staging.
      const stillObjecting = round <= 3;
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

    const error = await runHarnessDriver(
      h.host,
      { ...input, workflow: HARNESS_IMPLEMENT_FEATURE, roles },
      h.deps,
    );

    // The run delivers rather than evaporating.
    expect(error).toBeNull();
    expect(h.calls.map((c) => c.id)).toContain('stage');
    const notes = h.events.filter((e) => e.type === 'note').map((e) => String(e.message));
    expect(notes.some((n) => n.includes('did not converge') && n.includes('UNRESOLVED'))).toBe(true);
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
      // Reports a plausible repo-relative path — but wrote it to the checkout.
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
    // Nothing was reviewed: the council never ran, so no round was wasted.
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

  /* ---- readiness probing (2026-07-25) ---- */

  /**
   * Regression: a council once ran to completion-minus-one with a reviewer
   * whose transport 500'd on every prompt, because preflight hardcoded
   * `readiness: 'ready'`. The run died an hour later as "reviewer X produced no
   * valid review", pointing at the model instead of the dead transport.
   */
  it('fails preflight with the upstream error when a bound model is unreachable', async () => {
    const h = makeHarness(dir);
    h.probeVerdicts.set('opencode/opencode/mimo-v2.5-free', {
      status: 'failed',
      detail: 'POST /session/:id/message → 500 no such column: replacement_seq',
    });
    const unreachable = {
      ...input,
      roles: {
        ...roles,
        reviewers: [
          { runner: 'claude' as const, model: 'opus' },
          { runner: 'opencode' as const, model: 'opencode/mimo-v2.5-free' },
        ],
      },
    };

    const error = await runHarnessDriver(h.host, unreachable, h.deps);

    expect(error).toContain('opencode/opencode/mimo-v2.5-free');
    // The operator gets the cause, not a downstream symptom.
    expect(error).toContain('replacement_seq');
    // It stops BEFORE any model work — no qualify, no council, no staging.
    expect(h.calls.map((c) => c.id)).not.toContain('qualify');
    expect(h.calls.map((c) => c.id)).not.toContain('stage');
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

  /* ---- advisor reviewers (spec 2026-07-24-advisor-reviewers) ---- */

  const advisorRoles = {
    ...roles,
    reviewers: [
      { runner: 'claude' as const, model: 'opus' },
      { runner: 'harness' as const, model: 'kimi', family: 'moonshot' },
    ],
  };
  const advisorInput = { ...input, roles: advisorRoles };

  /** Bind kimi in the worktree config (the council's config source) and in the
   *  loaded agentic view (the preflight's check). */
  function bindKimi(h: ReturnType<typeof makeHarness>) {
    const agentHarness = {
      models: { kimi: { roles: ['reviewer'], family: 'moonshot', timeoutMs: 120_000 } },
      profiles: {},
    };
    mkdirSync(join(dir, '.ai'), { recursive: true });
    writeFileSync(join(dir, '.ai', 'agentic.config.json'), JSON.stringify({ agentHarness }), 'utf8');
    h.deps.loadAgentic = async () => ({ baseBranch: 'main', validationCommands: ['echo ok'], agentHarness });
  }

  /** Swap the fake runtime for one whose `review` op is scripted per round. */
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
          if (output) {
            writeFileSync(output, JSON.stringify({ status: 'ready', stagedPaths: [] }), 'utf8');
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

  it('recovers the legacy-rejected spec council only when its contract still names the current spec', async () => {
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
      if (councilCalls === 1) subject = 'changed-during-spec-council';
      return {
        ok: true,
        result: {
          verdict: 'approve',
          ...(councilCalls === 1
            ? {
                reviewContract: {
                  subjectSha256: createHash('sha256').update('# feat\n').digest('hex'),
                },
              }
            : {}),
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

    await expect(runHarnessDriver(h.host, featureInput, h.deps)).resolves.toMatch(
      /review subject changed/i,
    );
    const failedLedger = loadLedger(h.host.dataDir, h.host.runId)!;
    const failedAdvisor = failedLedger.invocations.find((invocation) =>
      invocation.id.startsWith('advisor:spec:1:'),
    )!;
    failedAdvisor.error =
      'advisor reviewer mutated the worktree or index; every result from this council was rejected and the changed subject was preserved for manual recovery';
    saveLedger(h.host.dataDir, h.host.runId, failedLedger);

    subject = 'stable-review-subject';
    await expect(runHarnessDriver(h.host, featureInput, h.deps)).resolves.toBeNull();

    // One paid spec council before the false rejection, then only the later
    // implementation council. A spec rerun would make this three.
    expect(councilCalls).toBe(2);
    expect(
      loadLedger(h.host.dataDir, h.host.runId)?.invocations.find((invocation) =>
        invocation.id.startsWith('advisor:spec:1:'),
      ),
    ).toMatchObject({ status: 'completed', artifactSha256: expect.any(String) });
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

    // The council's verdict must reach the fix loop, not be thrown away.
    expect(error).not.toMatch(/no structured result/);
    // …and the object collapses to the readable form the brief interpolates,
    // never "[object Object]".
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
    // The synthesized config holds EXACTLY the selected advisors, all-required.
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

  it('feature runs hold a spec council (≤3 rounds) before implementation — parity with the upstream multi wrapper', async () => {
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

    for (const o of h.ops) if (o.id === 'review') reviewArgs.push(o.args ?? []);
    expect(reviewArgs).toHaveLength(3); // spec ×2 rounds + implementation ×1
    // The spec council reviews the SPEC FILE, not the diff.
    expect(reviewArgs[0]).toContain('--artifact');
    expect(reviewArgs[0]![reviewArgs[0]!.indexOf('--artifact') + 1]).toContain('.ai/specs/feat.md');
    expect(reviewArgs[2]).not.toContain('--artifact');
    // Revision ran between the rounds, before implement.
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

  it('preflights an unbound advisor to a clean setup hint, before any op runs', async () => {
    const h = makeHarness(dir); // default loadAgentic: no agentHarness at all
    const error = await runHarnessDriver(h.host, advisorInput, h.deps);
    expect(error).toMatch(/advisor reviewer "kimi" is not bound/);
    expect(h.calls.map((c) => c.id)).not.toContain('capture');
  });

  it('falls back to the repo working tree config when the base carries no agentHarness (staged setup)', async () => {
    // The exact post-setup window: cez-setup-harness staged the config in the
    // repo root, nothing committed — a worktree forked from the base sees no
    // agentHarness, but the run must still find the user's staged bindings.
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

      // The council's synthesized profile was built from the immutable
      // artifact COPY of the staged config, not the live file.
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
