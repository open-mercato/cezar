import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { createLedger, finishPhase, loadLedger, saveLedger, startPhase } from './ledger.js';
import {
  HarnessRuntime,
  exportTrustedConfig,
  loadAgenticConfig,
  resolveHarnessScript,
  runValidationCommands,
  type AgenticConfig,
  type HarnessOpResult,
} from './runtime.js';
import { excludeFromGit } from '../skills-remote.js';
import { HARNESS_FIX_ISSUE, HARNESS_IMPLEMENT_FEATURE } from './workflows.js';
import { createModelProber, type ModelProber, type ProbeCacheEntry } from './probe.js';
import { synthesizeReviewerBinding } from './reviewer-binding.js';
import {
  MAX_PARALLEL_REVIEWERS,
  councilQuorum,
  isRetryableReviewerFailure,
  pool,
  type CouncilOutcome,
} from './council-quorum.js';
import { createLiveTransport } from './probe-transports.js';
import type { HarnessLedger, HarnessProfile, HarnessValidationCheck } from './types.js';

/**
 * The harness phase driver (spec 2026-07-23-harness-orchestration): cezar's
 * conductor for the cez-harness staged-only pipeline.
 *
 * Ownership is the whole design:
 *  - THIS module owns control flow — phase order, the bounded fix loop, the
 *    one automatic retry after a malformed phase result, resume-from-ledger,
 *    cancellation checks between phases;
 *  - the vendored cez-* skills own judgment — every agent phase is a FRESH
 *    session (the host never passes a resumed transcript) whose brief is
 *    assembled from on-disk artifacts;
 *  - the installed `harness.mjs` owns mechanics — capture and stage run
 *    verbatim, and their JSON artifacts stay authoritative.
 *
 * No LLM context outlives its phase: the "thread" a 12-hour desktop
 * conversation used to carry lives in the ledger and the artifact directory.
 */

/* ------------------------------------------------------------------ */
/* Host + dependency seams                                             */
/* ------------------------------------------------------------------ */

export interface HarnessAgentPhaseRequest {
  phaseId: string;
  name: string;
  /** The cez-* skill this phase executes; undefined runs the plain prompt. */
  skill: string | undefined;
  prompt: string;
  /** Where the phase MUST write its structured result JSON. */
  resultPath: string;
  timeoutMs: number;
  /** Extra env for the session (`CEZ_HARNESS_*`). */
  env: Record<string, string>;
  /** Role-based model routing (2026-07-24): the backend + model this phase
   *  runs on. Absent → the run's default (claude). */
  runner?: 'claude' | 'codex' | 'opencode';
  model?: string;
  /** Reasoning effort for the phase's session — the role's own dial. */
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** This phase runs BESIDE its siblings (council reviewers fan out in
   *  parallel, 2026-07-25) — the host must not let it claim the run's singular
   *  session slots, or the last one started would be the only one a Stop could
   *  reach. */
  concurrent?: boolean;
}

/** One concrete model a role runs on ('' = the backend's default model).
 *  `effort` is the role's reasoning dial (2026-07-24), mapped per backend on
 *  the runner seam; absent = the backend's default. */
export interface HarnessRoleRef {
  runner: 'claude' | 'codex' | 'opencode';
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
}

/** A reviewer bound in `agentHarness.models` (kimi-subscription, deepseek-api,
 *  a Zen preset…) — executed through the vendored runtime's review council,
 *  not a runner session (spec 2026-07-24-advisor-reviewers). `model` is the
 *  advisor id in the config; `family` is its provider family (the diversity
 *  axis), declared by the picker from `/harness/status`. */
export interface HarnessAdvisorRef {
  runner: 'harness';
  model: string;
  family: string;
}

export type HarnessReviewerRef = HarnessRoleRef | HarnessAdvisorRef;

export function isAdvisorRef(ref: HarnessReviewerRef): ref is HarnessAdvisorRef {
  return ref.runner === 'harness';
}

/** The role-based selection (user feedback 2026-07-24): one orchestrator
 *  (qualify/diagnose/spec — the judgment phases), one implementer
 *  (implement/fix), and 2–5 unique reviewers who each get their own fresh
 *  review pass — runner sessions, or configured harness advisors run as one
 *  council op. Maps 1:1 onto the om config's own structure, where a profile
 *  is just a named `workers[]`/`reviewers[]` preset. */
export interface HarnessRolesInput {
  orchestrator: HarnessRoleRef;
  implementer: HarnessRoleRef;
  reviewers: HarnessReviewerRef[];
}

/** The narrow slice of RunManager the driver needs — injected so the driver
 *  is testable without a manager, a store, or a live backend. */
export interface HarnessDriverHost {
  runId: string;
  /** The isolated worktree every phase executes in. */
  cwd: string;
  dataDir: string;
  repoRoot: string;
  isCancelled(): boolean;
  emit(event: { type: string; stepId?: string; [k: string]: unknown }): void;
  /** Run one agent phase in a fresh session; returns an error or null —
   *  `runAgentStep` semantics. */
  runAgent(req: HarnessAgentPhaseRequest): Promise<string | null>;
  /** Ensure a step exists on the run record (dynamic fix/review rounds). */
  upsertStep(step: { id: string; name: string; kind: 'agent' | 'check' }): void;
  setStepStatus(
    stepId: string,
    status: 'pending' | 'running' | 'done' | 'failed' | 'skipped',
    error?: string,
  ): void;
  /** Chain an interrupt hook into the run's cancel path; returns unregister. */
  onInterrupt(fn: () => void): () => void;
  /** Ensure a cez-* skill is discoverable and its directory (plus the
   *  `requires:` closure) is materialized into the worktree — any source:
   *  bundled vendor set, global install, or team repo. */
  ensureSkill(name: string): Promise<boolean>;
}

interface RuntimeLike {
  run(op: string, args: string[], opts?: { timeoutMs?: number }): Promise<HarnessOpResult>;
  kill(): void;
}

/** Injectable seams (tests swap these; production uses the real modules). */
export interface HarnessDriverDeps {
  resolveScript?: (cwd: string) => string | null;
  createRuntime?: (opts: { script: string; cwd: string }) => RuntimeLike;
  loadAgentic?: (cwd: string) => Promise<AgenticConfig>;
  validate?: (commands: string[], cwd: string) => Promise<HarnessValidationCheck[]>;
  exportConfig?: typeof exportTrustedConfig;
  /** Readiness prober. Injected in tests so preflight never spawns a CLI or
   *  reaches the network; defaults to live round-trips on the real transports. */
  createProber?: (opts: { advisors: Record<string, unknown>; cwd: string }) => ModelProber;
}

/** Process-wide readiness cache: the driver builds a prober per run, but a
 *  verdict is a property of the host's transports, not of one run. Sharing it
 *  is what makes "probe every run" affordable. */
const PROBE_CACHE = new Map<string, ProbeCacheEntry>();

export interface HarnessDriverInput {
  workflow: string;
  task: string;
  profile: HarnessProfile;
  issueId?: string;
  /** Role-based conduction (2026-07-24). Present → the driver runs every
   *  phase on its role's model and one fresh review pass per reviewer;
   *  absent → the legacy claude-only `standard` graph. */
  roles?: HarnessRolesInput;
}

/** Display id of a role ref — `claude/sonnet`, `codex/auto`. */
export function roleRefId(ref: HarnessReviewerRef): string {
  return `${ref.runner}/${ref.model || 'auto'}`;
}

/** The independence axis a council quorum counts. Advisors declare their
 *  provider family; a runner ref is identified by its backend, which is a
 *  deliberate under-count (two opencode-gateway models from different
 *  providers read as one family) — erring toward refusing a degraded round
 *  rather than waving one through. */
export function councilFamilyOf(ref: HarnessReviewerRef): string {
  return isAdvisorRef(ref) ? ref.family : ref.runner;
}

/* ------------------------------------------------------------------ */
/* Phase result contracts                                              */
/* ------------------------------------------------------------------ */

const qualifyResultSchema = z.object({
  outcome: z.enum(['work_needed', 'no_action']),
  evidence: z.string(),
});

const diagnoseResultSchema = z.object({
  summary: z.string(),
  files: z.array(z.string()),
  regressionTest: z.string().optional(),
});

const specResultSchema = z.object({
  summary: z.string(),
  specPath: z.string().optional(),
  files: z.array(z.string()).optional(),
});

const implementResultSchema = z.object({
  changedPaths: z.array(z.string().min(1)).min(1),
  summary: z.string().optional(),
  suggestedCommit: z.string().optional(),
});

/**
 * A finding's location arrives in TWO shapes because two different producers
 * fill this schema (2026-07-25, live failure):
 *
 *  - runner reviewers answer this driver's own prompt, which asks for
 *    `"location": "path:line"` — a string;
 *  - the advisor council emits the vendored runtime's published contract,
 *    `cez-harness/references/review-result.schema.json`, where location is
 *    `{ path, line, symbol }` — an object, with line/symbol nullable.
 *
 * Declaring it string-only made every advisor finding that carried a location
 * fail the parse, and the driver reported the whole completed council as
 * "no structured result". Accept both and normalise to the readable form the
 * fix brief interpolates, so it can never render as "[object Object]".
 */
const findingLocationSchema = z
  .union([
    z.string(),
    z
      .object({
        path: z.string(),
        line: z.number().int().nullable().optional(),
        symbol: z.string().nullable().optional(),
      })
      .passthrough(),
  ])
  .transform((loc) => {
    if (typeof loc === 'string') return loc;
    const base = loc.line == null ? loc.path : `${loc.path}:${loc.line}`;
    return loc.symbol ? `${base} (${loc.symbol})` : base;
  });

const reviewResultSchema = z.object({
  verdict: z.enum(['approve', 'request_changes']),
  findings: z
    .array(
      z.object({
        severity: z.enum(['blocker', 'major', 'minor', 'nit']),
        title: z.string(),
        location: findingLocationSchema.optional(),
        evidence: z.string().optional(),
      }),
    )
    .default([]),
});

type ReviewResult = z.infer<typeof reviewResultSchema>;

/** The runtime's `review-result.json`, reduced to what the driver folds into
 *  the council: per-advisor status plus the session-shaped review payload
 *  (spec 2026-07-24-advisor-reviewers). Loose on purpose — the runtime's own
 *  schema is authoritative; unknown keys pass through untouched. */
const councilResultSchema = z
  .object({
    verdict: z.enum(['approve', 'request_changes']).nullable().optional(),
    reviewers: z
      .array(
        z
          .object({
            id: z.string(),
            status: z.string(),
            review: reviewResultSchema.optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

/* ------------------------------------------------------------------ */
/* Phase timeouts (spec: implement gets hours, qualify minutes)        */
/* ------------------------------------------------------------------ */

/** Appended to every agent-phase prompt (2026-07-24, live failure): a spec
 *  phase dispatched a background subagent and ended its turn to await it —
 *  correct in the model's home harness, fatal in a phase session, where the
 *  turn boundary used to close the CLI and kill the subagent. The session
 *  layer now nudges instead of closing, but the contract states the rule up
 *  front so compliant models never need the nudge. */
const PHASE_SESSION_CONTRACT = [
  'Phase session contract: this session IS the phase.',
  '- Never end a turn while a subagent or background job you started is still running — wait for it in this session and fold its output in first.',
  '- Do not schedule wake-ups or defer work to a later session.',
  '- Write the result JSON file (path given above) BEFORE ending your final turn; a turn that ends without it gets a nudge, then the phase fails.',
].join('\n');

const PHASE_TIMEOUTS_MS: Record<string, number> = {
  qualify: 20 * 60_000,
  diagnose: 45 * 60_000,
  spec: 60 * 60_000,
  implement: 3 * 60 * 60_000,
  fix: 90 * 60_000,
  // A review is the most bounded phase there is — read one artifact, write
  // findings. Competent reviewers finish in single-digit minutes; the 60m this
  // used to be simply let a model that could not finish burn an hour per
  // reviewer (and, before timeouts stopped being retried, two). Every reviewer
  // in a council pays this, so it multiplies. 30m is still generous.
  review: 30 * 60_000,
};

export function harnessArtifactDir(dataDir: string, runId: string): string {
  return join(dataDir, 'runs', `${runId}-harness`);
}

/* ------------------------------------------------------------------ */
/* The driver                                                          */
/* ------------------------------------------------------------------ */

/** Executes the harness phase graph. Returns an error message (run fails),
 *  or null — success, cancellation, and the no-action early stop all settle
 *  through the caller's normal paths. */
export async function runHarnessDriver(
  host: HarnessDriverHost,
  input: HarnessDriverInput,
  deps: HarnessDriverDeps = {},
): Promise<string | null> {
  const resolveScript = deps.resolveScript ?? resolveHarnessScript;
  const createRuntime = deps.createRuntime ?? ((opts) => new HarnessRuntime(opts));
  const loadAgentic = deps.loadAgentic ?? loadAgenticConfig;
  const validate = deps.validate ?? ((commands, cwd) => runValidationCommands(commands, cwd));
  const exportConfig = deps.exportConfig ?? exportTrustedConfig;
  const createProber =
    deps.createProber ??
    ((opts) =>
      createModelProber({
        transport: createLiveTransport({
          advisors: opts.advisors as Parameters<typeof createLiveTransport>[0]['advisors'],
          cwd: opts.cwd,
        }),
        cache: PROBE_CACHE,
      }));

  const artifactDir = harnessArtifactDir(host.dataDir, host.runId);
  mkdirSync(artifactDir, { recursive: true });

  // Resume: an existing ledger is the prior attempt's memory. Done phases are
  // skipped (their artifacts are on disk); anything else restarts fresh.
  const existing = loadLedger(host.dataDir, host.runId);
  const ledger: HarnessLedger =
    existing && existing.workflow === input.workflow
      ? existing
      : createLedger({
          workflow: input.workflow,
          requestedProfile: input.profile,
          subject: input.issueId
            ? { kind: 'issue', id: input.issueId, text: input.task }
            : { kind: 'brief', text: input.task },
        });
  const persist = () => saveLedger(host.dataDir, host.runId, ledger);

  const emitPhase = (phaseId: string) => {
    const phase = ledger.phases.find((p) => p.id === phaseId);
    if (phase) host.emit({ type: 'harness.phase.updated', stepId: phaseId, phase });
  };

  const phaseDone = (id: string) => ledger.phases.find((p) => p.id === id)?.status === 'done';

  const resultPathFor = (phaseId: string) => join(artifactDir, `phase-${phaseId}-result.json`);

  const readResult = <T>(schema: z.ZodType<T>, phaseId: string): T | null => {
    try {
      const raw = JSON.parse(readFileSync(resultPathFor(phaseId), 'utf8'));
      const parsed = schema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };

  /** One agent phase: fresh session, structured result file, one automatic
   *  retry on a missing/malformed result. Returns the parsed result or an
   *  error string. */
  const agentPhase = async <T>(
    phaseId: string,
    name: string,
    skill: string | undefined,
    prompt: string,
    schema: z.ZodType<T>,
    timeoutKey: string,
    ref?: HarnessRoleRef,
  ): Promise<T | { error: string } | { cancelled: true }> => {
    if (phaseDone(phaseId)) {
      const prior = readResult(schema, phaseId);
      if (prior !== null) return prior;
      // Ledger says done but the artifact is gone — re-run rather than guess.
    }
    host.upsertStep({ id: phaseId, name, kind: 'agent' });
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (host.isCancelled()) return { cancelled: true };
      startPhase(ledger, { id: phaseId, name, kind: 'agent', skill });
      persist();
      host.setStepStatus(phaseId, 'running');
      emitPhase(phaseId);
      const resultPath = resultPathFor(phaseId);
      const failure = await host.runAgent({
        phaseId,
        name,
        skill,
        // Literal paths, not env references: codex/opencode phases must be able
        // to follow the contract even when a backend does not forward env vars.
        prompt: `${prompt
          .replaceAll('$CEZ_HARNESS_RESULT_FILE', resultPath)
          .replaceAll('$CEZ_HARNESS_ARTIFACT_DIR', artifactDir)}\n\n${PHASE_SESSION_CONTRACT}`,
        resultPath,
        timeoutMs: PHASE_TIMEOUTS_MS[timeoutKey] ?? 30 * 60_000,
        env: {
          CEZ_HARNESS_RESULT_FILE: resultPath,
          CEZ_HARNESS_ARTIFACT_DIR: artifactDir,
        },
        ...(ref ? { runner: ref.runner, model: ref.model, effort: ref.effort } : {}),
      });
      if (host.isCancelled()) return { cancelled: true };
      if (failure) {
        finishPhase(ledger, phaseId, 'failed', failure);
        persist();
        host.setStepStatus(phaseId, 'failed', failure);
        emitPhase(phaseId);
        return { error: `phase "${phaseId}" failed: ${failure}` };
      }
      const parsed = readResult(schema, phaseId);
      if (parsed !== null) {
        finishPhase(ledger, phaseId, 'done');
        persist();
        host.setStepStatus(phaseId, 'done');
        emitPhase(phaseId);
        return parsed;
      }
      host.emit({
        type: 'note',
        stepId: phaseId,
        message:
          attempt === 1
            ? `phase "${phaseId}" ended without a valid result file — retrying once in a fresh session`
            : `phase "${phaseId}" ended without a valid result file after the retry`,
      });
    }
    const error = `phase "${phaseId}" produced no valid result after a retry`;
    finishPhase(ledger, phaseId, 'failed', error);
    persist();
    host.setStepStatus(phaseId, 'failed', error);
    emitPhase(phaseId);
    return { error };
  };

  /** One deterministic op phase against the installed harness.mjs. */
  const opPhase = async (
    phaseId: string,
    name: string,
    fn: () => Promise<{ ok: boolean; error?: string }>,
  ): Promise<string | null | 'cancelled'> => {
    if (phaseDone(phaseId)) return null;
    if (host.isCancelled()) return 'cancelled';
    host.upsertStep({ id: phaseId, name, kind: 'check' });
    startPhase(ledger, { id: phaseId, name, kind: 'op' });
    persist();
    host.setStepStatus(phaseId, 'running');
    emitPhase(phaseId);
    const result = await fn();
    if (host.isCancelled()) return 'cancelled';
    if (!result.ok) {
      const error = result.error ?? `phase "${phaseId}" failed`;
      finishPhase(ledger, phaseId, 'failed', error);
      persist();
      host.setStepStatus(phaseId, 'failed', error);
      emitPhase(phaseId);
      return error;
    }
    finishPhase(ledger, phaseId, 'done');
    persist();
    host.setStepStatus(phaseId, 'done');
    emitPhase(phaseId);
    return null;
  };

  const skipRemaining = (fromIds: string[]) => {
    for (const id of fromIds) {
      host.upsertStep({
        id,
        name: id.charAt(0).toUpperCase() + id.slice(1),
        kind: id === 'stage' || id === 'validate' || id === 'capture' ? 'check' : 'agent',
      });
      host.setStepStatus(id, 'skipped');
      const phase = ledger.phases.find((p) => p.id === id);
      if (!phase) {
        startPhase(ledger, { id, name: id, kind: id === 'stage' || id === 'validate' ? 'op' : 'agent' });
        finishPhase(ledger, id, 'skipped');
      }
    }
    persist();
  };

  /* ---------------- preflight ---------------- */

  const isFeature = input.workflow === HARNESS_IMPLEMENT_FEATURE;
  if (input.workflow !== HARNESS_FIX_ISSUE && !isFeature) {
    return `unknown harness workflow: ${input.workflow}`;
  }

  // Role-based runs (2026-07-24) conduct any (runner, model) combination the
  // host can spawn. Without roles, version-1 scope remains the `standard`
  // profile; requesting a council PROFILE (an om-config preset) still reroutes
  // rather than silently degrading.
  const roles = input.roles;
  if (!roles && input.profile !== 'standard') {
    return (
      `harness profile "${input.profile}" is not yet driven by cezar — only "standard" is. ` +
      `Pick your models per role in the Multi-model tab instead, or run the om desktop wrappers.`
    );
  }
  if (roles) {
    ledger.effectiveProfile = 'multi';
    ledger.roles = {
      orchestrator: { ...roles.orchestrator },
      implementer: { ...roles.implementer },
      reviewers: roles.reviewers.map((r) => ({ ...r })),
    };
  }

  const preflightError = await opPhase('preflight', 'Preflight', async () => {
    // The cez-harness runtime plus every skill the graph delegates judgment to.
    const needed = isFeature
      ? ['cez-harness', 'cez-spec-writing', 'cez-code-review']
      : ['cez-harness', 'cez-verify-in-repo', 'cez-root-cause', 'cez-fix', 'cez-code-review'];
    for (const name of needed) {
      if (!(await host.ensureSkill(name))) {
        return {
          ok: false,
          error: `required skill "${name}" is missing — the bundled copy ships in vendor/skills (reinstall cezar or rerun scripts/vendor-skills.mjs), or provide it via a skills repo`,
        };
      }
    }
    if (!resolveScript(host.cwd)) {
      return { ok: false, error: 'cez-harness runtime not found in the worktree (.claude/skills/cez-harness/scripts/harness.mjs)' };
    }
    let agentic = await loadAgentic(host.cwd);
    // Setup stages `.ai/agentic.config.json` in the REPO working tree for
    // human review (harnessSetupPrefill runs in-root) — so between "setup
    // done" and "reviewed + committed", the base ref a worktree forks from
    // carries no `agentHarness` yet. Fall back to the repo working tree's
    // config in exactly that window, snapshotted into the run's artifacts so
    // the whole run sees one immutable copy. The user's own checkout is as
    // trusted as the base — the untrusted thing is the TASK branch, which
    // never feeds config here.
    let workingTreeConfig = false;
    if (agentic.agentHarness === undefined && host.repoRoot !== host.cwd) {
      const rootAgentic = await loadAgentic(host.repoRoot);
      if (rootAgentic.agentHarness !== undefined) {
        agentic = rootAgentic;
        workingTreeConfig = true;
        const copyPath = join(artifactDir, 'working-agentic.config.json');
        writeFileSync(copyPath, readFileSync(join(host.repoRoot, '.ai', 'agentic.config.json'), 'utf8'), 'utf8');
        ledger.trustedConfig = { baseRef: 'working-tree (staged, uncommitted)', path: copyPath, overlay: false };
        host.emit({
          type: 'note',
          message:
            'agentHarness config is staged in the repo working tree but not committed on the base branch — using the staged copy for this run; commit .ai/agentic.config.json to pin it',
        });
      }
    }
    // Trusted config snapshot (issue-workflow.md): pointless for `standard`
    // (no adapters run) but captured when present so the report can pin what
    // the run saw. Best-effort by design.
    const snapshot = agentic.agentHarness && !workingTreeConfig
      ? await exportConfig(host.repoRoot, agentic.baseBranch ?? 'HEAD', artifactDir)
      : null;
    if (snapshot) {
      ledger.trustedConfig = { baseRef: snapshot.ref, path: snapshot.path, overlay: false };
    }
    if (roles) {
      // Advisor reviewers execute through the runtime council and need their
      // bindings in the config (spec 2026-07-24-advisor-reviewers) — fail the
      // preflight with the setup hint rather than a mid-council surprise.
      const bound = (agentic.agentHarness?.models ?? {}) as Record<string, { roles?: unknown } | undefined>;
      for (const ref of roles.reviewers.filter(isAdvisorRef)) {
        const entry = bound[ref.model];
        const reviewerBound = Array.isArray(entry?.roles) && (entry.roles as unknown[]).includes('reviewer');
        if (!reviewerBound) {
          return {
            ok: false,
            error: `advisor reviewer "${ref.model}" is not bound as a reviewer in .ai/agentic.config.json (checked the run worktree and the repo working tree) — run cez-setup-harness`,
          };
        }
      }
    }
    if (roles) {
      const prober = createProber({
        advisors: (agentic.agentHarness?.models ?? {}) as Record<string, unknown>,
        cwd: host.cwd,
      });
      // One roster row per distinct model; a model serving several roles
      // carries every tag (the Models dock renders these).
      const roster = new Map<string, { id: string; binding: string; roles: string[]; family?: string }>();
      const tag = (ref: HarnessReviewerRef, role: string) => {
        const id = roleRefId(ref);
        const entry =
          roster.get(id) ??
          (isAdvisorRef(ref)
            ? { id, binding: `council · ${ref.model}`, family: ref.family, roles: [] }
            : { id, binding: `${ref.runner} · ${ref.model || 'default model'}`, roles: [] });
        if (!entry.roles.includes(role)) entry.roles.push(role);
        roster.set(id, entry);
      };
      tag(roles.orchestrator, 'orchestrator');
      tag(roles.implementer, 'implementer');
      for (const reviewer of roles.reviewers) tag(reviewer, 'reviewer');

      // Readiness is a MEASUREMENT, never an assumption (2026-07-25). This used
      // to be a hardcoded `'ready'`, which is how a council once ran with a
      // reviewer whose transport 500'd on every prompt: the ledger, the Models
      // dock, and the setup skill all showed green while nothing had called a
      // model. Probe each distinct binding on the transport that will run it.
      const refs = new Map<string, HarnessReviewerRef>();
      for (const ref of [roles.orchestrator, roles.implementer, ...roles.reviewers]) {
        if (!refs.has(roleRefId(ref))) refs.set(roleRefId(ref), ref);
      }
      const verdicts = await prober.probeAll([...refs.values()]);
      ledger.models = [...roster.values()].map((entry) => {
        const verdict = verdicts.get(entry.id);
        return {
          ...entry,
          readiness: verdict?.status === 'ready'
            ? ('ready' as const)
            : verdict?.status === 'failed'
              ? ('failed' as const)
              : ('unknown' as const),
          readinessDetail: verdict?.detail,
          invocations: 0,
          totalDurationMs: 0,
        };
      });

      // An unreachable binding fails HERE, with the upstream error, instead of
      // surfacing as "reviewer X produced no valid review" an hour into a run.
      const unreachable = ledger.models.filter((m) => m.readiness === 'failed');
      if (unreachable.length > 0) {
        persist();
        host.emit({
          type: 'harness.readiness.updated',
          profile: ledger.effectiveProfile,
          models: ledger.models,
        });
        return {
          ok: false,
          error: `unreachable model${unreachable.length > 1 ? 's' : ''}: ${unreachable
            .map((m) => `${m.id} — ${m.readinessDetail ?? 'probe failed'}`)
            .join('; ')}`,
        };
      }
    } else {
      ledger.models = [
        {
          id: 'claude',
          family: 'anthropic',
          binding: 'host app',
          roles: ['host', 'reviewer'],
          readiness: 'ready',
          invocations: 0,
          totalDurationMs: 0,
        },
      ];
    }
    if (input.issueId) ledger.claim = { held: false, issueId: input.issueId };
    persist();
    host.emit({ type: 'harness.readiness.updated', profile: ledger.effectiveProfile, models: ledger.models });
    return { ok: true };
  });
  if (preflightError === 'cancelled') return null;
  if (preflightError) return preflightError;

  const script = resolveScript(host.cwd);
  if (!script) return 'cez-harness runtime disappeared after preflight';
  const runtime = createRuntime({ script, cwd: host.cwd });
  const offInterrupt = host.onInterrupt(() => runtime.kill());

  /** One packet-less advisor council op (spec 2026-07-24-advisor-reviewers):
   *  a runtime `review` over a profile synthesized to exactly the given
   *  bindings. `artifact` overrides the subject (spec councils review the
   *  spec file); the default subject is the worktree's uncommitted diff.
   *  All-required: any incomplete advisor is an error. Returns null when the
   *  run was cancelled mid-op. */

  /**
   * Split reviewers by HOW they can be reviewed (2026-07-25).
   *
   * A reviewer is one structured call whenever it can be — subject inline,
   * JSON-enforced, about a minute — matching the om harness this was ported
   * from. Only claude falls back to a fresh agent session, because a
   * subscription login exposes no endpoint and the om contract wants a fresh
   * Claude context there anyway. Measured on the same spec: mimo answered as a
   * structured call in 11s, and never finished as a session across a 30m and
   * two 60m budgets.
   */
  const splitReviewers = (
    refs: HarnessReviewerRef[],
  ): {
    members: Array<{ councilId: string; label: string; family?: string; entry?: Record<string, unknown> }>;
    sessions: HarnessRoleRef[];
  } => {
    const members: Array<{ councilId: string; label: string; family?: string; entry?: Record<string, unknown> }> = [];
    const sessions: HarnessRoleRef[] = [];
    for (const ref of refs) {
      if (isAdvisorRef(ref)) {
        members.push({ councilId: ref.model, label: roleRefId(ref), family: ref.family });
        continue;
      }
      const binding = synthesizeReviewerBinding(ref, { timeoutMs: PHASE_TIMEOUTS_MS.review });
      if (binding) {
        members.push({
          councilId: binding.id,
          label: roleRefId(ref),
          family: typeof binding.entry.family === 'string' ? binding.entry.family : undefined,
          entry: binding.entry,
        });
        continue;
      }
      sessions.push(ref);
    }
    return { members, sessions };
  };

  const runAdvisorCouncilOp = async (op: {
    kindTag: string;
    round: number;
    /** One entry per reviewer in this council op. `entry` is present for a
     *  reviewer synthesized from the model picker (2026-07-25) and absent for
     *  an advisor already bound in `agentHarness.models`. */
    members: Array<{
      councilId: string;
      label: string;
      family?: string;
      entry?: Record<string, unknown>;
    }>;
    criteriaText: string;
    artifact?: string;
  }): Promise<{ rows: Array<Record<string, unknown>>; error: string | null } | null> => {
    const ids = op.members.map((m) => m.councilId);
    const configSource = ledger.trustedConfig?.path ?? join(host.cwd, '.ai', 'agentic.config.json');
    const rows: Array<Record<string, unknown>> = [];
    let error: string | null = null;
    try {
      // A synthesized reviewer carries its own binding, so a repo with no
      // `.ai/agentic.config.json` at all — the ordinary cezar project — must
      // still get a council. Only a configured ADVISOR needs the repo file.
      const configJson = (existsSync(configSource)
        ? (JSON.parse(readFileSync(configSource, 'utf8')) as object)
        : {}) as {
        agentHarness?: {
          models?: Record<string, { timeoutMs?: unknown } | undefined>;
          profiles?: Record<string, unknown>;
        };
      };
      const harnessObj = configJson.agentHarness ?? {};
      // A picker-chosen reviewer has no entry in the repo's config; give the
      // runtime its binding for this op only. Never written back to the repo.
      harnessObj.models = { ...(harnessObj.models ?? {}) };
      for (const member of op.members) {
        if (member.entry) harnessObj.models[member.councilId] = member.entry as never;
      }
      harnessObj.profiles = {
        ...(harnessObj.profiles ?? {}),
        'cez-role-council': {
          workers: [],
          reviewers: ids,
          reviewPolicy: { mode: 'all-required', requiredReviewers: ids },
        },
      };
      configJson.agentHarness = harnessObj;
      const councilConfigPath = join(artifactDir, `council-config-${op.kindTag}-r${op.round}.json`);
      writeFileSync(councilConfigPath, `${JSON.stringify(configJson, null, 2)}\n`, 'utf8');
      const criteriaPath = join(artifactDir, `council-criteria-${op.kindTag}-r${op.round}.md`);
      writeFileSync(criteriaPath, op.criteriaText, 'utf8');
      // The runtime requires its artifact dir to be git-ignored inside the
      // worktree — same exclusion discipline as skill materialization.
      await excludeFromGit(host.cwd, '.ai/qa/');
      const outputDir = join(host.cwd, '.ai', 'qa', `cez-council-${host.runId.slice(0, 8)}-${op.kindTag}-r${op.round}`);
      const timeoutMs =
        Math.max(600_000, ...ids.map((id) => Number(harnessObj.models?.[id]?.timeoutMs) || 0)) + 120_000;
      const result = await runtime.run(
        'review',
        [
          '--config',
          councilConfigPath,
          '--profile',
          'cez-role-council',
          '--worktree',
          host.cwd,
          ...(op.artifact ? ['--artifact', op.artifact] : []),
          '--criteria-file',
          criteriaPath,
          '--output-dir',
          outputDir,
        ],
        { timeoutMs },
      );
      if (host.isCancelled()) return null;
      const resultFile = join(outputDir, 'review-result.json');
      const raw = existsSync(resultFile) ? (JSON.parse(readFileSync(resultFile, 'utf8')) as unknown) : null;
      const parsedCouncil = raw === null ? null : councilResultSchema.safeParse(raw);
      if (!result.ok || !parsedCouncil?.success) {
        // Two very different failures used to collapse into one mute message.
        // Separate them, and never swallow a schema mismatch again: a council
        // that ran to completion and APPROVED was once discarded as "no
        // structured result" because one field's type had drifted from the
        // runtime's published contract.
        if (result.ok && raw !== null && parsedCouncil && !parsedCouncil.success) {
          const issues = parsedCouncil.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ');
          error =
            `advisor council returned a result cezar could not read (${resultFile}) — ` +
            `it does not match the expected shape: ${issues}. ` +
            `The council itself completed; this is a cezar/runtime contract mismatch.`;
        } else if (result.ok && raw === null) {
          error = `advisor council wrote no result file at ${resultFile}`;
        } else {
          error = `advisor council failed: ${(result.error ?? result.stderr.slice(-300)).trim() || `exit ${result.exitCode}, no diagnostics on stderr`}`;
        }
      } else {
        for (const member of op.members) {
          const row = parsedCouncil.data.reviewers.find((r) => r.id === member.councilId);
          rows.push({
            id: member.label,
            runner: 'harness',
            model: member.councilId,
            family: member.family,
            status: row?.status ?? 'failed',
            freshContext: true,
            verdict: row?.review?.verdict ?? null,
            findings: row?.review?.findings ?? [],
          });
        }
        // NO group-level failure here: the rows already carry each member's
        // own status, and quorum — not unanimity — decides whether the round
        // stands. This used to fail the whole op (and therefore every member)
        // the moment one reviewer came back incomplete.
      }
    } catch (err) {
      error = `advisor council failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    return { rows, error };
  };

  try {
    /* ---------------- capture ---------------- */

    const startStatePath = join(artifactDir, 'start-state.json');
    const captureError = await opPhase('capture', 'Capture', async () => {
      const result = await runtime.run('capture', ['--worktree', host.cwd, '--output', startStatePath]);
      if (!result.ok) return { ok: false, error: `capture failed: ${(result.error ?? result.stderr ?? '').trim() || 'non-zero exit'}` };
      if (!existsSync(startStatePath)) return { ok: false, error: 'capture reported success but wrote no start-state artifact' };
      return { ok: true };
    });
    if (captureError === 'cancelled') return null;
    if (captureError) return captureError;

    /* ---------------- judgment phases ---------------- */

    const allowlist = new Set<string>();
    let suggestedCommit: string | undefined;
    let implementSummary: string | undefined;
    let diagnosisSummary: string;

    if (isFeature) {
      const spec = await agentPhase(
        'spec',
        'Specify',
        'cez-spec-writing',
        [
          `Write the specification for this feature brief, following the cez-spec-writing skill in full.`,
          ``,
          `Feature brief:`,
          input.task,
          ``,
          `Work only inside this worktree. Do not commit, push, or open a pull request.`,
          // Naming the root explicitly is load-bearing: this worktree is nested
          // inside the checkout and its `.git` is a FILE, so "find the repo
          // root" heuristics that look for a `.git` DIRECTORY resolve to the
          // parent and write the spec where no reviewer will read it.
          `Save the spec inside THIS worktree — its root is ${host.cwd}. Resolve the repository's spec`,
          `location relative to that root; never write to any other checkout, even if a repo-root check`,
          `points outside this directory (this worktree's .git is a file, not a directory, which fools that check).`,
          `When you are done write a JSON result file at the path in $CEZ_HARNESS_RESULT_FILE of the shape:`,
          `{"summary": "<one-paragraph spec summary>", "specPath": "<repo-relative path of the spec file>", "files": ["<spec file>"]}`,
        ].join('\n'),
        specResultSchema,
        'spec',
        roles?.orchestrator,
      );
      if ('cancelled' in (spec as object)) return null;
      if ('error' in (spec as object)) return (spec as { error: string }).error;
      const specResult = spec as z.infer<typeof specResultSchema>;
      diagnosisSummary = specResult.summary;
      for (const f of specResult.files ?? []) allowlist.add(f);

      // Spec council (2026-07-24, parity with the upstream multi wrapper):
      // the council reviews the SPECIFICATION itself in a bounded revise loop
      // (≤3 rounds) BEFORE any implementation starts. Role-based runs only —
      // `standard` keeps the single-author spec and goes straight to build.
      if (roles) {
        const MAX_SPEC_ROUNDS = 3;
        let specPath = specResult.specPath;
        /**
         * A returned path is a claim; verify the file is actually THERE before a
         * council pays to review it (2026-07-25).
         *
         * cezar worktrees are nested inside the checkout and carry `.git` as a
         * *file* (a `gitdir:` pointer), so any root detection that walks up
         * looking for a `.git` DIRECTORY skips the worktree and resolves to the
         * main checkout. A spec phase that does this writes a real file to a
         * real spec directory — just not the one every reviewer reads. Left
         * unchecked it surfaces as an ENOENT deep inside the advisor council,
         * after a full review round has already been spent.
         */
        const specMisplaced = (p: string): string | null => {
          if (existsSync(join(host.cwd, p))) return null;
          if (existsSync(join(host.repoRoot, p))) {
            return (
              `the spec phase wrote "${p}" to the main checkout (${join(host.repoRoot, p)}) ` +
              `instead of the run worktree (${host.cwd}). Reviewers read the worktree copy, so the ` +
              `council would fail on a spec that looks present. Re-run with the spec written inside the worktree.`
            );
          }
          return `the spec phase reported "${p}" but no such file exists in the run worktree (${host.cwd})`;
        };
        // Structured calls wherever possible; sessions only for claude.
        const specSplit = splitReviewers(roles.reviewers);
        const specRunnerReviewers = specSplit.sessions;
        const specCouncilMembers = specSplit.members;
        for (let sround = 1; sround <= MAX_SPEC_ROUNDS; sround += 1) {
          if (host.isCancelled()) return null;
          if (!specPath || specPath.startsWith('/') || specPath.split('/').includes('..')) {
            return `spec phase returned an unsafe spec path: ${specPath}`;
          }
          // Re-checked every round: a revision round can move the file too.
          const misplaced = specMisplaced(specPath);
          if (misplaced) return misplaced;
          const councilId = sround === 1 ? 'spec-review' : `spec-review-${sround}`;
          const councilName = sround === 1 ? 'Spec council' : `Spec council (round ${sround})`;
          host.upsertStep({ id: councilId, name: councilName, kind: 'agent' });
          startPhase(ledger, { id: councilId, name: councilName, kind: 'agent', skill: 'cez-spec-writing' });
          persist();
          host.setStepStatus(councilId, 'running');
          emitPhase(councilId);
          const specPromptText = [
            `You are a FRESH review context. Review the feature SPECIFICATION at ${specPath} (read it from this worktree) to staff-engineer standard: risks, backward compatibility, gaps, implementation-readiness, and simplicity — the cez-spec-writing review format.`,
            ``,
            `The feature brief: ${input.task}`,
            ``,
            `When you are done write a JSON result file at the path in $CEZ_HARNESS_RESULT_FILE of the shape:`,
            `{"verdict": "approve" | "request_changes", "findings": [{"severity": "blocker|major|minor|nit", "title": "…", "location": "path:line", "evidence": "…"}]}`,
            `Any blocker or major finding means "request_changes"; only minor/nit findings (or none) means "approve".`,
          ].join('\n');
          const councilReviewers: Array<Record<string, unknown>> = [];
          const outcomes: CouncilOutcome[] = [];
          // Reviewers fan out (2026-07-25, parity with the om runtime's
          // `pool(profile.reviewers, maxParallel)`): they are independent fresh
          // contexts over the same read-only subject, so serializing them only
          // multiplied the wall clock by the reviewer count.
          await pool(specRunnerReviewers, MAX_PARALLEL_REVIEWERS, async (reviewer, idx) => {
            if (host.isCancelled()) return;
            const label = roleRefId(reviewer);
            const resultPath = join(artifactDir, `phase-${councilId}-r${idx + 1}-result.json`);
            let parsed: ReviewResult | null = null;
            let lastFailure: string | null = null;
            for (let attempt = 1; attempt <= 2 && parsed === null; attempt += 1) {
              const failure = await host.runAgent({
                concurrent: true,
                phaseId: councilId,
                name: `${councilName} — ${label}`,
                skill: 'cez-spec-writing',
                prompt: `${specPromptText.replaceAll('$CEZ_HARNESS_RESULT_FILE', resultPath)}\n\n${PHASE_SESSION_CONTRACT}`,
                resultPath,
                timeoutMs: PHASE_TIMEOUTS_MS.review ?? 30 * 60_000,
                env: { CEZ_HARNESS_RESULT_FILE: resultPath, CEZ_HARNESS_ARTIFACT_DIR: artifactDir },
                runner: reviewer.runner,
                model: reviewer.model,
                effort: reviewer.effort,
              });
              if (host.isCancelled()) return;
              if (failure) {
                lastFailure = failure;
                // A spent budget stays spent: never buy the same timeout twice.
                if (!isRetryableReviewerFailure(failure)) break;
                continue;
              }
              try {
                const check = reviewResultSchema.safeParse(JSON.parse(readFileSync(resultPath, 'utf8')));
                parsed = check.success ? check.data : null;
              } catch {
                parsed = null;
              }
              if (parsed === null) lastFailure = 'ended without a valid result file';
            }
            if (parsed === null) {
              const reason = lastFailure ?? 'no valid review';
              // Record and CARRY ON — the remaining reviewers are independent,
              // and quorum below decides whether the round still stands.
              outcomes.push({ label, family: councilFamilyOf(reviewer), status: 'failed', reason });
              councilReviewers.push({ id: label, ...reviewer, status: 'failed', reason, freshContext: true });
              host.emit({
                type: 'note',
                stepId: councilId,
                message: `reviewer ${label} produced no review (${reason}) — continuing with the rest of the council`,
              });
              return;
            }
            outcomes.push({ label, family: councilFamilyOf(reviewer), status: 'completed' });
            councilReviewers.push({
              id: label,
              ...reviewer,
              status: 'completed',
              freshContext: true,
              verdict: parsed.verdict,
              findings: parsed.findings,
            });
            host.emit({
              type: 'harness.council.updated',
              stepId: councilId,
              council: { round: sround, kind: 'spec', reviewers: councilReviewers, verdict: null },
            });
          });
          // Advisors run regardless of runner outcomes — they are a separate
          // transport and their verdicts count toward quorum on their own.
          if (specCouncilMembers.length > 0 && !host.isCancelled()) {
            const advisorRun = await runAdvisorCouncilOp({
              kindTag: 'spec',
              round: sround,
              members: specCouncilMembers,
              criteriaText: [
                `Spec council criteria (run ${host.runId}).`,
                ``,
                `The subject is the feature SPECIFICATION at ${specPath} — not a code diff.`,
                `Feature brief: ${input.task}`,
                ``,
                `Judge risks, backward compatibility, gaps, implementation-readiness, and simplicity.`,
              ].join('\n'),
              artifact: join(host.cwd, specPath),
            });
            if (advisorRun === null) return null;
            if (advisorRun.error) {
              // The council op failed as a group — every advisor in it is out.
              for (const member of specCouncilMembers) {
                outcomes.push({
                  label: member.label,
                  family: member.family,
                  status: 'failed',
                  reason: advisorRun.error,
                });
                councilReviewers.push({ id: member.label, status: 'failed', reason: advisorRun.error });
              }
              host.emit({
                type: 'note',
                stepId: councilId,
                message: `advisor council produced no result (${advisorRun.error}) — continuing with the runner reviewers`,
              });
            } else {
              councilReviewers.push(...advisorRun.rows);
              for (const row of advisorRun.rows) {
                outcomes.push({
                  label: String(row.id),
                  family: typeof row.family === 'string' ? row.family : undefined,
                  status: row.status === 'completed' ? 'completed' : 'failed',
                  reason: typeof row.error === 'string' ? row.error : undefined,
                });
              }
            }
          }
          const quorum = councilQuorum(outcomes);
          if (!quorum.ok) {
            const error = `spec council did not reach quorum: ${quorum.reason}`;
            finishPhase(ledger, councilId, 'failed', error);
            ledger.councils = [...ledger.councils, { round: sround, kind: 'spec', reviewers: councilReviewers, verdict: null }];
            persist();
            host.setStepStatus(councilId, 'failed', error);
            emitPhase(councilId);
            return error;
          }
          if (quorum.degraded) {
            // Loud, recorded, and carried into the handoff — a degraded council
            // must never look like a clean one.
            host.emit({
              type: 'note',
              stepId: councilId,
              message: `spec council ran DEGRADED — ${quorum.completed.length} of ${outcomes.length} reviewers completed; missing: ${quorum.failed
                .map((f) => `${f.label} (${f.reason ?? 'no valid review'})`)
                .join('; ')}`,
            });
          }
          const byKey = new Map<string, AttributedFinding>();
          for (const entry of councilReviewers) {
            const label = entry.id as string;
            for (const finding of (entry.findings as ReviewResult['findings'] | undefined) ?? []) {
              const key = `${finding.severity}|${finding.title}`;
              const current = byKey.get(key);
              if (current) current.by = `${current.by}, ${label}`;
              else byKey.set(key, { ...finding, by: label });
            }
          }
          const specFindings = [...byKey.values()];
          const specVerdict: 'approve' | 'request_changes' = councilReviewers.some(
            (r) => r.verdict === 'request_changes',
          )
            ? 'request_changes'
            : 'approve';
          finishPhase(ledger, councilId, 'done');
          ledger.councils = [
            ...ledger.councils,
            { round: sround, kind: 'spec', reviewers: councilReviewers, verdict: specVerdict, findings: specFindings },
          ];
          persist();
          host.setStepStatus(councilId, 'done');
          emitPhase(councilId);
          host.emit({
            type: 'harness.council.updated',
            stepId: councilId,
            council: { round: sround, kind: 'spec', reviewers: councilReviewers, verdict: specVerdict, findings: specFindings },
          });
          if (specVerdict === 'approve') break;
          if (sround === MAX_SPEC_ROUNDS) {
            // Do NOT discard the run (2026-07-25). Observed live: three rounds
            // of genuine revision, one reviewer approving and converging, and a
            // second raising three fresh majors every round — variations on the
            // same themes, with no criterion it would ever sign off on. The
            // spec was materially better each round and was thrown away anyway.
            //
            // Delivery is stage-only: the human is the final gate. So the run
            // proceeds with the contested findings recorded and surfaced, and
            // the human decides — which is what they would have done with the
            // failed run's artifacts anyway, minus the hours.
            const contested = specFindings
              .filter((f) => f.severity === 'blocker' || f.severity === 'major')
              .map((f) => `[${f.severity}] ${f.title} (raised by ${f.by})`)
              .join('; ');
            host.emit({
              type: 'note',
              stepId: councilId,
              message:
                `spec council did not converge in ${MAX_SPEC_ROUNDS} rounds — proceeding with the spec as revised, ` +
                `UNRESOLVED: ${contested || 'no blocking findings, reviewers still split on the verdict'}`,
            });
            break;
          }
          const revise = await agentPhase(
            `spec-${sround + 1}`,
            `Revise spec (round ${sround + 1})`,
            'cez-spec-writing',
            [
              `The spec council requested changes on the specification at ${specPath}. Address every finding, update the spec file in place, and keep it implementation-accurate.`,
              ``,
              `Findings:`,
              ...specFindings.map(
                (f) =>
                  `- [${f.severity}] ${f.title}${f.location ? ` @ ${f.location}` : ''} (raised by ${f.by})${f.evidence ? ` — ${f.evidence}` : ''}`,
              ),
              ``,
              `When you are done write a JSON result file at the path in $CEZ_HARNESS_RESULT_FILE of the shape:`,
              `{"summary": "<one-paragraph summary of the revision>", "specPath": "<repo-relative spec path>", "files": ["<spec file>"]}`,
            ].join('\n'),
            specResultSchema,
            'spec',
            roles.orchestrator,
          );
          if ('cancelled' in (revise as object)) return null;
          if ('error' in (revise as object)) return (revise as { error: string }).error;
          const revised = revise as z.infer<typeof specResultSchema>;
          specPath = revised.specPath;
          diagnosisSummary = revised.summary;
          for (const f of revised.files ?? []) allowlist.add(f);
        }
      }
    } else {
      const qualify = await agentPhase(
        'qualify',
        'Qualify',
        'cez-verify-in-repo',
        [
          `Qualify this tracker issue with the cez-verify-in-repo skill: decide whether it is a real, still-unfixed defect on the current branch.`,
          ``,
          `Issue:`,
          input.task,
          ``,
          `Read-only triage — change nothing. When you are done write a JSON result file at the path in $CEZ_HARNESS_RESULT_FILE of the shape:`,
          `{"outcome": "work_needed" | "no_action", "evidence": "<one-paragraph evidence summary>"}`,
          `Use "no_action" when the issue is already fixed, already owned by someone else, covered by an open PR, or not actually a defect.`,
        ].join('\n'),
        qualifyResultSchema,
        'qualify',
        roles?.orchestrator,
      );
      if ('cancelled' in (qualify as object)) return null;
      if ('error' in (qualify as object)) return (qualify as { error: string }).error;
      const qualifyResult = qualify as z.infer<typeof qualifyResultSchema>;
      if (qualifyResult.outcome === 'no_action') {
        host.emit({
          type: 'note',
          message: `qualify: no action needed — ${qualifyResult.evidence}`,
        });
        skipRemaining(['diagnose', 'implement', 'validate', 'review', 'stage']);
        return null;
      }

      const diagnose = await agentPhase(
        'diagnose',
        'Diagnose',
        'cez-root-cause',
        [
          `Diagnose the root cause of this issue with the cez-root-cause skill. Read-only — locate the cause and the minimal change surface; do not fix anything yet.`,
          ``,
          `Issue:`,
          input.task,
          ``,
          `Qualification evidence: ${qualifyResult.evidence}`,
          ``,
          `Write your full diagnosis brief to a markdown file under $CEZ_HARNESS_ARTIFACT_DIR, then write a JSON result file at the path in $CEZ_HARNESS_RESULT_FILE of the shape:`,
          `{"summary": "<evidence-backed root-cause summary>", "files": ["<repo-relative files to change>"], "regressionTest": "<proposed regression test, optional>"}`,
        ].join('\n'),
        diagnoseResultSchema,
        'diagnose',
        roles?.orchestrator,
      );
      if ('cancelled' in (diagnose as object)) return null;
      if ('error' in (diagnose as object)) return (diagnose as { error: string }).error;
      diagnosisSummary = (diagnose as z.infer<typeof diagnoseResultSchema>).summary;
    }

    /* ------------- implement → validate → review (bounded loop) ------------- */

    const agentic = await loadAgentic(host.cwd);
    type AttributedFinding = ReviewResult['findings'][number] & { by?: string };
    let reviewFindings: AttributedFinding[] = [];

    for (let round = 1; round <= ledger.loops.maxFixRounds; round += 1) {
      const isFirst = round === 1;
      const implementId = isFirst ? 'implement' : `fix-${round}`;
      const reviewId = isFirst ? 'review' : `review-${round}`;

      const implementPrompt = isFirst
        ? [
            isFeature
              ? `Implement this feature in the current worktree, following the specification summary below.`
              : `Fix this issue in the current worktree with the cez-fix skill: regression test first (observe it fail for the diagnosed reason), then the minimal fix, then the repository's validation.`,
            ``,
            `Task:`,
            input.task,
            ``,
            `${isFeature ? 'Specification' : 'Diagnosis'}: ${diagnosisSummary}`,
            ``,
            `Hard boundaries: edit only this worktree; create NO commit; perform NO push, PR, or other remote write; do not weaken or delete tests.`,
            `When you are done write a JSON result file at the path in $CEZ_HARNESS_RESULT_FILE of the shape:`,
            `{"changedPaths": ["<every repo-relative file you changed or created>"], "summary": "<what changed and why>", "suggestedCommit": "<conventional commit subject>"}`,
          ].join('\n')
        : [
            `A fresh code review of your project's uncommitted diff confirmed blocking findings. Fix them in the current worktree.`,
            ``,
            `Confirmed findings:`,
            ...reviewFindings.map(
              (f) =>
                `- [${f.severity}] ${f.title}${f.location ? ` (${f.location})` : ''}${f.evidence ? ` — ${f.evidence}` : ''}${f.by ? ` — raised by ${f.by}` : ''}`,
            ),
            ``,
            `Hard boundaries: edit only this worktree; create NO commit; perform NO push or PR; do not weaken or delete tests.`,
            `When you are done write a JSON result file at the path in $CEZ_HARNESS_RESULT_FILE of the shape:`,
            `{"changedPaths": ["<every repo-relative file you changed>"], "summary": "<what you fixed>"}`,
          ].join('\n');

      const implement = await agentPhase(
        implementId,
        isFirst ? 'Implement' : `Fix (round ${round})`,
        'cez-fix',
        implementPrompt,
        implementResultSchema,
        isFirst ? 'implement' : 'fix',
        roles?.implementer,
      );
      if ('cancelled' in (implement as object)) return null;
      if ('error' in (implement as object)) return (implement as { error: string }).error;
      const implementResult = implement as z.infer<typeof implementResultSchema>;
      for (const path of implementResult.changedPaths) allowlist.add(path);
      suggestedCommit = implementResult.suggestedCommit ?? suggestedCommit;
      implementSummary = implementResult.summary ?? implementSummary;

      /* validate */
      const validateId = isFirst ? 'validate' : `validate-${round}`;
      let validationFailed: string | null = null;
      const validateError = await opPhase(validateId, isFirst ? 'Validate' : `Validate (round ${round})`, async () => {
        if (agentic.validationCommands.length === 0) {
          ledger.validation = [];
          host.emit({ type: 'note', stepId: validateId, message: 'no validation commands configured (.ai/agentic.config.json) — gate recorded as empty' });
          return { ok: true };
        }
        const checks = await validate(agentic.validationCommands, host.cwd);
        ledger.validation = checks;
        persist();
        writeFileSync(
          join(artifactDir, 'validation.json'),
          JSON.stringify({ version: 1, status: checks.every((c) => c.status === 'passed') ? 'passed' : 'failed', checks }, null, 2),
          'utf8',
        );
        const failed = checks.find((c) => c.status === 'failed');
        if (failed) {
          // A failed gate is not a run failure — it re-enters the fix loop
          // with the real command evidence, like a confirmed review finding.
          validationFailed = `\`${failed.command}\` exited ${failed.exitCode}: ${failed.evidence}`;
          return { ok: true };
        }
        return { ok: true };
      });
      if (validateError === 'cancelled') return null;
      if (validateError) return validateError;
      if (validationFailed) {
        reviewFindings = [{ severity: 'blocker', title: 'validation gate failed', evidence: validationFailed }];
        ledger.loops.fixRounds = round;
        persist();
        if (round === ledger.loops.maxFixRounds) {
          return `validation gate still failing after ${ledger.loops.maxFixRounds} rounds: ${validationFailed}`;
        }
        continue;
      }

      /* fresh review — one pass per reviewer for role-based runs */
      const reviewPromptText = [
        `You are a FRESH review context with no implementation transcript — review this worktree's complete uncommitted diff against the base branch with the cez-code-review skill, in full.`,
        ``,
        `The task under review: ${input.task}`,
        `Validation gate: ${
          ledger.validation.length === 0
            ? 'no commands configured'
            : ledger.validation.map((c) => `${c.command} → ${c.status}`).join('; ')
        }`,
        ``,
        `Confirm findings against the code itself. When you are done write a JSON result file at the path in $CEZ_HARNESS_RESULT_FILE of the shape:`,
        `{"verdict": "approve" | "request_changes", "findings": [{"severity": "blocker|major|minor|nit", "title": "…", "location": "path:line", "evidence": "…"}]}`,
        `Verdict follows cez-code-review mechanically: any blocker or major finding means "request_changes"; only minor/nit findings (or none) means "approve".`,
      ].join('\n');

      let mergedFindings: AttributedFinding[];
      let mergedVerdict: 'approve' | 'request_changes';

      if (roles) {
        // The council: every reviewer gets its own fresh session over the same
        // diff; a reviewer that cannot produce a valid result after one retry
        // fails the run — a partial council is no council (the om all-required
        // rule). Sequential in version 1: one live session per run.
        const councilName = isFirst ? 'Council review' : `Council review (round ${round})`;
        host.upsertStep({ id: reviewId, name: councilName, kind: 'agent' });
        startPhase(ledger, { id: reviewId, name: councilName, kind: 'agent', skill: 'cez-code-review' });
        persist();
        host.setStepStatus(reviewId, 'running');
        emitPhase(reviewId);
        const councilReviewers: Array<Record<string, unknown>> = [];
        /** Per-reviewer outcomes — quorum, not unanimity, decides the round. */
        const outcomes: CouncilOutcome[] = [];
        const implSplit = splitReviewers(roles.reviewers);
        const runnerReviewers = implSplit.sessions;
        const implCouncilMembers = implSplit.members;
        // Same fan-out as the spec council: independent fresh contexts over
        // one read-only subject, so they run side by side (2026-07-25).
        await pool(runnerReviewers, MAX_PARALLEL_REVIEWERS, async (reviewer, idx) => {
          if (host.isCancelled()) return;
          const label = roleRefId(reviewer);
          const resultPath = join(artifactDir, `phase-${reviewId}-r${idx + 1}-result.json`);
          let parsed: ReviewResult | null = null;
          let lastFailure: string | null = null;
          for (let attempt = 1; attempt <= 2 && parsed === null; attempt += 1) {
            const failure = await host.runAgent({
              concurrent: true,
              phaseId: reviewId,
              name: `Review — ${label}`,
              skill: 'cez-code-review',
              prompt: `${reviewPromptText
                .replaceAll('$CEZ_HARNESS_RESULT_FILE', resultPath)
                .replaceAll('$CEZ_HARNESS_ARTIFACT_DIR', artifactDir)}\n\n${PHASE_SESSION_CONTRACT}`,
              resultPath,
              timeoutMs: PHASE_TIMEOUTS_MS.review ?? 30 * 60_000,
              env: { CEZ_HARNESS_RESULT_FILE: resultPath, CEZ_HARNESS_ARTIFACT_DIR: artifactDir },
              runner: reviewer.runner,
              model: reviewer.model,
              effort: reviewer.effort,
            });
            if (host.isCancelled()) return;
            if (failure) {
              lastFailure = failure;
              if (!isRetryableReviewerFailure(failure)) break;
              continue;
            }
            try {
              const check = reviewResultSchema.safeParse(JSON.parse(readFileSync(resultPath, 'utf8')));
              parsed = check.success ? check.data : null;
            } catch {
              parsed = null;
            }
            if (parsed === null) lastFailure = 'ended without a valid result file';
          }
          if (parsed === null) {
            const reason = lastFailure ?? 'no valid review';
            outcomes.push({ label, family: councilFamilyOf(reviewer), status: 'failed', reason });
            councilReviewers.push({ id: label, ...reviewer, status: 'failed', reason, freshContext: true });
            host.emit({
              type: 'note',
              stepId: reviewId,
              message: `reviewer ${label} produced no review (${reason}) — continuing with the rest of the council`,
            });
            return;
          }
          outcomes.push({ label, family: councilFamilyOf(reviewer), status: 'completed' });
          councilReviewers.push({
            id: label,
            ...reviewer,
            status: 'completed',
            freshContext: true,
            verdict: parsed.verdict,
            findings: parsed.findings,
          });
          host.emit({
            type: 'harness.council.updated',
            stepId: reviewId,
            council: { round, kind: 'implementation', reviewers: councilReviewers, verdict: null },
          });
        });
        if (implCouncilMembers.length > 0 && !host.isCancelled()) {
          // Advisor reviewers (spec 2026-07-24-advisor-reviewers): one
          // packet-less runtime council over the worktree diff — the same
          // subject the runner sessions reviewed.
          const advisorRun = await runAdvisorCouncilOp({
            kindTag: 'impl',
            round,
            members: implCouncilMembers,
            criteriaText: [
              `Role-based cezar council criteria (run ${host.runId}).`,
              ``,
              `The task under review: ${input.task}`,
              `Validation gate: ${
                ledger.validation.length === 0
                  ? 'no commands configured'
                  : ledger.validation.map((c) => `${c.command} → ${c.status}`).join('; ')
              }`,
              ``,
              `Review the worktree's uncommitted diff (the subject) against these facts.`,
            ].join('\n'),
          });
          if (advisorRun === null) return null;
          if (advisorRun.error) {
            for (const member of implCouncilMembers) {
              outcomes.push({
                label: member.label,
                family: member.family,
                status: 'failed',
                reason: advisorRun.error,
              });
              councilReviewers.push({ id: member.label, status: 'failed', reason: advisorRun.error });
            }
            host.emit({
              type: 'note',
              stepId: reviewId,
              message: `advisor council produced no result (${advisorRun.error}) — continuing with the runner reviewers`,
            });
          } else {
            councilReviewers.push(...advisorRun.rows);
            for (const row of advisorRun.rows) {
              outcomes.push({
                label: String(row.id),
                family: typeof row.family === 'string' ? row.family : undefined,
                status: row.status === 'completed' ? 'completed' : 'failed',
                reason: typeof row.error === 'string' ? row.error : undefined,
              });
            }
            host.emit({
              type: 'harness.council.updated',
              stepId: reviewId,
              council: { round, kind: 'implementation', reviewers: councilReviewers, verdict: null },
            });
          }
        }
        const quorum = councilQuorum(outcomes);
        if (!quorum.ok) {
          const error = `review council did not reach quorum: ${quorum.reason}`;
          finishPhase(ledger, reviewId, 'failed', error);
          ledger.councils = [...ledger.councils, { round, kind: 'implementation', reviewers: councilReviewers, verdict: null }];
          persist();
          host.setStepStatus(reviewId, 'failed', error);
          emitPhase(reviewId);
          return error;
        }
        if (quorum.degraded) {
          host.emit({
            type: 'note',
            stepId: reviewId,
            message: `review council ran DEGRADED — ${quorum.completed.length} of ${outcomes.length} reviewers completed; missing: ${quorum.failed
              .map((f) => `${f.label} (${f.reason ?? 'no valid review'})`)
              .join('; ')}`,
          });
        }
        // Union findings across reviewers, deduped by severity+title, each
        // attributed to every reviewer that raised it.
        const byKey = new Map<string, AttributedFinding>();
        for (const entry of councilReviewers) {
          const label = entry.id as string;
          for (const finding of (entry.findings as ReviewResult['findings'] | undefined) ?? []) {
            const key = `${finding.severity}|${finding.title}`;
            const current = byKey.get(key);
            if (current) current.by = `${current.by}, ${label}`;
            else byKey.set(key, { ...finding, by: label });
          }
        }
        mergedFindings = [...byKey.values()];
        mergedVerdict = councilReviewers.some((r) => r.verdict === 'request_changes') ? 'request_changes' : 'approve';
        finishPhase(ledger, reviewId, 'done');
        ledger.councils = [
          ...ledger.councils,
          { round, kind: 'implementation', reviewers: councilReviewers, verdict: mergedVerdict, findings: mergedFindings },
        ];
        persist();
        host.setStepStatus(reviewId, 'done');
        emitPhase(reviewId);
        host.emit({
          type: 'harness.council.updated',
          stepId: reviewId,
          council: { round, kind: 'implementation', reviewers: councilReviewers, verdict: mergedVerdict, findings: mergedFindings },
        });
      } else {
        const review = await agentPhase(
          reviewId,
          isFirst ? 'Review' : `Review (round ${round})`,
          'cez-code-review',
          reviewPromptText,
          reviewResultSchema,
          'review',
        );
        if ('cancelled' in (review as object)) return null;
        if ('error' in (review as object)) return (review as { error: string }).error;
        const reviewResult = review as ReviewResult;
        mergedFindings = reviewResult.findings.map((f) => ({ ...f, by: 'claude' }));
        mergedVerdict = reviewResult.verdict;
        host.emit({
          type: 'harness.council.updated',
          stepId: reviewId,
          council: {
            round,
            kind: 'implementation',
            reviewers: [{ id: 'claude', status: 'completed', freshContext: true }],
            verdict: mergedVerdict,
            findings: mergedFindings,
          },
        });
        ledger.councils = [
          ...ledger.councils,
          { round, kind: 'implementation', verdict: mergedVerdict, findings: mergedFindings },
        ];
        persist();
      }

      const blocking = mergedFindings.filter((f) => f.severity === 'blocker' || f.severity === 'major');
      if (mergedVerdict === 'approve' || blocking.length === 0) break;

      ledger.loops.fixRounds = round;
      persist();
      if (round === ledger.loops.maxFixRounds) {
        // Same reasoning as the spec council: stage the work with the surviving
        // findings named, rather than deleting an hour of it because a reviewer
        // will not sign off. The validation GATE is different and still fails
        // the run — that one is objective.
        const surviving = blocking.map((f) => `[${f.severity}] ${f.title} (raised by ${f.by})`).join('; ');
        host.emit({
          type: 'note',
          stepId: reviewId,
          message:
            `fix loop exhausted after ${ledger.loops.maxFixRounds} rounds — staging anyway for human review, ` +
            `UNRESOLVED: ${surviving}`,
        });
        break;
      }
      reviewFindings = blocking;
    }

    /* ---------------- stage ---------------- */

    const allowlistPath = join(artifactDir, 'allowlist.txt');
    writeFileSync(allowlistPath, `${[...allowlist].sort().join('\n')}\n`, 'utf8');

    const stageError = await opPhase('stage', 'Stage', async () => {
      const result = await runtime.run('stage', [
        '--worktree',
        host.cwd,
        '--start-state',
        startStatePath,
        '--paths-file',
        allowlistPath,
      ]);
      if (!result.ok) {
        return {
          ok: false,
          error: `stage refused the handoff: ${(result.error ?? result.stderr ?? result.stdout ?? '').trim() || 'non-zero exit'}`,
        };
      }
      return { ok: true };
    });
    if (stageError === 'cancelled') return null;
    if (stageError) {
      ledger.stage = { ...ledger.stage, status: 'failed', error: stageError };
      persist();
      host.emit({ type: 'harness.stage.updated', stage: ledger.stage });
      return stageError;
    }

    ledger.stage = {
      status: 'staged',
      startStatePath,
      allowlistPath,
      stagedPaths: [...allowlist].sort(),
      suggestedCommit:
        suggestedCommit ?? (isFeature ? `feat: ${input.task.split('\n')[0]}` : `fix: ${input.task.split('\n')[0]}`),
      prBody: [
        `## Summary`,
        implementSummary ?? diagnosisSummary ?? input.task,
        ``,
        `## Validation`,
        ledger.validation.length === 0
          ? '- no validation commands configured'
          : ledger.validation.map((c) => `- \`${c.command}\` → ${c.status}`).join('\n'),
        ``,
        `Staged by the cezar harness driver (stage-only: no commit, push, or PR was created).`,
      ].join('\n'),
    };
    persist();
    host.emit({ type: 'harness.stage.updated', stage: ledger.stage });
    host.emit({
      type: 'note',
      message: 'staged handoff ready — review the diff, then commit/push/PR from the cockpit. HEAD, refs, and reflogs verified unchanged.',
    });
    return null;
  } finally {
    offInterrupt();
  }
}
