import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadLedger, saveLedger, createLedger, startPhase, finishPhase } from './ledger.js';
import { HARNESS_FIX_ISSUE, HARNESS_IMPLEMENT_FEATURE } from './workflows.js';
import {
  harnessArtifactDir,
  runHarnessDriver,
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

  const deps: HarnessDriverDeps = {
    resolveScript: () => join(dir, 'harness.mjs'),
    createRuntime: () => ({
      run: async (op: string, args: string[]) => {
        ops.push({ kind: 'op', id: op, args });
        calls.push({ kind: 'op', id: op, args });
        if (op === 'capture') {
          writeFileSync(join(harnessArtifactDir(host.dataDir, host.runId), 'start-state.json'), '{"refs":{}}', 'utf8');
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

  return { host, deps, calls, ops, events, steps, agentBehavior, probeVerdicts, setCouncilBehavior };
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
      writeFileSync(req.resultPath, JSON.stringify({ changedPaths: ['src/runs/store.ts'] }), 'utf8');
      return null;
    });
    const error = await runHarnessDriver(h.host, input, h.deps);
    expect(error).toBeNull();
    const order = h.calls.map((c) => c.id);
    expect(order.filter((id) => id.startsWith('review'))).toHaveLength(2);
    expect(order).toContain('fix-2');
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

  it('rejects a non-standard profile with a reroute message instead of degrading', async () => {
    const h = makeHarness(dir);
    const error = await runHarnessDriver(h.host, { ...input, profile: 'multi' }, h.deps);
    expect(error).toMatch(/multi/);
    expect(error).toMatch(/standard/);
    expect(h.calls).toHaveLength(0);
  });

  it('resumes from an existing ledger, skipping completed phases', async () => {
    const h = makeHarness(dir);
    // Simulate a prior interrupted run: qualify and diagnose already done,
    // their artifacts on disk.
    const artifactDir = harnessArtifactDir(h.host.dataDir, h.host.runId);
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, 'phase-qualify-result.json'), JSON.stringify({ outcome: 'work_needed', evidence: 'e' }), 'utf8');
    writeFileSync(
      join(artifactDir, 'phase-diagnose-result.json'),
      JSON.stringify({ summary: 's', files: ['src/a.ts'] }),
      'utf8',
    );
    writeFileSync(join(artifactDir, 'start-state.json'), '{"refs":{}}', 'utf8');
    const ledger = createLedger({ workflow: HARNESS_FIX_ISSUE, requestedProfile: 'standard', subject: { kind: 'issue', id: '642', text: input.task } });
    startPhase(ledger, { id: 'preflight', name: 'Preflight', kind: 'op' });
    finishPhase(ledger, 'preflight', 'done');
    startPhase(ledger, { id: 'capture', name: 'Capture', kind: 'op' });
    finishPhase(ledger, 'capture', 'done');
    startPhase(ledger, { id: 'qualify', name: 'Qualify', kind: 'agent' });
    finishPhase(ledger, 'qualify', 'done');
    startPhase(ledger, { id: 'diagnose', name: 'Diagnose', kind: 'agent' });
    finishPhase(ledger, 'diagnose', 'done');
    startPhase(ledger, { id: 'implement', name: 'Implement', kind: 'agent' });
    saveLedger(h.host.dataDir, h.host.runId, ledger);

    const error = await runHarnessDriver(h.host, input, h.deps);
    expect(error).toBeNull();
    const order = h.calls.map((c) => c.id);
    // capture/qualify/diagnose are not re-run; implement restarts fresh.
    expect(order).not.toContain('capture');
    expect(order).not.toContain('qualify');
    expect(order).not.toContain('diagnose');
    expect(order).toContain('implement');
    expect(order[order.length - 1]).toBe('stage');
    const resumed = loadLedger(h.host.dataDir, h.host.runId);
    expect(resumed?.phases.find((p) => p.id === 'implement')?.attempts).toBe(2);
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
  it('completes DEGRADED when one council reviewer fails — the run is not thrown away', async () => {
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

    expect(error).toBeNull();
    expect(h.calls.map((c) => c.id)).toContain('stage');
    const notes = h.events.filter((e) => e.type === 'note').map((e) => String(e.message));
    expect(notes.some((n) => n.includes('DEGRADED') && n.includes('mimo'))).toBe(true);
  });

  it('refuses when too few reviewers survive — quorum, not "anything goes"', async () => {
    const h = makeHarness(dir);
    // Both structured reviewers fail; only the claude session remains.
    h.setCouncilBehavior((ids) => ({
      ok: true,
      result: { verdict: 'approve', reviewers: ids.map((id) => ({ id, status: 'failed' })) },
    }));

    const error = await runHarnessDriver(h.host, threeReviewerInput, h.deps);

    expect(error).toMatch(/quorum/);
    expect(error).toMatch(/at least 2/);
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
