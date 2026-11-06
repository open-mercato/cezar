import { createHash, randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { copyFile, stat, utimes } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  councilDecisionDetail,
  createLedger,
  finishPhase,
  readLedger,
  saveLedger,
  startPhase,
} from './ledger.js';
import {
  HarnessRuntime,
  computeGateRegressions,
  exportTrustedConfig,
  harnessChildEnvironment,
  harnessConfigEnvironmentNames,
  loadAgenticConfig,
  loadAgenticConfigFile,
  reconcileHarnessProcess,
  copyTreeByValue,
  resolveHarnessScript,
  sealHarnessRuntimeFrom,
  harnessScriptDigest,
  runValidationCommands,
  type AgenticConfig,
  type HarnessOpResult,
  type HarnessProcessIdentity,
  type ReconcileHarnessProcessResult,
} from './runtime.js';
import { ignoreProvisioned } from '../skills-provision.js';
import { harnessCheckUnavailable, harnessCouncilRecordSchema, reconcileHarnessFindings } from '@open-mercato/cezar-contract';
import { harnessActionRevision, inspectHarnessEnvironment, projectedHarnessFindings } from './review-state.ts';
import {
  bundledSkillsDir,
  discoverSkillCandidates,
  parseFrontmatter,
  type Skill,
} from '../skills.js';
import { HARNESS_FIX_ISSUE, HARNESS_IMPLEMENT_FEATURE } from './workflows.js';
import type { ModelProber } from './probe.js';
import { opencodeSeatingError, synthesizeReviewerBinding } from './reviewer-binding.js';
import {
  MAX_PARALLEL_REVIEWERS,
  councilQuorum,
  isRetryableReviewerFailure,
  pool,
  REVIEWER_MUTATION_FAILURE,
  type CouncilOutcome,
} from './council-quorum.js';
import { providerFamilyOf, type HarnessRunner } from '@open-mercato/cezar-contract';
import { accountEnvironment, createProjectProber, probeAccounts } from './probe-transports.js';
import {
  HARNESS_DECISION_FINDING_MAX,
  HARNESS_DECISION_FINDINGS_MAX,
  validationCheckSchema,
} from './types.js';
import { canonicalizeAdvisorRefs } from './advisor-identity.js';
import {
  HARNESS_RESULT_LIMITS,
  promptBudgetError,
  promptExcerpt,
  boundedFindings,
  advisorCouncilTimeoutMs,
  advisorCouncilResultMaxBytes,
} from './prompt-budget.js';
import { harnessStageResultSchema, samePathSet } from './stage-result.js';
import { loadTrustedHarnessSkill } from './skill-binding.js';
import { acquireIssueClaim, issueClaimStaysHeld, releaseIssueClaim } from './issue-claim.js';
import { readHarnessFsEntry } from '../fs-read.js';
import { pinnedGitEnv, pinWorktreeGitDir, resolveTrustedGitDir, verifyWorktreeGitPointer } from '../git-pin.js';
import { harnessPhaseSkills } from './skill-routing.js';
import { isUsageLimitMessage } from '../core/usage-limit.js';
import { classifyAgentFailure } from '../core/agent-failure-class.js';
import { createClaudeStageOnlySettings } from './claude-guard.js';
import type {
  HarnessInvocation,
  HarnessLedger,
  HarnessProfile,
  HarnessSkillProfile,
  HarnessValidationCheck,
} from './types.js';

const HARNESS_JSON_ARTIFACT_MAX_BYTES = 2_000_000;

function readHarnessArtifactText(
  path: string,
  maxBytes = HARNESS_JSON_ARTIFACT_MAX_BYTES,
): string {
  const entry = readHarnessFsEntry(path, maxBytes);
  if (entry.kind !== 'file') throw new Error(`artifact is not a regular file: ${path}`);
  if (entry.content === null) {
    throw new Error(`artifact is ${entry.stat.size} bytes, exceeding the ${maxBytes}-byte safety limit`);
  }
  return entry.content.toString('utf8');
}

/**
 * The harness phase driver (spec 2026-07-23-harness-orchestration): cezar's
 * conductor for the cez-harness staged-only pipeline.
 *
 * Ownership is the whole design:
 *  - THIS module owns control flow — phase order, the bounded fix loop, the
 *    one automatic retry after a malformed phase result, resume-from-ledger,
 *    cancellation checks between phases;
 *  - the selected complete phase skills own judgment — generic Cezar
 *    playbooks by default, exact canonical om-* playbooks when explicitly
 *    selected. Every agent phase is a FRESH session (the host never passes a
 *    resumed transcript) whose brief is assembled from on-disk artifacts and
 *    whose exact skill tree is pinned;
 *  - the installed `harness.mjs` owns mechanics — capture and stage run
 *    verbatim, and their JSON artifacts stay authoritative.
 *
 * No LLM context outlives its phase: the "thread" a 12-hour desktop
 * conversation used to carry lives in the ledger and the artifact directory.
 */

export interface HarnessAgentPhaseRequest {
  phaseId: string;
  name: string;
  skill: string | undefined;
  prompt: string;
  resultPath: string;
  timeoutMs: number;
  env: Record<string, string>;
  /** Exact trusted skill prompt for a force-materialized bundled skill. When
   *  present the host must not resolve the normal local-first catalog entry. */
  skillSystemPrompt?: string;
  /** Role-based model routing (2026-07-24): the backend + model this phase
   *  runs on. Absent → the run's default (claude). */
  runner?: HarnessRunner;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** This phase runs BESIDE its siblings (council reviewers fan out in
   *  parallel, 2026-07-25) — the host must not let it claim the run's singular
   *  session slots, or the last one started would be the only one a Stop could
   *  reach. */
  concurrent?: boolean;
  onSpawn?: (pid: number) => void;
}

/** One concrete model a role runs on ('' = the backend's default model).
 *  `effort` is the role's reasoning dial (2026-07-24), mapped per backend on
 *  the runner seam; absent = the backend's default. */
export interface HarnessRoleRef {
  runner: HarnessRunner;
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
}

/** A reviewer bound in `agentHarness.models` (kimi-subscription, deepseek-api,
 *  a Zen preset…) — executed through the vendored runtime's review council,
 *  not a runner session (spec 2026-07-23-harness-orchestration). `model` is the
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
  cwd: string;
  dataDir: string;
  repoRoot: string;
  isCancelled(): boolean;
  emit(event: { type: string; stepId?: string; [k: string]: unknown }): void;
  runAgent(req: HarnessAgentPhaseRequest): Promise<string | null>;
  upsertStep(step: { id: string; name: string; kind: 'agent' | 'check' }): void;
  setStepStatus(
    stepId: string,
    status: 'pending' | 'running' | 'done' | 'failed' | 'skipped',
    error?: string,
  ): void;
  onInterrupt(fn: () => void): () => void;
  ensureSkill(name: string): Promise<boolean>;
}

interface RuntimeLike {
  run(
    op: string,
    args: string[],
    opts?: {
      timeoutMs?: number;
      onSpawn?: (identity: HarnessProcessIdentity) => void;
    },
  ): Promise<HarnessOpResult>;
  kill(): void;
}

/** Injectable seams (tests swap these; production uses the real modules). */
export interface HarnessDriverDeps {
  resolveScript?: (cwd: string) => string | null;
  /** Where the harness's own cez-* wrapper is copied from — ALWAYS, overwriting
   *  whatever the worktree holds (2026-07-28: catalog-resolved copies froze a
   *  stale runtime into four consecutive runs). `null` disables the refresh and
   *  falls back to `host.ensureSkill` (tests). Undefined → the real bundled dir. */
  bundledSkillsRoot?: string | null;
  /** Copy the preflight-pinned skill tree to the run's sealed runtime and
   *  return its path + digest (2026-07-27). */
  sealRuntime?: (skillsRoot: string, destDir: string) => { script: string; sha256: string } | null;
  scriptDigest?: (script: string) => string | null;
  createRuntime?: (opts: { script: string; cwd: string; env?: Record<string, string> }) => RuntimeLike;
  loadAgentic?: (cwd: string) => Promise<AgenticConfig>;
  loadAgenticFile?: (path: string) => Promise<AgenticConfig>;
  validate?: (
    commands: string[],
    cwd: string,
    opts?: Parameters<typeof runValidationCommands>[2],
  ) => Promise<HarnessValidationCheck[]>;
  exportConfig?: typeof exportTrustedConfig;
  createProber?: (opts: { advisors: Record<string, unknown>; cwd: string }) => ModelProber | Promise<ModelProber>;
  snapshotReviewSubject?: (cwd: string) => Promise<string>;
  snapshotStageSubject?: (cwd: string) => Promise<string>;
  /** Return the complete Git-derived changed-path set. The declared paths are
   *  supplied only so tests can model Git without creating a repository;
   *  production deliberately ignores them. */
  discoverChangedPaths?: (cwd: string, declaredPaths: readonly string[]) => string[] | null;
  discoverSkillCandidates?: (repoRoot: string, name: string) => Promise<Skill[]>;
  reconcileProcess?: (
    identity: HarnessProcessIdentity,
  ) => Promise<ReconcileHarnessProcessResult>;
  acquireClaim?: typeof acquireIssueClaim;
  releaseClaim?: typeof releaseIssueClaim;
}

export interface HarnessDriverInput {
  workflow: string;
  task: string;
  profile: HarnessProfile;
  /** Selects the complete judgment playbooks for every fixed graph phase.
   * Missing is the generic, project-neutral default. */
  skillProfile?: HarnessSkillProfile;
  issueId?: string;
  /** Role-based conduction (2026-07-24). Present → the driver runs every
   *  phase on its role's model and one fresh review pass per reviewer;
   *  absent → the legacy claude-only `standard` graph. */
  roles?: HarnessRolesInput;
  baseAcknowledgement?: {
    configuredBase: string;
    remoteDefault: string;
    reason: string;
  };
}

/** Display id of a role ref — `claude/sonnet`, `codex/auto`. */
export function roleRefId(ref: HarnessReviewerRef): string {
  return `${ref.runner}/${ref.model || 'auto'}`;
}

/**
 * Hash everything the worktree's CONTENT says relative to HEAD — deliberately
 * blind to the git index.
 *
 * The subject hashes used to serialize the index's view (`diff --cached`, the
 * unstaged diff, the untracked list). That made them representation-dependent:
 * `git add -N .` moves an untracked file out of the "others" list and into the
 * diff without changing a byte on disk, and cezar's own diff polling runs
 * exactly that in task worktrees. First cockpit poll after the spec phase wrote
 * its file, the "subject" changed mid-council, and all three reviewers were
 * rejected for a mutation nobody made (run 5f6fe8ae).
 *
 * What a reviewer actually reads is files, not the index. So: the candidate set
 * is every path `git status` lists (tracked-changed or untracked — the STATUS
 * CODES are discarded, only paths are kept, which is what makes `add -N`
 * invisible), and each path contributes its on-disk bytes. Content edits,
 * new files, deletions, and commits all still change the hash; index
 * choreography no longer can.
 */
function hashWorktreeContentVsHead(
  hash: ReturnType<typeof createHash>,
  cwd: string,
  git: (args: string[], env?: Record<string, string>) => Buffer,
  indexRoot?: string,
): void {
  hash.update('\0head\0');
  hash.update(git(['rev-parse', 'HEAD']));
  // Keep the private index beyond phases' writable temp roots.
  const gitDir = pinnedGitEnv(cwd)?.GIT_DIR ?? git(['rev-parse', '--absolute-git-dir']).toString('utf8').trim();
  const temporary = mkdtempSync(join(indexRoot ?? gitDir, 'cez-subject-index-'));
  let status: Buffer;
  const gitlinks = new Map<string, string>();
  try {
    const indexPath = join(temporary, 'index');
    const env = { GIT_INDEX_FILE: indexPath };
    const privateGit = (args: string[]) => git(['-c', 'core.splitIndex=false', '-c', 'advice.sparseIndexExpanded=false', ...args], env);
    try {
      const realIndex = join(gitDir, 'index');
      const { atime, mtime } = statSync(realIndex);
      copyFileSync(realIndex, indexPath);
      utimesSync(indexPath, atime, mtime);
    } catch {
      // A missing or unreadable index can still be seeded from HEAD.
    }
    normalizeHarnessIndex(cwd, privateGit);
    status = privateGit([
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--no-renames',
    ]);
    const directories = status.toString('utf8').split('\0').filter(Boolean).map((entry) => entry.slice(3).replace(/\/$/, '')).filter((path) => {
      try { return lstatSync(join(cwd, path)).isDirectory(); } catch { return false; }
    });
    // Snapshot gitlink commits through the same Git operation as staging.
    for (const batch of harnessPathBatches(directories)) privateGit(['add', '--sparse', '--no-warn-embedded-repo', '--', ...batch.map((path) => `:(literal)${path}`)]);
    if (directories.length) {
      for (const entry of privateGit(['ls-files', '--stage', '-z']).toString('utf8').split('\0')) {
        const match = /^160000 ([a-f0-9]+) 0\t(.*)$/s.exec(entry);
        if (match) gitlinks.set(match[2]!, match[1]!);
      }
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  const paths = status
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.slice(3))
    .sort();
  for (const path of paths) {
    hash.update('\0');
    hash.update(path);
    hash.update('\0');
    const absolute = join(cwd, path);
    try {
      const entry = readHarnessFsEntry(absolute);
      const gitlink = gitlinks.get(path.replace(/\/$/, ''));
      if (gitlink) hash.update(`gitlink:${gitlink}`);
      else if (entry.kind === 'symlink') hash.update(`symlink:${entry.target}`);
      else if (entry.kind === 'file') {
        // Git tracks the executable bit and file type as part of the reviewed change.
        hash.update(`file:${entry.stat.mode & 0o111 ? 'executable' : 'regular'}\0`);
        hash.update(entry.content!);
      }
      else hash.update(`mode:${entry.stat.mode}`);
    } catch {
      hash.update('absent'); // deleted from the worktree
    }
  }
}

export async function snapshotHarnessReviewSubject(cwd: string, indexRoot?: string): Promise<string> {
  const hash = createHash('sha256');
  const git = (args: string[], env?: Record<string, string>): Buffer =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      encoding: 'buffer',
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...pinnedGitEnv(cwd), ...env },
    });
  hashWorktreeContentVsHead(hash, cwd, git, indexRoot);
  hash.update('\0head-reflog\0');
  hash.update(git(['reflog', 'show', 'HEAD', '--format=%H%x09%gs']));
  return hash.digest('hex');
}

/** Stage reuse needs a subject invariant to moving the same bytes between the
 * worktree and index. `git diff HEAD` normalizes both states while untracked
 * files remain explicit, so a post-stage edit changes the hash but staging
 * itself does not. */
export async function snapshotHarnessStageSubject(cwd: string, indexRoot?: string): Promise<string> {
  const hash = createHash('sha256');
  const git = (args: string[], env?: Record<string, string>): Buffer =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      encoding: 'buffer',
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...pinnedGitEnv(cwd), ...env },
    });
  hashWorktreeContentVsHead(hash, cwd, git, indexRoot);
  return hash.digest('hex');
}

// Reserve argv room below Windows' 32 KiB and macOS's 1 MiB limits.
function harnessPathBatches(paths: readonly string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const size = Buffer.byteLength(path) + 1;
    if (batch.length && bytes + size > 16_384) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(path);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

// Share sparse/flag semantics between review subjects and staging.
export function normalizeHarnessIndex(cwd: string, git: (args: string[]) => Buffer): void {
  let sparse = false;
  try { sparse = git(['config', '--bool', 'core.sparseCheckout']).toString('utf8').trim() === 'true'; } catch {
    // An unset sparse-checkout option is the ordinary full worktree.
  }
  try { git(['read-tree', '--reset', 'HEAD']); } catch (error) {
    // Plain read-tree loses absent sparse entries' S bits.
    if (!sparse) git(['read-tree', 'HEAD']);
    else if (/index\.lock|another git process/i.test(String(error))) git(['read-tree', '--reset', 'HEAD']);
    else throw error;
  }
  const entries = git(['ls-files', '-v', '-z']).toString('utf8').split('\0').filter(Boolean);
  const clear = (flag: string, paths: string[]) => {
    for (const batch of harnessPathBatches(paths)) git(['update-index', flag, '--', ...batch]);
  };
  clear('--no-assume-unchanged', entries.filter((entry) => /^[a-z] /.test(entry)).map((entry) => entry.slice(2)));
  clear('--no-skip-worktree', entries.filter((entry) => {
    if (!/^[Ss] /.test(entry)) return false;
    if (!sparse) return true;
    try { lstatSync(join(cwd, entry.slice(2))); return true; } catch { return false; }
  }).map((entry) => entry.slice(2)));
}

/** Clear superseded staging without changing the captured HEAD reflog. */
export function resetIndexToHead(cwd: string): string | undefined {
  // Only a pinned harness worktree: never whatever repository happens to enclose `cwd`.
  const env = pinnedGitEnv(cwd);
  if (!env) return;
  const git = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
  });
  try {
    normalizeHarnessIndex(cwd, git);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// A private index preserves binary/untracked edits without touching the captured refs.
export async function harnessDiff(cwd: string, paths: readonly string[], indexPath: string): Promise<Buffer> {
  const pinned = pinnedGitEnv(cwd);
  if (!pinned) throw new Error('harness worktree has no pinned Git directory');
  const env = { ...process.env, ...pinned, GIT_INDEX_FILE: indexPath, GIT_TERMINAL_PROMPT: '0' };
  const git = async (args: string[]) => (await promisify(execFile)('git', ['-c', 'core.splitIndex=false', '-c', 'advice.sparseIndexExpanded=false', ...args], {
    cwd, env, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024,
  })).stdout;
  try {
    let sparse = false;
    try { sparse = (await git(['config', '--bool', 'core.sparseCheckout'])).toString('utf8').trim() === 'true'; } catch { /* unset */ }
    let seeded = false;
    if (sparse || paths.length === 0) {
      try {
        // Preserve the stat cache, including its timestamp boundary.
        const realIndex = join(pinned.GIT_DIR!, 'index');
        const { atime, mtime } = await stat(realIndex);
        await copyFile(realIndex, indexPath);
        await utimes(indexPath, atime, mtime);
        seeded = true;
      } catch (error) {
        if (sparse) throw error;
        // A missing or unreadable full index can still be seeded from HEAD.
      }
    }
    if (!seeded) await git(['read-tree', 'HEAD']);
    if (sparse) normalizeHarnessIndex(cwd, (args) => execFileSync('git', [
      '-c', 'core.splitIndex=false', '-c', 'advice.sparseIndexExpanded=false', ...args,
    ], { cwd, env, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
    const skipped = new Set(sparse ? (await git(['ls-files', '-v', '-z'])).toString('utf8')
      .split('\0').filter((entry) => /^[Ss] /.test(entry)).map((entry) => entry.slice(2)) : []);
    const scopes: string[] = [];
    const deletions: string[] = [];
    for (const path of paths) {
      let present = false;
      try { lstatSync(join(cwd, path)); present = true; } catch {
        const tracked = (await git(['ls-files', '-z', '--', `:(literal)${path}`])).toString('utf8').split('\0').filter(Boolean);
        present = tracked.some((entry) => !skipped.has(entry));
        if (sparse && tracked.includes(path) && !skipped.has(path)) {
          deletions.push(path);
          present = false;
        }
      }
      if (present) scopes.push(`:(literal)${path}`);
    }
    for (const batch of harnessPathBatches(deletions)) await git(['update-index', '--force-remove', '--', ...batch]);
    const add = ['add', '-A', ...(sparse ? ['--sparse'] : [])];
    if (paths.length === 0) await git(add);
    else for (const batch of harnessPathBatches(scopes)) await git([...add, '--', ...batch]);
    // This private index contains only the selected scopes.
    return await git(['diff', '--cached', '--no-ext-diff', '--binary', 'HEAD', '--']);
  } finally {
    rmSync(indexPath, { force: true });
    rmSync(`${indexPath}.lock`, { force: true });
  }
}

function currentChangedPaths(cwd: string): string[] | null {
  try {
    const tracked = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'diff', '--no-renames', '--name-only', '-z', 'HEAD', '--'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...pinnedGitEnv(cwd) },
    })
      .split('\0')
      .filter(Boolean);
    const untracked = execFileSync(
      'git',
      ['-c', 'core.hooksPath=/dev/null', 'ls-files', '--others', '--exclude-standard', '-z', '--'],
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...pinnedGitEnv(cwd) },
      },
    )
      .split('\0')
      .filter(Boolean);
    return [...new Set([...tracked, ...untracked].map((path) => path.replace(/\/$/, '')))].sort();
  } catch {
    return null;
  }
}

const advisorInvocationId = (op: { kindTag: string; round: number }, member: { label: string }): string =>
  `advisor:${op.kindTag}:${op.round}:${member.label}`;

/** The independence axis a council quorum counts. Delegates to the ONE shared
 *  definition (review 2026-07-27): returning `ref.runner` here counted a host
 *  `claude/sonnet` reviewer and a gateway-resold `opencode/claude-sonnet-4-5`
 *  reviewer as two families, certifying two Anthropic models as an independent
 *  cross-check — and it disagreed with the admission check that let them in. */
export function councilFamilyOf(ref: HarnessReviewerRef): string {
  return isAdvisorRef(ref) ? ref.family : providerFamilyOf(ref);
}

const qualifyResultSchema = z.object({
  outcome: z.enum(['work_needed', 'no_action']),
  evidence: z.string().transform((value) => value.slice(0, HARNESS_RESULT_LIMITS.summary)),
});

const diagnoseResultSchema = z.object({
  summary: z.string().max(HARNESS_RESULT_LIMITS.summary),
  files: z
    .array(z.string().min(1).max(HARNESS_RESULT_LIMITS.path))
    .transform((paths) => paths.slice(0, HARNESS_RESULT_LIMITS.paths)),
  regressionTest: z.string().max(HARNESS_RESULT_LIMITS.text).optional(),
});

const specResultSchema = z.object({
  summary: z.string().max(HARNESS_RESULT_LIMITS.summary),
  specPath: z.string().min(1).max(HARNESS_RESULT_LIMITS.path),
  files: z
    .array(z.string().min(1).max(HARNESS_RESULT_LIMITS.path))
    .transform((paths) => paths.slice(0, HARNESS_RESULT_LIMITS.paths))
    .optional(),
  openQuestions: z
    .array(z.string().min(1).max(HARNESS_RESULT_LIMITS.text))
    .transform((questions) => questions.slice(0, HARNESS_RESULT_LIMITS.questions))
    .optional(),
});

const preImplementResultSchema = z.object({
  status: z.enum(['ready', 'blocked']),
  summary: z.string().transform((value) => value.slice(0, HARNESS_RESULT_LIMITS.summary)),
  reportPath: z.string().min(1).max(HARNESS_RESULT_LIMITS.path),
  findings: z
    .array(
      z.object({
        severity: z.enum(['blocker', 'major', 'minor', 'nit']),
        title: z.string().min(1).transform((value) => value.slice(0, HARNESS_RESULT_LIMITS.shortText)),
        evidence: z.string().transform((value) => value.slice(0, HARNESS_RESULT_LIMITS.text)).default(''),
      }),
    )
    .default([])
    .transform((findings) => [...findings]
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
      .slice(0, HARNESS_RESULT_LIMITS.findings)),
});

// Changed paths are allowlist hints: git derives the complete handoff, so a long list is clamped,
// never a contract failure.
const clampPaths = (paths: string[]): string[] => paths.slice(0, HARNESS_RESULT_LIMITS.paths);

const implementResultSchema = z.object({
  changedPaths: z
    .array(z.string().min(1).max(HARNESS_RESULT_LIMITS.path))
    .min(1)
    .transform(clampPaths),
  summary: z.string().max(HARNESS_RESULT_LIMITS.summary).optional(),
  suggestedCommit: z.string().max(HARNESS_RESULT_LIMITS.shortText).optional(),
});

const fixResultSchema = implementResultSchema.extend({
  changedPaths: z.array(z.string().min(1).max(HARNESS_RESULT_LIMITS.path)).transform(clampPaths),
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
    z.string().transform((location) => location.slice(0, HARNESS_RESULT_LIMITS.path)),
    z
      .object({
        path: z.string().max(HARNESS_RESULT_LIMITS.path),
        line: z.number().int().nullable().optional(),
        symbol: z.string().max(HARNESS_RESULT_LIMITS.shortText).nullable().optional(),
      })
      .passthrough(),
  ])
  .transform((loc) => {
    if (typeof loc === 'string') return loc;
    const base = loc.line == null ? loc.path : `${loc.path}:${loc.line}`;
    return (loc.symbol ? `${base} (${loc.symbol})` : base).slice(0, HARNESS_RESULT_LIMITS.path);
  });

const reviewResultSchema = z.object({
  verdict: z.enum(['approve', 'request_changes']),
  findings: z
    .array(
      z.object({
        severity: z.enum(['blocker', 'major', 'minor', 'nit']),
        title: z.string().min(1).transform((title) => title.slice(0, HARNESS_RESULT_LIMITS.shortText)),
        location: findingLocationSchema.optional().catch(undefined),
        evidence: z.string().transform((evidence) => evidence.slice(0, HARNESS_RESULT_LIMITS.text)).optional(),
      }),
    )
    .default([])
    .transform((findings) => [...findings]
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
      .slice(0, HARNESS_RESULT_LIMITS.findings)),
});

type ReviewResult = z.infer<typeof reviewResultSchema>;

/**
 * A review verdict is DERIVED data, never a model's opinion of its own work:
 * any blocker/major finding means `request_changes`. The vendored runtime has
 * always coerced advisor reviews this way (harness.mjs `normalizeReview`); the
 * driver's own session reviewers were trusted at their word, so a reviewer that
 * listed a blocker and still labelled the pass "approve" ended the fix loop and
 * staged the run as ready. Same rule, both transports.
 */
export function mechanicalVerdict(
  findings: readonly { severity: string }[],
): 'approve' | 'request_changes' {
  return findings.some((f) => f.severity === 'blocker' || f.severity === 'major')
    ? 'request_changes'
    : 'approve';
}

function coerceReviewVerdict(result: {
  verdict: 'approve' | 'request_changes';
  findings?: readonly { severity: string }[];
}): {
  verdict: 'approve' | 'request_changes';
  coercedFrom: 'approve' | 'request_changes' | null;
} {
  const verdict = mechanicalVerdict(result.findings ?? []);
  return { verdict, coercedFrom: verdict === result.verdict ? null : result.verdict };
}

const SEVERITY_RANK = { blocker: 0, major: 1, minor: 2, nit: 3 } as const;

/** An advisor review as the runtime merged it, with no bounds of its own: clamped rather than
 *  rejected, keeping the most severe findings when it must drop some. */
const advisorReviewSchema = reviewResultSchema;

/** The runtime's `review-result.json`, reduced to what the driver folds into
 *  the council: per-advisor status plus the session-shaped review payload
 *  (spec 2026-07-23-harness-orchestration). Loose on purpose — the runtime's own
 *  schema is authoritative; unknown keys pass through untouched. */
const councilResultSchema = z
  .object({
    verdict: z.enum(['approve', 'request_changes']).nullable().optional(),
    reviewContract: z
      .object({
        subjectSha256: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
    reviewers: z
      .array(
        z
          .object({
            id: z.string(),
            status: z.string(),
            // Parsed per row: one advisor's unreadable review fails that advisor alone.
            review: z.unknown().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

const COUNCIL_SUBJECT_CHANGED_ERROR =
  'the current worktree review subject changed while the advisor council was running; ' +
  'every result from this council was rejected because cezar cannot attribute a shared ' +
  'subject change to an individual reviewer; the changed subject was preserved for manual recovery';

const isCouncilSubjectChangedError = (error: string | undefined): boolean =>
  error === COUNCIL_SUBJECT_CHANGED_ERROR ||
  error ===
    'advisor reviewer mutated the worktree or index; every result from this council was rejected and the changed subject was preserved for manual recovery';

/* Phase timeouts (spec: implement gets hours, qualify minutes)        */

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
  // The non-interactive clause exists because a skill CAN mandate the opposite.
  // om-spec-writing carries a hard Open Questions gate ("present the open
  // questions to the user and stop"), and a spec session followed it faithfully
  // — twice, once per attempt — ending each turn with a CEZ:ASK nobody could
  // ever answer and no result file. The phase contract must outrank the skill
  // here, and must say HOW the gate is satisfied instead, or the model is left
  // choosing between disobeying the skill and failing the phase.
  '- This session is NON-INTERACTIVE: no human reads it live, and questions cannot be answered. Never end a turn to ask the user something, and never emit CEZ:ASK.',
  '- When a skill requires user answers before proceeding (an Open Questions gate, a confirmation step), satisfy it autonomously: pick the most defensible answer yourself, record each question and the assumption you chose inside the artifact you produce, and continue. Surface them in the result file when its shape allows.',
  '- Write the result JSON file (path given above) BEFORE ending your final turn; a turn that ends without it fails the phase after at most one retry.',
].join('\n');

const PHASE_TIMEOUTS_MS: Record<string, number> = {
  qualify: 20 * 60_000,
  diagnose: 45 * 60_000,
  spec: 60 * 60_000,
  implement: 3 * 60 * 60_000,
  fix: 90 * 60_000,
  review: 30 * 60_000,
};

const UNAPPLIED_MESSAGES_REASON =
  'operator messages arrived after the final safe agent boundary and were not applied: ';

export function harnessArtifactDir(dataDir: string, runId: string): string {
  return join(dataDir, 'runs', `${runId}-harness`);
}

/** The only model-writable part of the durable harness artifact tree. Cezar
 * keeps ledgers, trusted skills/config and validation evidence in the parent,
 * outside this boundary. */
export function harnessAgentOutputDir(dataDir: string, runId: string): string {
  return join(harnessArtifactDir(dataDir, runId), 'agent-output');
}

/** Executes the harness phase graph. Returns an error message (run fails),
 *  or null — success, cancellation, and the no-action early stop all settle
 *  through the caller's normal paths. */
export async function runHarnessDriver(
  host: HarnessDriverHost,
  input: HarnessDriverInput,
  deps: HarnessDriverDeps = {},
): Promise<string | null> {
  if (process.env.CEZ_DRY_RUN === '1') {
    return 'Multi-model harness execution is unavailable with CEZ_DRY_RUN=1; dry-run mode does not perform live model calls or simulate completed reviews.';
  }
  const resolveScript = deps.resolveScript ?? resolveHarnessScript;
  const sealRuntime = deps.sealRuntime ?? sealHarnessRuntimeFrom;
  const scriptDigest = deps.scriptDigest ?? harnessScriptDigest;
  const createRuntime = deps.createRuntime ?? ((opts) => new HarnessRuntime(opts));
  const loadAgentic = deps.loadAgentic ?? loadAgenticConfig;
  const loadAgenticFile = deps.loadAgenticFile ?? loadAgenticConfigFile;
  const validate =
    deps.validate ??
    ((commands, cwd, opts) => runValidationCommands(commands, cwd, opts));
  const exportConfig = deps.exportConfig ?? exportTrustedConfig;
  const snapshotReviewSubject = deps.snapshotReviewSubject ?? ((cwd: string) => snapshotHarnessReviewSubject(cwd, artifactDir));
  const snapshotStageSubject = deps.snapshotStageSubject ?? ((cwd: string) => snapshotHarnessStageSubject(cwd, artifactDir));
  const discoverChangedPaths =
    deps.discoverChangedPaths ?? ((cwd: string) => currentChangedPaths(cwd));
  const discoverCandidates = deps.discoverSkillCandidates ?? discoverSkillCandidates;
  const reconcileProcess = deps.reconcileProcess ?? reconcileHarnessProcess;
  const acquireClaim = deps.acquireClaim ?? acquireIssueClaim;
  const releaseClaim = deps.releaseClaim ?? releaseIssueClaim;
  const createProber =
    deps.createProber ??
    ((opts: { advisors: Record<string, unknown>; cwd: string }) =>
      createProjectProber({ repoRoot: host.repoRoot, cwd: opts.cwd, advisors: opts.advisors }));

  const artifactDir = harnessArtifactDir(host.dataDir, host.runId);
  mkdirSync(artifactDir, { recursive: true });
  const agentOutputDir = harnessAgentOutputDir(host.dataDir, host.runId);
  mkdirSync(agentOutputDir, { recursive: true });
  const phaseLocationContract = (skill: string | undefined, outputDir: string): string =>
    [
      'Harness location contract:',
      `- Active repository root: ${host.cwd}. Use repo-relative paths from this directory; it is the only checkout this phase may inspect or edit.`,
      ...(host.repoRoot !== host.cwd
        ? [
            `- The original checkout at ${host.repoRoot} is not this phase's subject. Do not read from or write to it.`,
          ]
        : []),
      `- Phase-output directory: ${outputDir}. Use the exact spec, report, and result paths supplied in the task; never derive a sibling path or append "-harness" to the worktree.`,
      ...(skill
        ? [
            `- The complete ${skill} playbook is already injected in your system instructions. Follow it directly; do not invoke the Skill tool or read a SKILL.md file.`,
          ]
        : []),
    ].join('\n');
  const noGitHubAuthDir = join(artifactDir, 'no-github-auth');
  mkdirSync(noGitHubAuthDir, { recursive: true });
  // One guard per output directory: each session's sandbox may write its own directory only.
  const claudeGuards = new Map<string, ReturnType<typeof createClaudeStageOnlySettings>>();
  // Resolved from the main repository, never through the worktree's model-writable `.git`
  // pointer; every host-side git call here and in the runtime uses it (git-pin.ts).
  const trustedGitDir = resolveTrustedGitDir(host.repoRoot, host.cwd);
  if (trustedGitDir) pinWorktreeGitDir(host.cwd, trustedGitDir);
  const gitPointerIssue = (): string | null => {
    if (!trustedGitDir) return null;
    const check = verifyWorktreeGitPointer(host.cwd, trustedGitDir);
    return check.ok ? null : check.error;
  };
  const entryPointerIssue = gitPointerIssue();
  if (entryPointerIssue) return entryPointerIssue;
  /** Failures that are evidence against the phase, not a runner that could not deliver. */
  const integrityFailures = new Set<string>();

  const ledgerRead = readLedger(host.dataDir, host.runId);
  if (ledgerRead.status === 'corrupt') {
    return `harness recovery blocked: ledger is corrupt (${ledgerRead.error}); restore or remove it explicitly before retrying`;
  }
  if (ledgerRead.status === 'unsupported') {
    return `harness recovery blocked: ledger version ${String(ledgerRead.version)} is newer than this cezar`;
  }
  if (ledgerRead.status === 'valid' && ledgerRead.ledger.workflow !== input.workflow) {
    return `harness recovery blocked: ledger belongs to ${ledgerRead.ledger.workflow}, not ${input.workflow}`;
  }
  if (ledgerRead.status === 'valid' && ledgerRead.ledger.requestedProfile !== input.profile) {
    return `harness recovery blocked: ledger requested ${ledgerRead.ledger.requestedProfile}, not ${input.profile}`;
  }
  // `skillProfile` did not exist before the selector. Every ledger from that
  // era used the canonical om-* phase skills, including ledgers interrupted
  // before preflight had pinned any skill names. Treating an empty legacy
  // ledger as generic would silently switch its playbooks on recovery.
  const legacySkillProfile = (ledger: HarnessLedger): HarnessSkillProfile =>
    ledger.skillProfile ?? 'open-mercato';
  const recordedSkillProfile =
    ledgerRead.status === 'valid' ? legacySkillProfile(ledgerRead.ledger) : undefined;
  const skillProfile = input.skillProfile ?? recordedSkillProfile ?? 'generic';
  if (
    ledgerRead.status === 'valid' &&
    recordedSkillProfile !== undefined &&
    recordedSkillProfile !== skillProfile
  ) {
    return (
      `harness recovery blocked: ledger uses the "${recordedSkillProfile}" skill profile, ` +
      `not "${skillProfile}"`
    );
  }
  const ledger: HarnessLedger =
    ledgerRead.status === 'valid'
      ? ledgerRead.ledger
      : createLedger({
          workflow: input.workflow,
          requestedProfile: input.profile,
          skillProfile,
          subject: input.issueId
            ? { kind: 'issue', id: input.issueId, text: input.task }
            : { kind: 'brief', text: input.task },
        });
  ledger.skillProfile ??= skillProfile;
  const mergeOperatorMutations = (): void => {
    const current = readLedger(host.dataDir, host.runId);
    if (current.status !== 'valid' || current.ledger === ledger) return;
    for (const external of current.ledger.pendingMessages) {
      const local = ledger.pendingMessages.find((message) => message.id === external.id);
      if (!local) {
        ledger.pendingMessages.push(external);
      } else {
        if (external.assignedToPhaseId && !local.assignedToPhaseId) {
          local.assignedToPhaseId = external.assignedToPhaseId;
        }
        if (external.consumedAt && !local.consumedAt) {
          local.consumedAt = external.consumedAt;
          local.consumedByPhaseId = external.consumedByPhaseId;
        }
      }
    }
    const decisionKeys = new Set(
      ledger.decisions.map((decision) =>
        JSON.stringify([decision.at, decision.kind, decision.by, decision.detail ?? null]),
      ),
    );
    for (const decision of current.ledger.decisions) {
      const key = JSON.stringify([
        decision.at,
        decision.kind,
        decision.by,
        decision.detail ?? null,
      ]);
      if (!decisionKeys.has(key)) {
        ledger.decisions.push(decision);
        decisionKeys.add(key);
      }
    }
    if (
      current.ledger.outcome.acceptedAt &&
      !ledger.outcome.acceptedAt &&
      ledger.outcome.status === 'contested' &&
      current.ledger.outcome.status === 'contested' &&
      JSON.stringify(current.ledger.outcome.blockingReasons) ===
        JSON.stringify(ledger.outcome.blockingReasons)
    ) {
      ledger.outcome.acceptedAt = current.ledger.outcome.acceptedAt;
      ledger.outcome.acceptedBy = current.ledger.outcome.acceptedBy;
      ledger.outcome.acceptanceReason = current.ledger.outcome.acceptanceReason;
    }
  };
  const persist = () => {
    mergeOperatorMutations();
    saveLedger(host.dataDir, host.runId, ledger);
  };
  const setOutcome = (outcome: HarnessLedger['outcome']): void => {
    ledger.outcome = outcome;
    persist();
    host.emit({ type: 'harness.outcome.updated', outcome: ledger.outcome, actionRevision: harnessActionRevision(ledger) });
    if (ledger.reviewAction) host.emit({ type: 'harness.review-action.updated', action: ledger.reviewAction, actionRevision: harnessActionRevision(ledger) });
  };
  // A model's findings fit the result contract, not the ledger's decision bounds; one over-long
  // entry used to leave a ledger its own reader rejected.
  const decisionFindings = (findings: readonly string[], fallback: string): string[] => {
    const bounded = (findings.length > 0 ? findings : [fallback])
      .slice(0, HARNESS_DECISION_FINDINGS_MAX)
      .map((finding) =>
        finding.length > HARNESS_DECISION_FINDING_MAX
          ? `${finding.slice(0, HARNESS_DECISION_FINDING_MAX - 1)}…`
          : finding,
      )
      .filter((finding) => finding.trim().length > 0);
    return bounded.length > 0 ? bounded : ['the pre-implementation audit reported unresolved risks'];
  };
  const releaseHeldIssueClaim = (): void => {
    if (!ledger.claim?.held || !ledger.claim.path) return;
    const released = releaseClaim(ledger.claim.path, host.runId);
    if (!released.ok) {
      host.emit({ type: 'note', message: `issue claim release failed: ${released.error}` });
      return;
    }
    ledger.claim.held = false;
    persist();
  };
  const upsertCouncil = (
    kind: string,
    round: number,
    council: Record<string, unknown>,
  ): void => {
    ledger.councils = [
      ...ledger.councils.filter(
        (entry) => entry.kind !== kind || entry.round !== round,
      ),
      council,
    ];
    const parsed = harnessCouncilRecordSchema.safeParse(council);
    if (parsed.success) {
      ledger.findingHistory = reconcileHarnessFindings(ledger.findingHistory ?? [], parsed.data, ledger.validation);
      host.emit({ type: 'harness.findings.updated', findings: ledger.findingHistory });
    }
  };
  // A stage blocked on unapplied messages hands every one to this resume as feedback, assigned or
  // not: the phase that took one may never run again, and the block had no other exit.
  const blockedOnMessages =
    ledger.outcome.status === 'blocked' &&
    ledger.outcome.blockingReasons.some((reason) => reason.startsWith(UNAPPLIED_MESSAGES_REASON));
  // A block without a pending decision is re-derived by this entry; left in
  // place it outlived a clean resume, and staging promotes only `pending`.
  if (ledger.outcome.status === 'blocked' && !ledger.outcome.pendingDecision) {
    setOutcome({ status: 'pending', blockingReasons: [] });
  }
  for (const invocation of ledger.invocations.filter((entry) => entry.status === 'running')) {
    if (invocation.process) {
      const reconciliation = await reconcileProcess(invocation.process);
      // `mismatch` proves the pid now runs another process: ours is gone, and a pid is not reused
      // while its group lives. Blocking on it dead-ended every Continue.
      if (reconciliation.status === 'unverified') {
        const error = `harness recovery blocked: ${reconciliation.error}`;
        setOutcome({ status: 'blocked', blockingReasons: [error] });
        return error;
      }
    }
    invocation.status = 'interrupted';
    invocation.endedAt = new Date().toISOString();
    invocation.durationMs =
      invocation.startedAt === undefined
        ? 0
        : Math.max(0, Date.parse(invocation.endedAt) - Date.parse(invocation.startedAt));
    invocation.error = 'recovered after the prior Cezar process ended before invocation completion';
    invocation.process = undefined;
    persist();
    host.emit({
      type: 'harness.invocation.updated',
      stepId: invocation.phaseId,
      invocation,
    });
  }
  if (
    input.baseAcknowledgement &&
    !ledger.decisions.some((decision) => decision.kind === 'accept-stale-base')
  ) {
    ledger.decisions.push({
      at: new Date().toISOString(),
      kind: 'accept-stale-base',
      by: 'user',
      detail:
        `${input.baseAcknowledgement.configuredBase} vs ${input.baseAcknowledgement.remoteDefault}: ` +
        input.baseAcknowledgement.reason,
    });
    persist();
  }

  const sha256 = (value: string | Buffer): string =>
    createHash('sha256').update(value).digest('hex');
  const hashFile = (path: string, maxBytes = HARNESS_JSON_ARTIFACT_MAX_BYTES * 4): string | null => {
    try {
      const entry = readHarnessFsEntry(path, maxBytes);
      return entry.kind === 'file' && entry.content !== null ? sha256(entry.content) : null;
    } catch {
      return null;
    }
  };
  const writeJsonAtomic = (path: string, value: unknown): void => {
    const tmp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(tmp, path);
  };
  const emitInvocation = (invocation: HarnessInvocation): void => {
    host.emit({ type: 'harness.invocation.updated', stepId: invocation.phaseId, invocation });
  };
  const reusableInvocation = <T>(
    id: string,
    inputSha256: string,
    schema: z.ZodType<T>,
    maxBytes = HARNESS_JSON_ARTIFACT_MAX_BYTES,
  ): T | null => {
    const invocation = ledger.invocations.find((entry) => entry.id === id);
    if (
      !invocation ||
      invocation.status !== 'completed' ||
      invocation.inputSha256 !== inputSha256 ||
      !invocation.artifactPath ||
      !invocation.artifactSha256
    ) {
      return null;
    }
    const bytesHash = hashFile(invocation.artifactPath, Math.max(HARNESS_JSON_ARTIFACT_MAX_BYTES * 4, maxBytes));
    if (bytesHash !== invocation.artifactSha256) {
      invocation.status = 'interrupted';
      invocation.error = 'completed invocation artifact is missing or changed';
      invocation.endedAt = new Date().toISOString();
      persist();
      emitInvocation(invocation);
      return null;
    }
    try {
      const parsed = schema.safeParse(JSON.parse(readHarnessArtifactText(invocation.artifactPath, maxBytes)));
      if (parsed.success) return parsed.data;
    } catch {
    }
    invocation.status = 'interrupted';
    invocation.error = 'completed invocation artifact is not valid JSON for this operation';
    invocation.endedAt = new Date().toISOString();
    persist();
    emitInvocation(invocation);
    return null;
  };
  // Undelivered attempts spend no contract budget, including persisted advisor/older transient
  // failures; a demoted completed artifact still counts.
  const consumedAttempts = (invocation: HarnessInvocation): number =>
    (invocation.status === 'interrupted' ||
      (invocation.status === 'failed' && invocation.role === 'reviewer' &&
        classifyAgentFailure(invocation.error) === 'transient')) &&
    invocation.artifactSha256 === undefined
      ? invocation.attempt - 1
      : invocation.attempt;
  const attemptsForInput = (id: string, inputSha256: string): number => {
    const invocation = ledger.invocations.find((entry) => entry.id === id);
    return invocation?.inputSha256 === inputSha256 ? consumedAttempts(invocation) : 0;
  };
  const beginInvocation = (init: {
    id: string;
    phaseId: string;
    role: string;
    reviewerId?: string;
    binding: HarnessInvocation['binding'];
    inputSha256: string;
    prompt?: string;
    promptPath?: string;
  }): HarnessInvocation => {
    const now = new Date().toISOString();
    const existing = ledger.invocations.find((entry) => entry.id === init.id);
    const invocation: HarnessInvocation = existing ?? {
      ...init,
      status: 'pending',
      attempt: 0,
    };
    if (!existing) ledger.invocations.push(invocation);
    if (existing) {
      invocation.attempt =
        existing.inputSha256 === init.inputSha256 ? consumedAttempts(existing) : 0;
    }
    invocation.phaseId = init.phaseId;
    invocation.role = init.role;
    invocation.reviewerId = init.reviewerId;
    invocation.binding = init.binding;
    invocation.inputSha256 = init.inputSha256;
    invocation.status = 'running';
    invocation.attempt += 1;
    invocation.startedAt = now;
    invocation.endedAt = undefined;
    invocation.durationMs = undefined;
    invocation.artifactPath = undefined;
    invocation.artifactSha256 = undefined;
    invocation.error = undefined;
    invocation.process = undefined;
    if (init.promptPath) {
      invocation.promptPath = init.promptPath;
    } else if (init.prompt !== undefined) {
      const promptPath = join(artifactDir, `invocation-${sha256(init.id).slice(0, 20)}-prompt.md`);
      try {
        writeFileSync(promptPath, init.prompt, 'utf8');
        invocation.promptPath = promptPath;
      } catch {
      }
    }
    persist();
    emitInvocation(invocation);
    return invocation;
  };
  const finishInvocation = (
    invocation: HarnessInvocation,
    status: 'completed' | 'failed' | 'interrupted',
    opts: {
      artifactPath?: string;
      artifactMaxBytes?: number;
      error?: string;
      modelId?: string;
      persistNow?: boolean;
    } = {},
  ): void => {
    invocation.status = status;
    invocation.endedAt = new Date().toISOString();
    invocation.durationMs =
      invocation.startedAt === undefined
        ? 0
        : Math.max(0, Date.parse(invocation.endedAt) - Date.parse(invocation.startedAt));
    invocation.error = opts.error;
    invocation.process = undefined;
    if (opts.artifactPath) {
      invocation.artifactPath = opts.artifactPath;
      invocation.artifactSha256 = hashFile(opts.artifactPath, opts.artifactMaxBytes) ?? undefined;
    }
    if (status === 'completed' && opts.modelId) {
      const model = ledger.models.find((entry) => entry.id === opts.modelId);
      if (model) {
        model.invocations += 1;
        model.totalDurationMs += invocation.durationMs ?? 0;
      }
    }
    if (opts.persistNow !== false) {
      persist();
      emitInvocation(invocation);
    }
  };
  const runAgentInvocation = async (
    invocation: HarnessInvocation,
    request: HarnessAgentPhaseRequest,
  ): Promise<string | null> => {
    if (host.isCancelled()) return 'run cancelled';
    let guardEnv: Record<string, string> = {};
    // A phase without a role runs on Claude, and says so: left unset it fell to the task's runner
    // (OpenCode, Cursor…) with no guard or sandbox, while the ledger recorded Claude.
    const runner = request.runner ?? 'claude';
    const outputDir = dirname(request.resultPath);
    if (runner === 'claude') {
      try {
        let guard = claudeGuards.get(outputDir);
        if (!guard) {
          guard = createClaudeStageOnlySettings(artifactDir, host.cwd, outputDir);
          claudeGuards.set(outputDir, guard);
        }
        guardEnv = guard.env;
      } catch (error) {
        return `Claude stage-only sandbox unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const token = randomUUID();
    const trustedPrompt =
      request.skillSystemPrompt ??
      (request.skill ? trustedSkillPrompts.get(request.skill) : undefined);
    // An agent CLI runs its own git outside the tool sandbox at session start: check the pointer
    // before every phase, and after it before any host-side git reads the worktree.
    const pointerBefore = gitPointerIssue();
    if (pointerBefore) {
      integrityFailures.add(pointerBefore);
      return pointerBefore;
    }
    const failure = await host.runAgent({
      ...request,
      runner,
      ...(trustedPrompt ? { skillSystemPrompt: trustedPrompt } : {}),
      env: {
        ...request.env,
        ...guardEnv,
        CEZ_PROCESS_TOKEN: token,
        CEZ_HARNESS_STAGE_ONLY: '1',
        // The one directory outside the worktree a stage-only phase may write: its own, so no
        // session can write another reviewer's verdict.
        CEZ_HARNESS_OUTPUT_DIR: outputDir,
        GIT_ALLOW_PROTOCOL: '',
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '/usr/bin/false',
        SSH_ASKPASS: '/usr/bin/false',
        SSH_AUTH_SOCK: '',
        GH_CONFIG_DIR: noGitHubAuthDir,
      },
      onSpawn: (pid) => {
        invocation.process = {
          pid,
          token,
          startedAt: new Date().toISOString(),
          // Runner sessions are not group leaders: recovery signals the pid alone.
          group: false,
        };
        persist();
        emitInvocation(invocation);
      },
    });
    const pointerAfter = gitPointerIssue();
    if (pointerAfter) integrityFailures.add(pointerAfter);
    return pointerAfter ?? failure;
  };

  const emitPhase = (phaseId: string) => {
    const phase = ledger.phases.find((p) => p.id === phaseId);
    if (phase) host.emit({ type: 'harness.phase.updated', stepId: phaseId, phase });
  };

  const phaseDone = (id: string) => ledger.phases.find((p) => p.id === id)?.status === 'done';

  const invalidateFollowingPhases = (phaseId: string): void => {
    const at = ledger.phases.findIndex((phase) => phase.id === phaseId);
    if (at < 0) return;
    for (const phase of ledger.phases.slice(at + 1)) {
      phase.status = 'pending';
      phase.startedAt = undefined;
      phase.endedAt = undefined;
      phase.error = undefined;
      if (phase.id === 'baseline-gate') ledger.baselineValidation = undefined;
    }
    ledger.validation = [];
    ledger.stage = { status: 'pending' };
    ledger.outcome = { status: 'pending', blockingReasons: [] };
    persist();
  };

  const feedback = ledger.pendingMessages.filter(
    (message) => !message.consumedAt && (!message.assignedToPhaseId || blockedOnMessages),
  );
  const feedbackPhase = ledger.outcome.status === 'no-action'
    ? 'qualify'
    : phaseDone('implement')
      ? 'implement'
      : undefined;
  if (feedback.length > 0 && feedbackPhase) {
    const phase = ledger.phases.find((entry) => entry.id === feedbackPhase);
    if (!phase) {
      return `harness feedback recovery blocked: the ledger has no ${feedbackPhase} phase to resume`;
    }
    const start = ledger.phases.indexOf(phase);
    const invalidated = new Set(ledger.phases.slice(start).map((phase) => phase.id));
    for (const invocation of ledger.invocations) {
      if (!invalidated.has(invocation.phaseId)) continue;
      invocation.status = 'interrupted';
      invocation.inputSha256 = sha256(`superseded:${invocation.inputSha256}`);
      invocation.error = 'superseded by operator feedback';
    }
    // A later phase's unconsumed message goes with the restart, or nothing consumes it once that
    // phase is superseded and staging blocks on it.
    for (const message of ledger.pendingMessages) {
      if (!message.consumedAt && message.assignedToPhaseId && invalidated.has(message.assignedToPhaseId)) {
        message.assignedToPhaseId = feedbackPhase;
      }
    }
    for (const message of feedback) message.assignedToPhaseId = feedbackPhase;
    phase.status = 'pending';
    delete ledger.reviewAction;
    ledger.councils = ledger.councils.filter((council) => council.kind !== 'implementation');
    ledger.loops.fixRounds = 0;
    if (ledger.rounds) delete ledger.rounds.implementation;
    ledger.decisions.push({
      at: new Date().toISOString(),
      kind: 'implementation.feedback',
      by: 'driver',
      detail: feedback.map((message) => message.id).join(', '),
    });
    invalidateFollowingPhases(feedbackPhase);
    host.emit({
      type: 'harness.feedback.applied',
      stepId: feedbackPhase,
      phaseId: feedbackPhase,
      messageIds: feedback.map((message) => message.id),
    });
    host.emit({ type: 'note', message: 'applying operator feedback through the harness; implementation and its gates will run again' });
  }
  const implementationDecisions = (): HarnessLedger['decisions'] => {
    const restart = ledger.decisions.map((decision) => decision.kind).lastIndexOf('implementation.feedback');
    return ledger.decisions.slice(restart + 1);
  };

  /** A session's result, in a directory that session alone may write. */
  const ownResultPath = (slug: string): string => {
    const dir = join(agentOutputDir, slug);
    mkdirSync(dir, { recursive: true });
    return join(dir, 'result.json');
  };
  const resultPathFor = (phaseId: string) => ownResultPath(`phase-${phaseId}`);

  /**
   * Pull the first schema-valid JSON object out of arbitrary session output.
   *
   * Small models honor the CONTENT of the result contract more reliably than
   * its FRAMING: run 0fe16fb7's haiku reviewer produced a complete review —
   * three blockers, seven majors — wrapped in a markdown summary, twice, and
   * both attempts were discarded as "ended without a valid result file". When
   * the object is present but decorated, extracting it is strictly better than
   * failing: the schema still decides validity, so nothing unvalidated gets in.
   * Bounded: 2 MB of text, at most 20 candidate objects, string-aware brace
   * matching so JSON inside prose (or prose inside JSON strings) cannot confuse
   * the scan.
   */
  const salvageJson = <S extends z.ZodTypeAny>(schema: S, raw: string): z.infer<S> | null => {
    if (raw.length > 2_000_000) return null;
    let candidates = 0;
    for (let start = raw.indexOf('{'); start >= 0 && candidates < 20; start = raw.indexOf('{', start + 1)) {
      let depth = 0;
      let quoted = false;
      let escaped = false;
      for (let index = start; index < raw.length; index += 1) {
        const char = raw[index];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
          continue;
        }
        if (char === '"') quoted = true;
        else if (char === '{') depth += 1;
        else if (char === '}') {
          depth -= 1;
          if (depth === 0) {
            candidates += 1;
            try {
              const parsed = schema.safeParse(JSON.parse(raw.slice(start, index + 1)));
              if (parsed.success) return parsed.data;
            } catch {
            }
            break;
          }
        }
      }
    }
    return null;
  };

  const readContractResult = <S extends z.ZodTypeAny>(
    schema: S,
    resultPath: string,
  ): { result: z.infer<S> | null; failure: string | null; salvaged: boolean } => {
    let text: string;
    try {
      text = readHarnessArtifactText(resultPath);
    } catch (error) {
      return {
        result: null,
        failure: existsSync(resultPath)
          ? `wrote an unsafe result artifact (${
              error instanceof Error ? error.message : String(error)
            })`
          : 'ended without writing its result file',
        salvaged: false,
      };
    }
    if (text.trim().length === 0) {
      return { result: null, failure: 'ended with an empty result file', salvaged: false };
    }
    let schemaIssues: string | null = null;
    try {
      const parsed = schema.safeParse(JSON.parse(text));
      if (parsed.success) return { result: parsed.data, failure: null, salvaged: false };
      schemaIssues = parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
    } catch {
    }
    const salvaged = salvageJson(schema, text);
    if (salvaged !== null) return { result: salvaged, failure: null, salvaged: true };
    return {
      result: null,
      failure: schemaIssues
        ? `wrote JSON that does not match the result contract (${schemaIssues})`
        : `wrote ${text.length} characters that do not contain the contracted JSON object (starts: ${JSON.stringify(
            text.slice(0, 80),
          )})`,
      salvaged: false,
    };
  };

  const readResult = <T>(schema: z.ZodType<T>, phaseId: string): T | null =>
    readContractResult(schema, resultPathFor(phaseId)).result;

  const readReviewResultFile = (
    resultPath: string,
  ): {
    result: z.infer<typeof reviewResultSchema> | null;
    failure: string | null;
    salvaged: boolean;
  } => {
    const read = readContractResult(reviewResultSchema, resultPath);
    return {
      result: read.result,
      failure: read.failure === null ? null : `the session ${read.failure}`,
      salvaged: read.salvaged,
    };
  };

  const resultContractRetryAppendix = (
    failure: string,
    resultPath: string,
    editsPersist: boolean,
  ): string =>
    [
      '',
      '',
      `RESULT-CONTRACT RETRY: the previous session for this phase ${failure}, so nothing could be accepted from it.`,
      ...(editsPersist
        ? [
            'The previous session’s worktree edits and phase-output artifacts are still present. Do not repeat the phase from scratch: inspect only what is needed to verify the existing work, finish any missing piece, and write the result JSON.',
          ]
        : []),
      `This session MUST end by writing the result file at ${resultPath}: exactly one JSON object matching the contract above — no markdown fences, no commentary, nothing else in the file.`,
    ].join('\n');

  type BoundaryMessage = HarnessLedger['pendingMessages'][number];
  const boundaryMessagesForPhase = (
    phaseId: string,
    wasDone: boolean,
  ): BoundaryMessage[] =>
    ledger.pendingMessages.filter(
      (message) =>
        message.assignedToPhaseId === phaseId ||
        message.consumedByPhaseId === phaseId ||
        (!wasDone && !message.consumedAt && !message.assignedToPhaseId),
    );
  const assignBoundaryMessages = (
    phaseId: string,
    messages: BoundaryMessage[],
  ): void => {
    let changed = false;
    for (const message of messages) {
      if (!message.assignedToPhaseId) {
        message.assignedToPhaseId = phaseId;
        changed = true;
      }
    }
    if (changed) persist();
  };
  const boundaryMessageAppendix = (messages: BoundaryMessage[]): string =>
    messages.length === 0
      ? ''
      : [
          '',
          'Operator messages queued at the previous phase boundary:',
          ...messages.map((message) => `- [${message.id}] ${promptExcerpt(message.text)}`),
          'Treat these as user instructions for this phase. The ids make replay after a crash detectable.',
        ].join('\n');
  const completeBoundaryMessages = (
    phaseId: string,
    messages: BoundaryMessage[],
  ): string[] => {
    if (messages.length === 0) return [];
    const consumedAt = new Date().toISOString();
    const ids: string[] = [];
    for (const message of messages) {
      if (!message.consumedAt) {
        message.assignedToPhaseId = phaseId;
        message.consumedAt = consumedAt;
        message.consumedByPhaseId = phaseId;
        ids.push(message.id);
      }
    }
    return ids;
  };
  const emitBoundaryMessagesConsumed = (phaseId: string, messageIds: string[]): void => {
    if (messageIds.length === 0) return;
    host.emit({
      type: 'harness.message.consumed',
      stepId: phaseId,
      messageIds,
    });
  };

  const agentPhase = async <T>(
    phaseId: string,
    name: string,
    skill: string | undefined,
    prompt: string,
    schema: z.ZodType<T>,
    timeoutKey: string,
    ref?: HarnessRoleRef,
    /** A semantic check on a schema-valid result; its violation is a contract
     *  failure, so a reused result that fails it is re-run, never re-reused. */
    accept?: (result: T) => string | null,
  ): Promise<T | { error: string } | { cancelled: true }> => {
    const wasDone = phaseDone(phaseId);
    host.upsertStep({ id: phaseId, name, kind: 'agent' });
    const boundaryMessages = boundaryMessagesForPhase(phaseId, wasDone);
    if (!wasDone) assignBoundaryMessages(phaseId, boundaryMessages);
    const boundaryAppendix = boundaryMessageAppendix(boundaryMessages);
    const resultPath = resultPathFor(phaseId);
    const phasePrompt = `${prompt}${boundaryAppendix}`;
    const renderedPrompt = `${phasePrompt
      .replaceAll('$CEZ_HARNESS_RESULT_FILE', resultPath)
      .replaceAll('$CEZ_HARNESS_ARTIFACT_DIR', dirname(resultPath))}\n\n${phaseLocationContract(skill, dirname(resultPath))}\n\n${PHASE_SESSION_CONTRACT}`;
    const budgetError = promptBudgetError(completeModelPrompt(skill, renderedPrompt));
    if (budgetError) return { error: `${phaseId}: ${budgetError}` };
    const modelId = ref ? roleRefId(ref) : 'claude';
    const invocationId = `agent:${phaseId}:${modelId}`;
    let reviewSubjectSha256: string | undefined;
    if (skill === phaseSkills.codeReview) {
      try {
        reviewSubjectSha256 = await snapshotReviewSubject(host.cwd);
      } catch (error) {
        return {
          error: `could not capture the read-only review subject: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    }
    const invocationInputSha256 = sha256(
      JSON.stringify({
        inputHashVersion: 2,
        phaseId,
        skill,
        skillSha256: skill ? skillHash(skill) : null,
        prompt: renderedPrompt,
        runner: ref?.runner ?? 'claude',
        model: ref?.model ?? '',
        // Kept so invocations recorded before configured workers were removed still match.
        adapterId: null,
        effort: ref?.effort ?? null,
        reviewSubjectSha256: reviewSubjectSha256 ?? null,
        rubricSha256: skill === phaseSkills.codeReview ? skillHash(phaseSkills.codeReview) : null,
      }),
    );
    const reusable = reusableInvocation(invocationId, invocationInputSha256, schema);
    const reusedViolation = reusable !== null ? accept?.(reusable) ?? null : null;
    if (reusedViolation !== null) {
      const rejected = ledger.invocations.find((entry) => entry.id === invocationId)!;
      rejected.status = 'failed';
      rejected.error = `ended without a valid result file — ${reusedViolation}`;
      persist();
      emitInvocation(rejected);
    } else if (reusable !== null) {
      if (!ledger.phases.some((phase) => phase.id === phaseId)) {
        startPhase(ledger, { id: phaseId, name, kind: 'agent', skill });
      }
      finishPhase(ledger, phaseId, 'done');
      const consumedMessageIds = completeBoundaryMessages(phaseId, boundaryMessages);
      persist();
      host.setStepStatus(phaseId, 'done');
      emitPhase(phaseId);
      emitBoundaryMessagesConsumed(phaseId, consumedMessageIds);
      host.emit({
        type: 'note',
        stepId: phaseId,
        message: `reused completed ${modelId} invocation from the durable ledger`,
      });
      return reusable;
    }
    if (wasDone) invalidateFollowingPhases(phaseId);
    const recoverableInvocation = ledger.invocations.find(
      (entry) =>
        entry.id === invocationId &&
        entry.inputSha256 === invocationInputSha256 &&
        entry.status === 'failed' &&
        entry.error?.startsWith('ended without a valid result file') &&
        entry.startedAt &&
        entry.endedAt,
    );
    if (recoverableInvocation) {
      try {
        const stat = lstatSync(resultPath);
        const startedAt = Date.parse(recoverableInvocation.startedAt!);
        const endedAt = Date.parse(recoverableInvocation.endedAt!);
        const writtenDuringAttempt =
          stat.isFile() &&
          Number.isFinite(startedAt) &&
          Number.isFinite(endedAt) &&
          stat.mtimeMs >= startedAt - 5_000 &&
          stat.mtimeMs <= endedAt + 5_000;
        const read = writtenDuringAttempt ? readResult(schema, phaseId) : null;
        const parsed = read !== null && !accept?.(read) ? read : null;
        const artifactSha256 = parsed === null ? null : hashFile(resultPath);
        if (parsed !== null && artifactSha256) {
          recoverableInvocation.status = 'completed';
          recoverableInvocation.error = undefined;
          recoverableInvocation.process = undefined;
          recoverableInvocation.artifactPath = resultPath;
          recoverableInvocation.artifactSha256 = artifactSha256;
          const model = ledger.models.find((entry) => entry.id === modelId);
          if (model) {
            model.invocations += 1;
            model.totalDurationMs += recoverableInvocation.durationMs ?? 0;
          }
          if (!ledger.phases.some((phase) => phase.id === phaseId)) {
            startPhase(ledger, { id: phaseId, name, kind: 'agent', skill });
          }
          finishPhase(ledger, phaseId, 'done');
          const consumedMessageIds = completeBoundaryMessages(phaseId, boundaryMessages);
          persist();
          emitInvocation(recoverableInvocation);
          host.setStepStatus(phaseId, 'done');
          emitPhase(phaseId);
          emitBoundaryMessagesConsumed(phaseId, consumedMessageIds);
          host.emit({
            type: 'note',
            stepId: phaseId,
            message:
              `recovered the valid result written by ${modelId} attempt ` +
              `${recoverableInvocation.attempt}; no model rerun was needed`,
          });
          return parsed;
        }
      } catch {
      }
    }
    const priorAttempts = attemptsForInput(invocationId, invocationInputSha256);
    let lastContractFailure: string | null =
      [...ledger.invocations]
        .reverse()
        .find(
          (entry) =>
            entry.id === invocationId &&
            entry.inputSha256 === invocationInputSha256 &&
            entry.status === 'failed' &&
            typeof entry.error === 'string' &&
            entry.error.startsWith('ended without a valid result file'),
        )
        ?.error?.replace(/^ended without a valid result file(?: — )?/, '') || null;
    // Two attempts per input; a Continue after both failed buys one more, or it re-returned the
    // same failure without running anything.
    const attemptLimit = Math.max(2, priorAttempts + 1);
    for (let attempt = priorAttempts + 1; attempt <= attemptLimit; attempt += 1) {
      if (host.isCancelled()) return { cancelled: true };
      const attemptPrompt =
        attempt > 1 && lastContractFailure
          ? `${renderedPrompt}${resultContractRetryAppendix(
              lastContractFailure,
              resultPath,
              true,
            )}`
          : renderedPrompt;
      const attemptBudgetError = promptBudgetError(
        completeModelPrompt(skill, attemptPrompt),
      );
      if (attemptBudgetError) {
        return { error: `${phaseId}: ${attemptBudgetError}` };
      }
      startPhase(ledger, { id: phaseId, name, kind: 'agent', skill });
      persist();
      host.setStepStatus(phaseId, 'running');
      emitPhase(phaseId);
      const invocation = beginInvocation({
        id: invocationId,
        phaseId,
        role: ref ? 'assigned' : 'host',
        binding: {
          runner: ref?.runner ?? 'claude',
          model: ref?.model || undefined,
          effort: ref?.effort,
        },
        inputSha256: invocationInputSha256,
      });
      // A pre-created empty file makes Claude's built-in Write tool demand a
      // Read before it will write. Start absent instead: appearance of the
      // file is also the turn-driven session's completion signal. `recursive`: a phase that left a
      // directory here made every Continue throw EISDIR.
      rmSync(resultPath, { recursive: true, force: true });
      const reviewSubjectBefore = reviewSubjectSha256;
      let failure: string | null;
      failure = await runAgentInvocation(invocation, {
        phaseId,
        name,
        skill,
        prompt: attemptPrompt,
        resultPath,
        timeoutMs: PHASE_TIMEOUTS_MS[timeoutKey] ?? 30 * 60_000,
        env: {
          CEZ_HARNESS_RESULT_FILE: resultPath,
          CEZ_HARNESS_ARTIFACT_DIR: dirname(resultPath),
        },
        ...(ref
          ? { runner: ref.runner, model: ref.model, effort: ref.effort }
          : {}),
      });
      const runnerFailure = failure;
      if (reviewSubjectBefore !== undefined) {
        try {
          const after = await snapshotReviewSubject(host.cwd);
          if (after !== reviewSubjectBefore) {
            failure =
              'reviewer mutated the worktree or index; review results were rejected and the changed subject was preserved for manual recovery';
          }
        } catch (error) {
          failure = `could not verify the worktree after the read-only review: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }
      if (host.isCancelled()) {
        finishInvocation(invocation, 'interrupted', { error: 'run cancelled' });
        return { cancelled: true };
      }
      if (failure) {
        // A runner that never delivered (usage limit, crash, network) spent no contract attempt,
        // or two such failures left every later resume dead; an integrity
        // failure — a mutated subject, a rewritten .git pointer — still counts.
        const spent = failure !== runnerFailure || integrityFailures.has(failure);
        finishInvocation(invocation, spent ? 'failed' : 'interrupted', { error: failure });
        finishPhase(ledger, phaseId, 'failed', failure);
        persist();
        host.setStepStatus(phaseId, 'failed', failure);
        emitPhase(phaseId);
        return { error: `phase "${phaseId}" failed: ${failure}` };
      }
      const read = readContractResult(schema, resultPathFor(phaseId));
      const violation = read.result !== null ? accept?.(read.result) ?? null : null;
      if (read.result !== null && violation === null) {
        if (read.salvaged) {
          host.emit({
            type: 'note',
            stepId: phaseId,
            message: `phase "${phaseId}" wrapped its result JSON in prose — salvaged the embedded object`,
          });
        }
        finishInvocation(invocation, 'completed', {
          artifactPath: resultPath,
          modelId,
          persistNow: false,
        });
        finishPhase(ledger, phaseId, 'done');
        const consumedMessageIds = completeBoundaryMessages(phaseId, boundaryMessages);
        persist();
        emitInvocation(invocation);
        host.setStepStatus(phaseId, 'done');
        emitPhase(phaseId);
        emitBoundaryMessagesConsumed(phaseId, consumedMessageIds);
        return read.result;
      }
      lastContractFailure = violation ?? read.failure ?? 'ended without a valid result file';
      finishInvocation(invocation, 'failed', {
        error: `ended without a valid result file — ${lastContractFailure}`,
      });
      host.emit({
        type: 'note',
        stepId: phaseId,
        message:
          attempt === 1
            ? `phase "${phaseId}" ${lastContractFailure} — retrying once in a fresh session that is told what was wrong`
            : `phase "${phaseId}" ${lastContractFailure} after the informed retry`,
      });
    }
    const error =
      `phase "${phaseId}" produced no valid result after a retry` +
      (lastContractFailure ? `: ${lastContractFailure}` : '');
    finishPhase(ledger, phaseId, 'failed', error);
    persist();
    host.setStepStatus(phaseId, 'failed', error);
    emitPhase(phaseId);
    return { error };
  };

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

  const isFeature = input.workflow === HARNESS_IMPLEMENT_FEATURE;
  if (input.workflow !== HARNESS_FIX_ISSUE && !isFeature) {
    return `unknown harness workflow: ${input.workflow}`;
  }
  if (!isFeature && !input.issueId) {
    return 'harness fix workflow requires a concrete issue id';
  }
  const phaseSkills = harnessPhaseSkills(skillProfile);
  const trustedSkillsRoot = join(artifactDir, 'trusted-skills');
  const trustedSkillPrompts = new Map<string, string>();
  const trustedSkillHashes = new Map<string, string>();
  const skillHash = (name: string): string =>
    trustedSkillHashes.get(name) ?? 'missing';
  const completeModelPrompt = (skill: string | undefined, prompt: string): string => {
    const systemPrompt = skill ? trustedSkillPrompts.get(skill) : undefined;
    return systemPrompt
      ? [
          systemPrompt,
          '',
          '---',
          '',
          'Cezar wrapper contract:',
          '- Cezar is the external flow runner. It owns issue claims, tracker state, the authoritative validation gate, review reconciliation, staging, and every delivery action.',
          '- Do not assign issues, add/remove labels, post tracker comments, run setup skills, commit, push, publish, create/merge a PR, or perform any other external write.',
          '- You may run focused local tests needed to complete this phase. Cezar will run the immutable configured validation gate afterward; do not substitute claims for its evidence.',
          '- The phase task below narrows the selected skill to this run boundary. Its result-file schema is the machine-readable output contract for this invocation.',
          '',
          'Phase task:',
          prompt,
        ].join('\n')
      : prompt;
  };

  let roles = input.roles;
  if (!roles && input.profile !== 'standard') {
    return `harness blocked: profile "${input.profile}" needs a role lineup — named agentHarness profiles are no longer resolved`;
  }
  if (roles) {
    ledger.effectiveProfile = input.profile;
    ledger.roles = {
      orchestrator: { ...roles.orchestrator },
      implementer: { ...roles.implementer },
      reviewers: roles.reviewers.map((r) => ({ ...r })),
    };
  }

  let runtimeAgentic: AgenticConfig = {
    baseBranch: undefined,
    validationCommands: [],
    agentHarness: undefined,
  };
  if (phaseDone('preflight')) {
    const trusted = ledger.trustedConfig;
    if (!trusted?.sha256) {
      return 'harness recovery blocked: the completed preflight did not pin an immutable config hash';
    }
    const currentHash = hashFile(trusted.path);
    if (currentHash !== trusted.sha256) {
      return 'harness recovery blocked: the immutable preflight config is missing or changed';
    }
    runtimeAgentic = await loadAgenticFile(trusted.path);
  }
  ledger.findingHistory ??= projectedHarnessFindings(ledger);
  const requestedAction = ledger.reviewAction && (['pending', 'running'].includes(ledger.reviewAction.status) ||
    (ledger.reviewAction.status === 'completed' && ledger.reviewAction.onePass !== false && ledger.stage.status === 'staged'))
    ? ledger.reviewAction : undefined;
  if (requestedAction?.status === 'pending' || requestedAction?.status === 'completed') {
    const subject = await snapshotReviewSubject(host.cwd);
    if (subject !== requestedAction.subjectSha256) {
      requestedAction.status = 'failed';
      requestedAction.error = 'The worktree changed after this action was requested. Inspect the changes and request verification again.';
      setOutcome({ status: 'blocked', blockingReasons: [requestedAction.error] });
      return requestedAction.error;
    }
    if (requestedAction.status === 'pending') requestedAction.status = 'running';
  }
  const environmentWasPaused = ledger.environment !== undefined && ledger.environment.status !== 'ready';
  const environment = inspectHarnessEnvironment(host.cwd);
  if (requestedAction?.action === 'prepare' && environment.status !== 'ready' && environment.installCommand) {
    ledger.environment = { ...environment, status: 'preparing' };
    persist();
    host.emit({ type: 'harness.environment.updated', environment: ledger.environment });
    const controller = new AbortController();
    const off = host.onInterrupt(() => controller.abort());
    const invocation = beginInvocation({
      id: `environment:${requestedAction.id}`, phaseId: 'environment', role: 'runtime',
      binding: { runner: 'harness', model: 'prepare' }, inputSha256: sha256(environment.installCommand),
    });
    try {
      const checks = await validate([environment.installCommand], host.cwd, {
        signal: controller.signal, logDir: artifactDir, logPrefix: `environment-${requestedAction.id}-`,
        onSpawn: (identity) => { invocation.process = { ...identity }; persist(); emitInvocation(invocation); },
        onExit: () => { invocation.process = undefined; persist(); emitInvocation(invocation); },
      });
      if (host.isCancelled()) return null;
      const failure = checks.find((check) => check.status !== 'passed');
      finishInvocation(invocation, failure ? 'failed' : 'completed', failure ? { error: failure.evidence } : {});
      ledger.environment = failure
        ? { ...environment, status: 'failed', detail: failure.evidence, ...(failure.logPath ? { logPath: failure.logPath } : {}) }
        : inspectHarnessEnvironment(host.cwd);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      finishInvocation(invocation, 'failed', { error: detail });
      ledger.environment = { ...environment, status: 'failed', detail };
    } finally { off(); }
  } else {
    ledger.environment = environment;
  }
  persist();
  host.emit({ type: 'harness.environment.updated', environment: ledger.environment });
  if (ledger.environment.status !== 'ready') {
    const reason = ledger.environment.detail;
    if (requestedAction) { requestedAction.status = 'failed'; requestedAction.error = reason; }
    setOutcome({ status: 'blocked', blockingReasons: [reason] });
    return reason;
  }
  const operatorReview = requestedAction && ledger.phases.some((phase) => phase.id === 'implement' && phase.status === 'done')
    ? requestedAction : undefined;
  if ((requestedAction?.action === 'prepare' || environmentWasPaused) && !operatorReview && !ledger.phases.some((phase) => phase.kind === 'agent')) {
    ledger.baselineValidation = undefined;
    ledger.invocations = ledger.invocations.filter((entry) => entry.id !== 'validation:baseline');
    const baseline = ledger.phases.find((phase) => phase.id === 'baseline-gate');
    if (baseline) baseline.status = 'pending';
    persist();
  }
  const preflightError = await opPhase('preflight', 'Preflight', async () => {
    const selectedSkills = isFeature
      ? [
          phaseSkills.specWriting,
          phaseSkills.preImplement,
          phaseSkills.implementSpec,
          phaseSkills.codeReview,
        ]
      : [
          phaseSkills.qualify,
          phaseSkills.diagnose,
          phaseSkills.fix,
          phaseSkills.codeReview,
        ];
    const needed = [...new Set(['cez-harness', ...selectedSkills])];
    /**
     * Cezar's harness wrapper and generic phase skills come from the BUNDLED
     * tree, copied during the initial preflight — never from the catalog. The
     * canonical om-* phase skills take the normal discovery path, then every
     * selected skill is copied outside the model-writable worktree and
     * hash-bound for the lifetime of the run.
     *
     * The catalog resolves local-first, which is right for skills users author
     * and fatal for the runtime cezar ships: any root-cwd session that invokes
     * a cez-* skill materializes a copy into `<repo>/.claude/skills/`, and from
     * that moment every harness run clones that FROZEN snapshot instead of the
     * bundled runtime. On 2026-07-28 a snapshot planted at 12:22 served four
     * consecutive runs while three deployed runtime fixes changed a file no run
     * ever read — the last of them died at stage, two hours in, on a check the
     * fix had made advisory five hours earlier. A provenance warning fired into
     * the run log and helped nobody. Resolution order was the bug; only pinning
     * the source fixes it. The initial preflight also copies every selected
     * skill outside the model-writable worktree. Resumes load those exact bytes
     * instead of trusting a materialized directory an earlier phase could edit.
     */
    const bundledRoot =
      deps.bundledSkillsRoot === undefined ? bundledSkillsDir() : deps.bundledSkillsRoot;
    // A skill dir the repository tracks is the user's: cezar's copy over it would be staged into
    // the handoff, which is derived from git. Such skills pin from their source.
    const tracksSkillDir = (name: string): boolean => {
      try {
        return (
          execFileSync('git', ['ls-files', '-z', '--', `.claude/skills/${name}`], {
            cwd: host.cwd,
            encoding: 'utf8',
            env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...pinnedGitEnv(host.cwd) },
          }).length > 0
        );
      } catch {
        return false;
      }
    };
    const composedSkillSources = new Map<string, string>();
    const pinMaterializedSkill = (
      name: string,
      materialized = join(host.cwd, '.claude', 'skills', name),
    ): void => {
      const pinned = join(trustedSkillsRoot, name);
      rmSync(pinned, { recursive: true, force: true });
      mkdirSync(trustedSkillsRoot, { recursive: true });
      // By value: a pinned symlink would stay live-editable under a stable hash.
      copyTreeByValue(materialized, pinned);
      const binding = loadTrustedHarnessSkill(trustedSkillsRoot, name);
      trustedSkillPrompts.set(name, binding.systemPrompt);
      trustedSkillHashes.set(name, binding.sha256);
      ledger.trustedSkills[name] = binding.sha256;
    };
    const composeCompleteCodeReviewSkill = async (): Promise<string | null> => {
      const target = join(host.cwd, '.claude', 'skills', phaseSkills.codeReview);
      const required = [
        'SKILL.md',
        join('references', 'review-checklist.md'),
        join('references', 'output-format.md'),
      ];
      if (required.every((path) => existsSync(join(target, path)))) return null;
      const extensionPath = join(target, 'SKILL.md');
      if (!existsSync(extensionPath)) {
        return `required Open Mercato skill "${phaseSkills.codeReview}" was discovered but not materialized`;
      }
      const extensionRaw = readFileSync(extensionPath, 'utf8');
      const candidates = await discoverCandidates(host.cwd, phaseSkills.codeReview);
      const base = candidates.find((candidate) => {
        if (!candidate.path.endsWith('SKILL.md') || candidate.team) return false;
        const root = dirname(candidate.path);
        return required.every((path) => existsSync(join(root, path)));
      });
      if (!base) {
        return (
          `required Open Mercato skill "${phaseSkills.codeReview}" is only a repo-local extension; ` +
          'install or sync the complete open-mercato/skills definition with its references'
        );
      }
      const baseRoot = realpathSync(dirname(base.path));
      const baseRaw = readFileSync(join(baseRoot, 'SKILL.md'), 'utf8');
      const tracked = tracksSkillDir(phaseSkills.codeReview);
      const composed = tracked ? join(artifactDir, 'composed-skills', phaseSkills.codeReview) : target;
      rmSync(composed, { recursive: true, force: true });
      cpSync(baseRoot, composed, { recursive: true });
      if (tracked) composedSkillSources.set(phaseSkills.codeReview, composed);
      if (baseRaw !== extensionRaw) {
        const extension = parseFrontmatter(extensionRaw).body.trim();
        if (extension) {
          writeFileSync(
            join(composed, 'SKILL.md'),
            [
              baseRaw.trimEnd(),
              '',
              '---',
              '',
              '## Repository-local Open Mercato extension',
              '',
              extension,
              '',
            ].join('\n'),
            'utf8',
          );
        }
      }
      // Ignored in this worktree only, like every materialized skill.
      if (!tracked) await ignoreProvisioned(host.cwd, '.claude/skills', phaseSkills.codeReview);
      return null;
    };
    for (const name of needed) {
      const bundledSkill = bundledRoot === null ? null : join(bundledRoot, name);
      if (bundledSkill && existsSync(join(bundledSkill, 'SKILL.md'))) {
        try {
          if (tracksSkillDir(name)) {
            pinMaterializedSkill(name, bundledSkill);
          } else {
            const target = join(host.cwd, '.claude', 'skills', name);
            rmSync(target, { recursive: true, force: true });
            cpSync(bundledSkill, target, { recursive: true });
            await ignoreProvisioned(host.cwd, '.claude/skills', name);
            pinMaterializedSkill(name);
          }
          continue;
        } catch {
        }
      }
      if (!(await host.ensureSkill(name))) {
        return {
          ok: false,
          error:
            name === 'cez-harness'
              ? 'required Cezar harness wrapper "cez-harness" is missing — reinstall Cezar or rerun scripts/vendor-skills.mjs'
              : skillProfile === 'open-mercato'
                ? `required Open Mercato skill "${name}" is missing — install or sync open-mercato/skills, or run from an Open Mercato checkout that provides it`
                : `required bundled generic skill "${name}" is missing — reinstall Cezar or rerun scripts/vendor-skills.mjs`,
        };
      }
      if (
        skillProfile === 'open-mercato' &&
        name === phaseSkills.codeReview &&
        existsSync(join(host.cwd, '.claude', 'skills', name, 'SKILL.md'))
      ) {
        const compositionError = await composeCompleteCodeReviewSkill();
        if (compositionError) return { ok: false, error: compositionError };
      }
      try {
        pinMaterializedSkill(name, composedSkillSources.get(name));
      } catch {
        if (bundledRoot === null) continue;
        return {
          ok: false,
          error: `required skill "${name}" was discovered but its materialized SKILL.md could not be pinned`,
        };
      }
    }
    const runtimeScript = resolveScript(host.cwd);
    if (!runtimeScript) {
      return { ok: false, error: 'cez-harness runtime not found in the worktree (.claude/skills/cez-harness/scripts/harness.mjs)' };
    }
    // A project-local `.claude/skills/cez-harness` wins over the bundled copy
    // (skills resolve local-first). That is the intended override, but when the
    // local copy is a STALE install it silently shadows every runtime fix cezar
    // ships and there was no way to tell from the run: 71edb02c executed a
    // cez-harness from 2026-07-25 while the shipped one carried a corrected
    // staged-only git guard, and the ledger looked completely normal.
    try {
      const bundledRuntime = join(
        bundledSkillsDir(),
        'cez-harness',
        'scripts',
        'harness.mjs',
      );
      const pinnedRuntime = join(trustedSkillsRoot, 'cez-harness', 'scripts', 'harness.mjs');
      const running = hashFile(existsSync(pinnedRuntime) ? pinnedRuntime : runtimeScript);
      const shipped = hashFile(bundledRuntime);
      if (running && shipped && running !== shipped) {
        host.emit({
          type: 'note',
          message:
            `this run's cez-harness runtime is NOT the one cezar ships — a project-local copy at ` +
            `${runtimeScript} is shadowing the bundled one. Runtime fixes shipped with cezar do ` +
            `not apply to this run. Remove the local copy to pick up the bundled runtime.`,
        });
      }
    } catch {
    }
    let agentic = await loadAgentic(host.cwd);
    let baseSnapshot = await exportConfig(
      host.repoRoot,
      agentic.baseBranch ?? 'HEAD',
      artifactDir,
    );
    if (baseSnapshot) agentic = await loadAgenticFile(baseSnapshot.path);
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
        writeFileSync(
          copyPath,
          readHarnessArtifactText(join(host.repoRoot, '.ai', 'agentic.config.json')),
          'utf8',
        );
        ledger.trustedConfig = {
          baseRef: 'working-tree (uncommitted)',
          path: copyPath,
          overlay: false,
          sha256: hashFile(copyPath) ?? undefined,
        };
        host.emit({
          type: 'note',
          message:
            'using the model configuration from your working copy of .ai/agentic.config.json — it is not committed on the base branch yet. This run snapshotted it, so later edits will not affect it. Commit the file when you are happy with it to pin the setup for future runs.',
        });
      }
    }
    if (!workingTreeConfig) {
      if (!baseSnapshot) {
        const copyPath = join(artifactDir, 'trusted-agentic.config.json');
        writeJsonAtomic(copyPath, {
          ...(agentic.baseBranch ? { baseBranch: agentic.baseBranch } : {}),
          validation: { commands: agentic.validationCommands },
          ...(agentic.agentHarness ? { agentHarness: agentic.agentHarness } : {}),
        });
        baseSnapshot = { path: copyPath, ref: 'initial-worktree snapshot' };
      }
      ledger.trustedConfig = {
        baseRef: baseSnapshot.ref,
        path: baseSnapshot.path,
        overlay: false,
        sha256: hashFile(baseSnapshot.path) ?? undefined,
      };
    }
    const trustedConfig = ledger.trustedConfig;
    if (!trustedConfig?.sha256) {
      return { ok: false, error: 'could not hash the immutable agentic config snapshot' };
    }
    runtimeAgentic = await loadAgenticFile(trustedConfig.path);
    agentic = runtimeAgentic;
    if (roles) {
      const seating = opencodeSeatingError(roles);
      if (seating) return { ok: false, error: seating };
      // Advisor reviewers execute through the runtime council and need their
      // bindings in the config (spec 2026-07-23-harness-orchestration) — fail the
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
      const canonical = canonicalizeAdvisorRefs(
        roles.reviewers,
        (agentic.agentHarness?.models ?? {}) as Record<string, unknown>,
      );
      if (!canonical.ok) return { ok: false, error: canonical.error };
      roles = { ...roles, reviewers: canonical.refs as HarnessReviewerRef[] };
      ledger.roles = {
        ...(ledger.roles ?? {}),
        orchestrator: { ...roles.orchestrator },
        implementer: { ...roles.implementer },
        reviewers: roles.reviewers.map((reviewer) => ({ ...reviewer })),
      };
    }
    if (roles) {
      const prober = await createProber({
        advisors: (agentic.agentHarness?.models ?? {}) as Record<string, unknown>,
        cwd: host.cwd,
      });
      if (host.isCancelled()) return { ok: true };
      const roster = new Map<
        string,
        { id: string; binding: string; roles: string[]; family: string; runner: string; model: string }
      >();
      const tag = (ref: HarnessReviewerRef, role: string) => {
        const id = roleRefId(ref);
        // `family` used to be set for advisors ONLY, so every runner-backed
        // reviewer — i.e. every reviewer in a role lineup — reached the Review
        // tab with an empty Family column, the one column that evidences the
        // council's independence claim (review 2026-07-27).
        const entry = roster.get(id) ?? {
          id,
          runner: ref.runner,
          model: ref.model,
          family: providerFamilyOf(ref),
          binding: isAdvisorRef(ref)
            ? `council · ${ref.model}`
            : `${ref.runner} · ${ref.model || 'default model'}`,
          roles: [] as string[],
        };
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

      const unreachable = ledger.models.filter((m) => m.readiness !== 'ready');
      if (unreachable.length > 0) {
        persist();
        host.emit({
          type: 'harness.readiness.updated',
          profile: ledger.effectiveProfile,
          models: ledger.models,
        });
        return {
          ok: false,
          error: `unverified or unreachable model${unreachable.length > 1 ? 's' : ''}: ${unreachable
            .map((m) => `${m.id} — ${m.readinessDetail ?? 'probe did not verify the binding'}`)
            .join('; ')}`,
        };
      }
    } else {
      const hostRef: HarnessRoleRef = { runner: 'claude', model: '' };
      const prober = await createProber({
        advisors: {},
        cwd: host.cwd,
      });
      if (host.isCancelled()) return { ok: true };
      const verdict = await prober.probe(hostRef);
      ledger.models = [
        {
          id: 'claude',
          family: 'anthropic',
          runner: 'claude',
          model: '',
          binding: 'host app',
          roles: ['host', 'reviewer'],
          readiness:
            verdict.status === 'ready'
              ? 'ready'
              : verdict.status === 'failed'
                ? 'failed'
                : 'unknown',
          readinessDetail: verdict.detail,
          invocations: 0,
          totalDurationMs: 0,
        },
      ];
      if (verdict.status !== 'ready') {
        persist();
        host.emit({
          type: 'harness.readiness.updated',
          profile: ledger.effectiveProfile,
          models: ledger.models,
        });
        return {
          ok: false,
          error: `unverified or unreachable host model: ${
            verdict.detail ?? 'probe did not verify the Claude binding'
          }`,
        };
      }
    }
    persist();
    host.emit({ type: 'harness.readiness.updated', profile: ledger.effectiveProfile, models: ledger.models });
    return { ok: true };
  });
  if (preflightError === 'cancelled') return null;
  if (preflightError) return preflightError;
  for (const name of [...new Set(['cez-harness', ...(
    isFeature
      ? [phaseSkills.specWriting, phaseSkills.preImplement, phaseSkills.implementSpec, phaseSkills.codeReview]
      : [phaseSkills.qualify, phaseSkills.diagnose, phaseSkills.fix, phaseSkills.codeReview]
  )])]) {
    try {
      const binding = loadTrustedHarnessSkill(trustedSkillsRoot, name);
      const expectedHash = ledger.trustedSkills[name];
      if (expectedHash && expectedHash !== binding.sha256) {
        return `harness recovery blocked: pinned skill "${name}" is missing or changed`;
      }
      if (!expectedHash && deps.bundledSkillsRoot !== null) {
        return `harness recovery blocked: completed preflight did not record a hash for skill "${name}"`;
      }
      trustedSkillPrompts.set(name, binding.systemPrompt);
      trustedSkillHashes.set(name, binding.sha256);
    } catch {
      if (deps.bundledSkillsRoot === null) continue;
      return `harness recovery blocked: pinned skill "${name}" is missing or unreadable`;
    }
  }
  if (input.issueId) {
    const claimed = acquireClaim(host.cwd, host.runId, input.issueId, {
      dataDir: host.dataDir,
      runExists: (runId) => readLedger(host.dataDir, runId).status !== 'missing',
    });
    if (!claimed.ok) return claimed.error;
    ledger.claim = {
      held: true,
      issueId: input.issueId,
      path: claimed.claim.path,
    };
    persist();
  }

  // The runtime is SEALED from the hash-verified preflight pin, never from the
  // worktree (review 2026-07-27): `.claude/skills` is
  // git-excluded and agent-writable, and every op runs unsandboxed with credentials.
  const sealed = sealRuntime(trustedSkillsRoot, artifactDir);
  if (!sealed) {
    releaseHeldIssueClaim();
    return 'harness recovery blocked: the preflight-pinned cez-harness runtime is missing — refusing to run an unpinned runtime';
  }
  if (ledger.runtimeScript && ledger.runtimeScript.sha256 !== sealed.sha256) {
    host.emit({
      type: 'note',
      message:
        `the runtime this run executed before (sha256 ${ledger.runtimeScript.sha256}) differs from ` +
        `its preflight pin (sha256 ${sealed.sha256}); continuing with the pinned runtime`,
    });
  }
  ledger.runtimeScript = { path: sealed.script, sha256: sealed.sha256 };
  persist();
  const rawRuntime = createRuntime({
    script: sealed.script,
    cwd: host.cwd,
    env: {
      ...harnessChildEnvironment(
        harnessConfigEnvironmentNames(runtimeAgentic.agentHarness),
      ),
      ...accountEnvironment(await probeAccounts(host.repoRoot)),
      CEZ_HARNESS_REVIEW_SKILL: phaseSkills.codeReview,
      // The runtime pins its own git calls with these — never a process-wide GIT_DIR (git-pin.ts).
      ...(trustedGitDir ? { CEZ_HARNESS_GIT_DIR: trustedGitDir, CEZ_HARNESS_GIT_WORK_TREE: host.cwd } : {}),
    },
  });
  const runtime: RuntimeLike = {
    kill: () => rawRuntime.kill(),
    run: async (op, args, opts) => {
      if (host.isCancelled()) {
        return { ok: false, exitCode: null, stdout: '', stderr: '', error: `op "${op}" cancelled`, durationMs: 0 };
      }
      const digest = scriptDigest(sealed.script);
      if (digest !== sealed.sha256) {
        const error =
          digest === null
            ? 'the sealed cez-harness runtime disappeared mid-run — refusing to execute'
            : 'the sealed cez-harness runtime changed mid-run — refusing to execute a modified runtime';
        host.emit({ type: 'note', message: `${error} (op ${op})` });
        return { ok: false, exitCode: null, stdout: '', stderr: '', error, durationMs: 0 };
      }
      return rawRuntime.run(op, args, opts);
    },
  };
  const offInterrupt = host.onInterrupt(() => runtime.kill());
  const runReadOnlyReviewer = async (
    invocation: HarnessInvocation,
    request: HarnessAgentPhaseRequest,
  ): Promise<string | null> => {
    let before: string;
    try {
      before = await snapshotReviewSubject(host.cwd);
    } catch (error) {
      return `could not capture the read-only review subject: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    if (host.isCancelled()) return 'run cancelled';
    const failure = await runAgentInvocation(invocation, request);
    try {
      const after = await snapshotReviewSubject(host.cwd);
      if (after !== before) {
        return `${REVIEWER_MUTATION_FAILURE}; review results were rejected and the changed subject was preserved for manual recovery`;
      }
    } catch (error) {
      return `could not verify the worktree after the read-only review: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    return failure;
  };
  /** A council judges one subject. A change that outlives it voids the round even when the rest
   *  reached quorum, or a subject no gate validated and part of the council never saw would stage as
   *  `ready`. Nobody can attribute the change, so the message blames no reviewer. */
  const councilSubjectIssue = async (
    before: string,
    current: () => Promise<string | null>,
  ): Promise<string | null> => {
    try {
      if ((await current()) === before) return null;
    } catch (error) {
      return `could not verify the review subject after the council: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    return 'the review subject changed during the council, so this round is void; the changed worktree was preserved for manual recovery, and Continue re-validates and re-reviews it';
  };

  // A proceed decision also skips undelivered transient/limited reviewers: the user declined
  // to pay for them again, even though they spent no contract attempt.
  const reviewerFailedBefore = (invocationId: string, inputSha256: string): boolean => {
    if (attemptsForInput(invocationId, inputSha256) > 0) return true;
    const prior = ledger.invocations.find((invocation) => invocation.id === invocationId);
    return (
      prior?.inputSha256 === inputSha256 &&
      prior.status === 'interrupted' &&
      (isUsageLimitMessage(prior.error ?? '') || classifyAgentFailure(prior.error) === 'transient')
    );
  };

  /** One council reviewer that throws fails alone, as `pool` requires: the rejected pool unwound
   *  the driver while its siblings' sessions ran on, unstoppable and billing. */
  const containReviewerThrow =
    <R extends HarnessReviewerRef>(
      phaseId: string,
      outcomes: CouncilOutcome[],
      reviewers: Array<Record<string, unknown>>,
      work: (reviewer: R, idx: number) => Promise<void>,
    ) =>
    async (reviewer: R, idx: number): Promise<void> => {
      try {
        await work(reviewer, idx);
      } catch (error) {
        const label = roleRefId(reviewer);
        const reason = `reviewer ${label} failed: ${error instanceof Error ? error.message : String(error)}`;
        const open = ledger.invocations.find(
          (invocation) =>
            invocation.phaseId === phaseId && invocation.reviewerId === label && invocation.status === 'running',
        );
        if (open) finishInvocation(open, 'failed', { error: reason });
        if (!outcomes.some((outcome) => outcome.label === label)) {
          outcomes.push({ label, family: councilFamilyOf(reviewer), status: 'failed', reason });
          reviewers.push({ id: label, status: 'failed', reason });
        }
      }
    };

  /** One packet-less advisor council op (spec 2026-07-23-harness-orchestration):
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

  /* ---- council decisions (user-resolvable quorum failures) ---------------- */

  type CouncilKind = 'spec' | 'implementation';
  /** Each explicit user retry grants every failed reviewer of that round ONE
   *  more attempt beyond the automatic budget of 2 — recorded as a ledger
   *  decision, so a resumed process reaches the same bound deterministically. */
  const councilRetryAllowance = (
    council: CouncilKind,
    round: number,
    subjectSha256: string,
  ): number =>
    (council === 'implementation' ? implementationDecisions() : ledger.decisions).filter(
      (d) =>
        d.kind === 'council.retry' &&
        d.detail === councilDecisionDetail({ council, round, subjectSha256 }),
    ).length;
  const priorReviewerFailure = (invocationId: string): string =>
    ledger.invocations.find((invocation) => invocation.id === invocationId)?.error ??
    'failed before the recorded proceed decision';
  const councilProceedAccepted = (
    council: CouncilKind,
    round: number,
    subjectSha256: string,
  ): boolean =>
    (council === 'implementation' ? implementationDecisions() : ledger.decisions).some(
      (d) =>
        d.kind === 'council.proceed' &&
        d.detail === councilDecisionDetail({ council, round, subjectSha256 }),
    );

  /**
   * The council gate a quorum failure passes through before it may end the run.
   *
   * A council below quorum used to return an error outright — one dead
   * transport (an `opencode serve` outage, a free-tier model that never
   * answers) voided every completed review alongside it. Now the failure
   * PAUSES the run with a decision the user can actually make: retry the
   * failed reviewers (another paid attempt) or proceed with the survivors
   * (recorded, loud, degraded). Only a council with NO survivors keeps
   * retry as its single exit.
   */
  const resolveCouncilGate = (
    council: CouncilKind,
    round: number,
    outcomes: readonly CouncilOutcome[],
    phaseId: string,
    subjectSha256: string,
  ): { proceed: true; waived: boolean } | { proceed: false; error: string } => {
    // A resolved pause must not shadow the eventual result: staging only
    // promotes a PENDING outcome to ready, so the stored blocked-for-decision
    // outcome is cleared the moment this council passes its gate again.
    const clearCouncilPause = () => {
      if (
        ledger.outcome.status === 'blocked' &&
        ledger.outcome.pendingDecision?.kind === 'council' &&
        ledger.outcome.pendingDecision.council === council &&
        ledger.outcome.pendingDecision.round === round
      ) {
        setOutcome({ status: 'pending', blockingReasons: [] });
      }
    };
    const quorum = councilQuorum(outcomes);
    if (quorum.ok) {
      if (quorum.degraded) {
        host.emit({
          type: 'note',
          stepId: phaseId,
          message: `${council} council ran DEGRADED — ${quorum.completed.length} of ${outcomes.length} reviewers completed; missing: ${quorum.failed
            .map((f) => `${f.label} (${f.reason ?? 'no valid review'})`)
            .join('; ')}`,
        });
      }
      clearCouncilPause();
      return { proceed: true, waived: false };
    }
    const completed = outcomes.filter((o) => o.status === 'completed');
    const failed = outcomes.filter((o) => o.status === 'failed');
    if (completed.length > 0 && councilProceedAccepted(council, round, subjectSha256)) {
      clearCouncilPause();
      host.emit({
        type: 'note',
        stepId: phaseId,
        message:
          `${council} council proceeds WITHOUT quorum on the user's recorded decision — ` +
          `${completed.length} of ${outcomes.length} reviewers completed; ignored: ${failed
            .map((f) => f.label)
            .join(', ')}`,
      });
      return { proceed: true, waived: true };
    }
    const reason = `${council} council did not reach quorum: ${quorum.reason}`;
    setOutcome({
      status: 'blocked',
      blockingReasons: [reason],
      pendingDecision: {
        kind: 'council',
        council,
        round,
        failed: failed.map((f) => ({
          label: f.label,
          ...(f.reason ? { reason: f.reason } : {}),
        })),
        completedCount: completed.length,
        canProceed: completed.length > 0,
        subjectSha256,
      },
    });
    host.emit({
      type: 'note',
      stepId: phaseId,
      message:
        `${council} council is below quorum and the run is paused for your decision: ` +
        `retry the failed reviewer(s)${completed.length > 0 ? ' or proceed with the survivors' : ''}. ` +
        `Completed work is preserved either way.`,
    });
    return { proceed: false, error: reason };
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
    /** Extra attempts granted by recorded `council.retry` decisions. */
    retryAllowance?: number;
    /** A recorded `council.proceed`: a member that already failed gets no new attempt. */
    proceedAccepted?: boolean;
  }): Promise<{ rows: Array<Record<string, unknown>>; error: string | null } | null> => {
    const configSource = ledger.trustedConfig?.path ?? join(host.cwd, '.ai', 'agentic.config.json');
    const rows: Array<Record<string, unknown>> = [];
    // Outside the worktree: the runtime writes here unsandboxed and follows links, so a model-planted
    // symlink in a worktree folder redirected its writes to host files.
    const outputDir = join(artifactDir, `council-${op.kindTag}-r${op.round}`);
    const resultFile = join(outputDir, 'review-result.json');
    let subjectSha256: string;
    if (op.artifact) {
      subjectSha256 = hashFile(op.artifact) ?? 'missing';
    } else {
      try {
        subjectSha256 = await snapshotReviewSubject(host.cwd);
      } catch (error) {
        return {
          rows,
          error: `could not capture the advisor council review subject: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    }
    let subjectBytes: number;
    try {
      subjectBytes = op.artifact
        ? Buffer.byteLength(readHarnessArtifactText(op.artifact, HARNESS_JSON_ARTIFACT_MAX_BYTES * 4))
        : pinnedGitEnv(host.cwd)
          ? (await harnessDiff(host.cwd, [], join(artifactDir, `council-subject-${randomUUID()}.index`))).length
          : 0;
    } catch (error) {
      return { rows, error: `could not size the advisor council subject: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (host.isCancelled()) return null;
    const rubricFiles = [
      join(trustedSkillsRoot, phaseSkills.codeReview, 'SKILL.md'),
      join(trustedSkillsRoot, phaseSkills.codeReview, 'references', 'review-checklist.md'),
      join(trustedSkillsRoot, phaseSkills.codeReview, 'references', 'output-format.md'),
      join(dirname(sealed.script), '..', 'references', 'review-result.schema.json'),
    ];
    // Match the timeout's fixed prompt allowance.
    let fixedBytes: number;
    try {
      fixedBytes = Buffer.byteLength(op.criteriaText) + 8_192 + rubricFiles.reduce(
        (bytes, path) => bytes + (existsSync(path) ? Buffer.byteLength(readHarnessArtifactText(path)) : 0), 0,
      );
    } catch (error) {
      return { rows, error: `advisor council failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    const configuredModels = runtimeAgentic.agentHarness?.models as Record<string, { maxInputBytes?: unknown }> | undefined;
    const resultMaxBytes = advisorCouncilResultMaxBytes(
      op.members.map((member) => member.entry ?? configuredModels?.[member.councilId] ?? {}), subjectBytes, fixedBytes,
    );
    let recoverableCouncil: z.infer<typeof councilResultSchema> | null = null;
    let recoverableCouncilMtimeMs: number | null = null;
    try {
      // One read for bytes and mtime, so the recovered verdict and its age describe the same file.
      const entry = readHarnessFsEntry(resultFile, resultMaxBytes);
      const parsed =
        entry.kind === 'file' && entry.content !== null
          ? councilResultSchema.safeParse(JSON.parse(entry.content.toString('utf8')) as unknown)
          : null;
      if (entry.kind === 'file' && parsed?.success) {
        recoverableCouncil = parsed.data;
        recoverableCouncilMtimeMs = entry.stat.mtimeMs;
      }
    } catch {
    }
    const invocationMeta = new Map<
      string,
      { id: string; inputSha256: string; artifactPath: string }
    >();
    const pendingMembers: typeof op.members = [];
    for (const member of op.members) {
      const id = advisorInvocationId(op, member);
      const inputSha256 = sha256(
        JSON.stringify({
          inputHashVersion: 2,
          kind: op.kindTag,
          round: op.round,
          councilId: member.councilId,
          family: member.family ?? null,
          entry: member.entry ?? null,
          criteria: op.criteriaText,
          subjectSha256,
          rubricSha256:
            op.kindTag === 'spec'
              ? {
                  specification: skillHash(phaseSkills.specWriting),
                  review: skillHash(phaseSkills.codeReview),
                }
              : skillHash(phaseSkills.codeReview),
        }),
      );
      const artifactPath = join(artifactDir, `invocation-${sha256(id).slice(0, 20)}.json`);
      invocationMeta.set(member.label, { id, inputSha256, artifactPath });
      const reusable = reusableInvocation(id, inputSha256, reviewResultSchema);
      if (reusable === null) {
        const prior = ledger.invocations.find((entry) => entry.id === id);
        const recoveredRow = recoverableCouncil?.reviewers.find(
          (row) => row.id === member.councilId,
        );
        const startedAt = prior?.startedAt ? Date.parse(prior.startedAt) : Number.NaN;
        const endedAt = prior?.endedAt ? Date.parse(prior.endedAt) : Number.NaN;
        const writtenDuringAttempt =
          recoverableCouncilMtimeMs !== null &&
          Number.isFinite(startedAt) &&
          Number.isFinite(endedAt) &&
          recoverableCouncilMtimeMs >= startedAt - 5_000 &&
          recoverableCouncilMtimeMs <= endedAt + 5_000;
        const recoveredReview =
          recoveredRow?.status === 'completed' ? advisorReviewSchema.safeParse(recoveredRow.review) : null;
        const contractSubject = recoverableCouncil?.reviewContract?.subjectSha256;
        const contractMatchesSubject =
          !op.artifact || contractSubject === undefined || contractSubject === subjectSha256;
        if (
          prior?.status === 'failed' &&
          prior.inputSha256 === inputSha256 &&
          isCouncilSubjectChangedError(prior.error) &&
          writtenDuringAttempt &&
          contractMatchesSubject &&
          recoveredReview?.success
        ) {
          writeJsonAtomic(artifactPath, recoveredReview.data);
          prior.status = 'completed';
          prior.error = undefined;
          prior.process = undefined;
          prior.artifactPath = artifactPath;
          prior.artifactSha256 = hashFile(artifactPath) ?? undefined;
          const model = ledger.models.find((entry) => entry.id === member.label);
          if (model) {
            model.invocations += 1;
            model.totalDurationMs += prior.durationMs ?? 0;
          }
          rows.push({
            id: member.label,
            runner: 'harness',
            model: member.councilId,
            family: member.family,
            status: 'completed',
            freshContext: true,
            verdict: recoveredReview.data.verdict,
            findings: recoveredReview.data.findings,
            recovered: true,
          });
          persist();
          emitInvocation(prior);
          host.emit({
            type: 'note',
            message:
              `recovered completed advisor ${member.label} from the council result ` +
              'written during the rejected attempt; no model rerun was needed',
          });
          continue;
        }
        const attempts = attemptsForInput(id, inputSha256);
        if (attempts >= 2 + (op.retryAllowance ?? 0) || (op.proceedAccepted && prior?.inputSha256 === inputSha256)) {
          rows.push({
            id: member.label,
            runner: 'harness',
            model: member.councilId,
            family: member.family,
            status: 'failed',
            freshContext: true,
            error: prior?.error ?? 'advisor retry budget exhausted',
          });
        } else {
          pendingMembers.push(member);
        }
      } else {
        rows.push({
          id: member.label,
          runner: 'harness',
          model: member.councilId,
          family: member.family,
          status: 'completed',
          freshContext: true,
          verdict: reusable.verdict,
          findings: reusable.findings,
          recovered: true,
        });
        host.emit({
          type: 'note',
          message: `reused completed advisor ${member.label} from the durable ledger`,
        });
      }
    }
    if (pendingMembers.length === 0) return { rows, error: null };

    const ids = pendingMembers.map((m) => m.councilId);
    const running = new Map<string, HarnessInvocation>();
    let error: string | null = null;
    try {
      // A synthesized reviewer carries its own binding, so a repo with no
      // `.ai/agentic.config.json` at all — the ordinary cezar project — must
      // still get a council. Only a configured ADVISOR needs the repo file.
      const configJson = (existsSync(configSource)
        ? (JSON.parse(readHarnessArtifactText(configSource)) as object)
        : {}) as {
        agentHarness?: {
          version?: unknown;
          delivery?: Record<string, unknown>;
          models?: Record<string, { timeoutMs?: unknown; maxInputBytes?: unknown } | undefined>;
          profiles?: Record<string, unknown>;
        };
      };
      const harnessObj = configJson.agentHarness ?? {};
      // `validateConfig` in harness.mjs rejects a config without these two, and a repo
      // with no `.ai/agentic.config.json` supplies neither — so the zero-config council
      // the comment above promises died at its first round with
      // "agentHarness.version must be 1". Both are cezar INVARIANTS rather than user
      // choices: the vendored runtime is version 1, and delivery is stage-only by
      // construction (the server 409s push and PR until the ledger proves staging), so
      // the driver states them instead of hoping the repo does. Written into the
      // synthesized council config only — the user's own file is never touched.
      harnessObj.version = 1;
      harnessObj.delivery = { ...(harnessObj.delivery ?? {}), mode: 'stage-only' };
      // Unselected legacy bindings must not block a council the user can run.
      const configuredModels = harnessObj.models ?? {};
      harnessObj.models = Object.fromEntries(pendingMembers.map((member) => [
        member.councilId,
        member.entry ?? configuredModels[member.councilId],
      ])) as typeof configuredModels;
      harnessObj.profiles = {
        'cez-role-council': {
          reviewers: ids,
          maxParallel: ids.length,
          reviewPolicy: { mode: 'all-required', requiredReviewers: ids },
          // Cezar owns retries (two per reviewer, never after a timeout). The runtime's own 3× with
          // escalating timeouts outlasted this op, which then killed it and lost the reviews that
          // had completed.
          retry: { maxAttempts: 1 },
        },
      };
      configJson.agentHarness = harnessObj;
      const councilConfigPath = join(artifactDir, `council-config-${op.kindTag}-r${op.round}.json`);
      writeFileSync(councilConfigPath, `${JSON.stringify(configJson, null, 2)}\n`, 'utf8');
      const criteriaPath = join(artifactDir, `council-criteria-${op.kindTag}-r${op.round}.md`);
      writeFileSync(criteriaPath, op.criteriaText, 'utf8');
      const timeoutMs = advisorCouncilTimeoutMs(ids.map((id) => harnessObj.models?.[id] ?? {}), subjectBytes, fixedBytes);
      for (const member of pendingMembers) {
        const meta = invocationMeta.get(member.label)!;
        running.set(
          member.label,
          beginInvocation({
            id: meta.id,
            phaseId: `${op.kindTag}-review-${op.round}`,
            role: 'reviewer',
            reviewerId: member.label,
            binding: {
              runner: 'harness',
              model: member.councilId,
              family: member.family,
            },
            inputSha256: meta.inputSha256,
            promptPath: criteriaPath,
          }),
        );
      }
      if (existsSync(resultFile)) {
        renameSync(resultFile, `${resultFile}.previous-${randomUUID()}`);
      }
      const reviewSubjectBefore = await snapshotReviewSubject(host.cwd);
      if (host.isCancelled()) {
        for (const invocation of running.values()) finishInvocation(invocation, 'interrupted', { error: 'run cancelled' });
        return null;
      }
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
          '--prompt-dir',
          artifactDir,
        ],
        {
          timeoutMs,
          onSpawn: (identity) => {
            for (const invocation of running.values()) {
              invocation.process = { ...identity };
              persist();
              emitInvocation(invocation);
            }
          },
        },
      );
      if (host.isCancelled()) {
        for (const invocation of running.values()) {
          finishInvocation(invocation, 'interrupted', { error: 'run cancelled' });
        }
        return null;
      }
      const reviewSubjectAfter = await snapshotReviewSubject(host.cwd);
      if (reviewSubjectAfter !== reviewSubjectBefore) {
        error = COUNCIL_SUBJECT_CHANGED_ERROR;
        for (const invocation of running.values()) {
          finishInvocation(invocation, 'failed', { error });
        }
        return { rows, error };
      }
      let raw: unknown = null;
      let resultReadError: string | null = null;
      if (existsSync(resultFile)) {
        try {
          raw = JSON.parse(readHarnessArtifactText(resultFile, resultMaxBytes)) as unknown;
        } catch (readError) {
          resultReadError = readError instanceof Error ? readError.message : String(readError);
        }
      }
      const parsedCouncil = raw === null ? null : councilResultSchema.safeParse(raw);
      if (!parsedCouncil?.success) {
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
          error = resultReadError
            ? `advisor council result could not be read safely: ${resultReadError}`
            : `advisor council wrote no result file at ${resultFile}`;
        } else {
          error = `advisor council failed: ${(result.error ?? result.stderr.slice(-300)).trim() || `exit ${result.exitCode}, no diagnostics on stderr`}`;
        }
        for (const invocation of running.values()) {
          finishInvocation(invocation, isUsageLimitMessage(error ?? '') ? 'interrupted' : 'failed', { error });
        }
      } else {
        for (const member of pendingMembers) {
          const row = parsedCouncil.data.reviewers.find((r) => r.id === member.councilId);
          const review = row?.status === 'completed' ? advisorReviewSchema.safeParse(row.review) : null;
          const reviewError =
            review && !review.success
              ? `advisor ${member.label} returned a review cezar could not read: ${review.error.issues
                  .slice(0, 3)
                  .map((i) => `${i.path.join('.')}: ${i.message}`)
                  .join('; ')}`
              : null;
          const completed = review?.success === true;
          const failureReason = completed ? undefined :
            reviewError ?? (typeof row?.error === 'string' ? row.error : null) ??
            ((result.error ?? result.stderr.slice(-300)).trim() ||
              `advisor returned status ${row?.status ?? 'missing'}`);
          rows.push({
            id: member.label,
            runner: 'harness',
            model: member.councilId,
            family: member.family,
            status: completed ? 'completed' : reviewError ? 'failed' : (row?.status ?? 'failed'),
            freshContext: true,
            verdict: completed ? review.data.verdict : null,
            findings: completed ? review.data.findings : [],
            ...(failureReason !== undefined ? { error: failureReason } : {}),
          });
          const invocation = running.get(member.label)!;
          const promptPath = typeof row?.promptPath === 'string' ? row.promptPath : null;
          if (promptPath && existsSync(promptPath)) invocation.promptPath = promptPath;
          if (completed) {
            const meta = invocationMeta.get(member.label)!;
            writeJsonAtomic(meta.artifactPath, review.data);
            finishInvocation(invocation, 'completed', {
              artifactPath: meta.artifactPath,
              modelId: member.label,
            });
          } else {
            finishInvocation(invocation, isUsageLimitMessage(failureReason ?? '') ? 'interrupted' : 'failed', {
              error: failureReason,
            });
          }
        }
      }
    } catch (err) {
      error = `advisor council failed: ${err instanceof Error ? err.message : String(err)}`;
      for (const invocation of running.values()) {
        if (invocation.status === 'running') finishInvocation(invocation, isUsageLimitMessage(error ?? '') ? 'interrupted' : 'failed', { error });
      }
    }
    return { rows, error };
  };

  /**
   * The advisor council, with one bounded second attempt when the subject
   * changed underneath it.
   *
   * A subject change mid-council rejects every reviewer by design — cezar
   * cannot attribute a shared change to an individual. But rejecting used to be
   * TERMINAL: one write landing inside the council window (run 5f6fe8ae) failed
   * quorum and killed the run outright, discarding completed paid reviews. The
   * op itself re-snapshots the subject at entry and its recovery path can adopt
   * reviews written during a rejected attempt when their contract hash matches,
   * so a single retry against the now-current subject is cheap — often free —
   * and the second failure still fails the run: something rewriting the
   * worktree CONTINUOUSLY is a real integrity problem, not a race.
   */
  /** Settle both council groups before either failure propagates, so a rejected
   *  runner pool never strands the advisor promise unhandled. */
  const settleCouncilGroups = async <A>(
    runnerWork: Promise<unknown>,
    advisorWork: Promise<A> | null,
  ): Promise<A | null> => {
    const [runner, advisor] = await Promise.allSettled([runnerWork, advisorWork]);
    if (runner.status === 'rejected') throw runner.reason;
    if (advisor.status === 'rejected') throw advisor.reason;
    return advisor.value;
  };

  const runAdvisorCouncilOpGuardingSubject = async (
    op: Parameters<typeof runAdvisorCouncilOp>[0],
  ): ReturnType<typeof runAdvisorCouncilOp> => {
    const first = await runAdvisorCouncilOp(op);
    if (first === null || first.error === null || !isCouncilSubjectChangedError(first.error)) {
      return first;
    }
    if (host.isCancelled()) return first;
    host.emit({
      type: 'note',
      message:
        'the review subject changed while the advisor council was running — retrying the ' +
        'council once against the current subject before giving up',
    });
    return runAdvisorCouncilOp(op);
  };

  /** One in-round second attempt for advisors that failed in a way a retry can change, as
   *  session reviewers get: the runtime's own retry loop is off. */
  const runAdvisorCouncilOpWithRetry = async (
    op: Parameters<typeof runAdvisorCouncilOp>[0],
  ): ReturnType<typeof runAdvisorCouncilOp> => {
    const invocationOf = (member: { label: string }) =>
      ledger.invocations.find((entry) => entry.id === advisorInvocationId(op, member));
    const endedBefore = new Map(op.members.map((member) => [member.label, invocationOf(member)?.endedAt]));
    const first = await runAdvisorCouncilOpGuardingSubject(op);
    if (first === null || op.proceedAccepted || host.isCancelled()) return first;
    if (first.error !== null && isCouncilSubjectChangedError(first.error)) return first;
    const retry = op.members.filter((member) => {
      const invocation = invocationOf(member);
      return (
        invocation?.status === 'failed' &&
        !first.rows.some((row) => row.id === member.label && ['timed_out', 'skipped'].includes(String(row.status))) &&
        invocation.endedAt !== endedBefore.get(member.label) &&
        typeof invocation.error === 'string' &&
        isRetryableReviewerFailure(invocation.error) &&
        !isUsageLimitMessage(invocation.error) &&
        !isCouncilSubjectChangedError(invocation.error)
      );
    });
    if (retry.length === 0) return first;
    host.emit({
      type: 'note',
      message: `retrying advisor reviewer(s) ${retry.map((member) => member.label).join(', ')} once`,
    });
    const second = await runAdvisorCouncilOpGuardingSubject({ ...op, members: retry });
    if (second === null) return null;
    const retried = new Set(retry.map((member) => member.label));
    return {
      rows: [...first.rows.filter((row) => !retried.has(String(row.id))), ...second.rows],
      error: second.error,
    };
  };

  /** An op error fails only the members it returned no row for: reviews it reused or recovered
   *  stay completed. */
  const foldAdvisorRun = (
    advisorRun: { rows: Array<Record<string, unknown>>; error: string | null },
    members: ReadonlyArray<{ label: string; family?: string }>,
    outcomes: CouncilOutcome[],
    councilReviewers: Array<Record<string, unknown>>,
    stepId: string,
  ): void => {
    councilReviewers.push(...advisorRun.rows);
    for (const row of advisorRun.rows) {
      outcomes.push({
        label: String(row.id),
        family: typeof row.family === 'string' ? row.family : undefined,
        status: row.status === 'completed' ? 'completed' : 'failed',
        reason: typeof row.error === 'string' ? row.error : undefined,
      });
    }
    if (!advisorRun.error) return;
    const covered = new Set(advisorRun.rows.map((row) => String(row.id)));
    for (const member of members.filter((entry) => !covered.has(entry.label))) {
      outcomes.push({ label: member.label, family: member.family, status: 'failed', reason: advisorRun.error });
      councilReviewers.push({ id: member.label, status: 'failed', reason: advisorRun.error });
    }
    host.emit({
      type: 'note',
      stepId,
      message: `advisor council produced no result (${advisorRun.error}) — continuing with the runner reviewers`,
    });
  };

  type CouncilFinding = ReviewResult['findings'][number] & { by?: string };

  /**
   * One council round — the spec and implementation councils share it. Runner reviewers fan out
   * over one read-only subject (2026-07-25) beside the advisor council (2026-07-29); each gets its
   * attempt budget, the subject is re-verified, the quorum gate decides, and findings merge by
   * severity and title. `stop` is the run's error, or null when it was cancelled.
   */
  const runCouncilRound = async (council: {
    kind: 'spec' | 'implementation';
    round: number;
    councilId: string;
    councilName: string;
    skill: string;
    reviewers: HarnessReviewerRef[];
    reviewerName: (label: string) => string;
    /** The reviewer prompt, before the boundary-message appendix. */
    promptText: string;
    subjectSha256: string;
    currentSubjectSha256: () => Promise<string | null>;
    /** Appended to every reviewer's input hash, after the rubric. */
    hashExtra?: Record<string, unknown>;
    /** The advisor council's criteria, before the boundary-message appendix. */
    advisorCriteria: string;
    advisorArtifact?: string;
  }): Promise<{ stop: string | null } | { verdict: 'approve' | 'request_changes'; findings: CouncilFinding[] }> => {
    const { kind, round, councilId, skill } = council;
    const councilWasDone = phaseDone(councilId);
    const councilBoundaryMessages = boundaryMessagesForPhase(councilId, councilWasDone);
    if (!councilWasDone) assignBoundaryMessages(councilId, councilBoundaryMessages);
    const councilBoundaryAppendix = boundaryMessageAppendix(councilBoundaryMessages);
    host.upsertStep({ id: councilId, name: council.councilName, kind: 'agent' });
    if (!councilWasDone) {
      startPhase(ledger, { id: councilId, name: council.councilName, kind: 'agent', skill });
      persist();
      host.setStepStatus(councilId, 'running');
      emitPhase(councilId);
    }
    const promptText = `${council.promptText}${councilBoundaryAppendix}`;
    const rubricSha256 = skillHash(skill);
    const councilReviewers: Array<Record<string, unknown>> = [];
    const outcomes: CouncilOutcome[] = [];
    const split = splitReviewers(council.reviewers);
    const emitCouncil = (extra: { verdict: 'approve' | 'request_changes' | null; findings?: CouncilFinding[] }) =>
      host.emit({
        type: 'harness.council.updated',
        stepId: councilId,
        council: { round, kind, reviewers: councilReviewers, ...extra },
      });
    const runnerWork = pool(split.sessions, MAX_PARALLEL_REVIEWERS, containReviewerThrow(councilId, outcomes, councilReviewers, async (reviewer, idx) => {
      if (host.isCancelled()) return;
      const label = roleRefId(reviewer);
      const resultPath = ownResultPath(`phase-${councilId}-r${idx + 1}`);
      const renderedPrompt = `${promptText
        .replaceAll('$CEZ_HARNESS_RESULT_FILE', resultPath)
        .replaceAll('$CEZ_HARNESS_ARTIFACT_DIR', dirname(resultPath))}\n\n${phaseLocationContract(skill, dirname(resultPath))}\n\n${PHASE_SESSION_CONTRACT}`;
      const budgetError = promptBudgetError(completeModelPrompt(skill, renderedPrompt));
      if (budgetError) {
        outcomes.push({ label, family: councilFamilyOf(reviewer), status: 'failed', reason: budgetError });
        councilReviewers.push({ id: label, status: 'failed', reason: budgetError });
        return;
      }
      const invocationId = `reviewer:${councilId}:${label}`;
      const inputSha256 = sha256(
        JSON.stringify({
          inputHashVersion: 2,
          kind: `${kind}-review`,
          phaseId: councilId,
          reviewer,
          prompt: renderedPrompt,
          subjectSha256: council.subjectSha256,
          rubricSha256,
          ...council.hashExtra,
        }),
      );
      let parsed = reusableInvocation(invocationId, inputSha256, reviewResultSchema);
      if (parsed !== null) {
        host.emit({ type: 'note', stepId: councilId, message: `reused completed reviewer ${label} from the durable ledger` });
      }
      const priorAttempts = attemptsForInput(invocationId, inputSha256);
      // "Proceed with the survivors" ignores a reviewer that already failed: paying for it
      // again before the decision applies is what the user declined.
      const proceeding =
        reviewerFailedBefore(invocationId, inputSha256) &&
        councilProceedAccepted(kind, round, council.subjectSha256);
      let lastFailure: string | null = proceeding ? priorReviewerFailure(invocationId) : null;
      let lastContractFailure: string | null = null;
      for (
        let attempt = priorAttempts + 1;
        // A recorded `council.retry` decision extends the budget of 2.
        !proceeding && attempt <= 2 + councilRetryAllowance(kind, round, council.subjectSha256) && parsed === null;
        attempt += 1
      ) {
        const attemptPrompt =
          attempt > 1 && lastContractFailure
            ? `${renderedPrompt}${resultContractRetryAppendix(lastContractFailure, resultPath, false)}`
            : renderedPrompt;
        const attemptBudgetError = promptBudgetError(completeModelPrompt(skill, attemptPrompt));
        if (attemptBudgetError) {
          lastFailure = attemptBudgetError;
          break;
        }
        const invocation = beginInvocation({
          id: invocationId,
          phaseId: councilId,
          role: 'reviewer',
          reviewerId: label,
          binding: {
            runner: reviewer.runner,
            model: reviewer.model || undefined,
            effort: reviewer.effort,
            family: councilFamilyOf(reviewer),
          },
          inputSha256,
          prompt: completeModelPrompt(skill, attemptPrompt),
        });
        // A failed prior attempt can leave a result file behind; attempt 2 of run 0fe16fb7 read
        // one, announced "the file already exists", and set about editing it. Every attempt starts clean.
        rmSync(resultPath, { recursive: true, force: true });
        const failure = await runReadOnlyReviewer(invocation, {
          concurrent: true,
          phaseId: councilId,
          name: council.reviewerName(label),
          skill,
          prompt: attemptPrompt,
          resultPath,
          timeoutMs: PHASE_TIMEOUTS_MS.review ?? 30 * 60_000,
          env: { CEZ_HARNESS_RESULT_FILE: resultPath, CEZ_HARNESS_ARTIFACT_DIR: dirname(resultPath) },
          runner: reviewer.runner,
          model: reviewer.model,
          effort: reviewer.effort,
        });
        if (host.isCancelled()) {
          finishInvocation(invocation, 'interrupted', { error: 'run cancelled' });
          return;
        }
        if (failure) {
          lastFailure = failure;
          const limited = isUsageLimitMessage(failure);
          finishInvocation(invocation, limited || classifyAgentFailure(failure) === 'transient' ? 'interrupted' : 'failed', { error: failure });
          if (limited || !isRetryableReviewerFailure(failure)) break;
          // The subject changed under this reviewer and stayed changed: the round is void, so a
          // retry would only pay to review an edit no gate validated.
          if (failure.startsWith(REVIEWER_MUTATION_FAILURE) && (await council.currentSubjectSha256()) !== council.subjectSha256) break;
          continue;
        }
        const read = readReviewResultFile(resultPath);
        parsed = read.result;
        if (read.salvaged) {
          host.emit({
            type: 'note',
            stepId: councilId,
            message: `reviewer ${label} wrapped its result JSON in prose — salvaged the embedded review`,
          });
        }
        if (parsed === null) {
          lastFailure = read.failure ?? 'ended without a valid result file';
          lastContractFailure = lastFailure.replace(/^the session /, '');
          finishInvocation(invocation, 'failed', { error: lastFailure });
        } else {
          finishInvocation(invocation, 'completed', { artifactPath: resultPath, modelId: label });
        }
      }
      if (parsed === null) {
        const reason = lastFailure ?? priorReviewerFailure(invocationId);
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
      const coerced = coerceReviewVerdict(parsed);
      councilReviewers.push({
        id: label,
        ...reviewer,
        status: 'completed',
        freshContext: true,
        verdict: coerced.verdict,
        findings: parsed.findings,
      });
      if (coerced.coercedFrom) {
        host.emit({
          type: 'note',
          stepId: councilId,
          message:
            `reviewer ${label} reported "${coerced.coercedFrom}" alongside its own ` +
            `blocker/major findings — verdict coerced to "${coerced.verdict}"`,
        });
      }
      emitCouncil({ verdict: null });
    }));
    const advisorWork =
      split.members.length > 0 && !host.isCancelled()
        ? runAdvisorCouncilOpWithRetry({
            kindTag: kind === 'spec' ? 'spec' : 'impl',
            round,
            members: split.members,
            retryAllowance: councilRetryAllowance(kind, round, council.subjectSha256),
            proceedAccepted: councilProceedAccepted(kind, round, council.subjectSha256),
            criteriaText: `${council.advisorCriteria}${councilBoundaryAppendix}`,
            ...(council.advisorArtifact ? { artifact: council.advisorArtifact } : {}),
          })
        : null;
    const advisorRun = await settleCouncilGroups(runnerWork, advisorWork);
    // A cancelled reviewer records no outcome: gating on the survivors would park a
    // stopped run on a false "below quorum" decision.
    if (host.isCancelled()) return { stop: null };
    const subjectIssue = await councilSubjectIssue(council.subjectSha256, council.currentSubjectSha256);
    if (subjectIssue) {
      finishPhase(ledger, councilId, 'failed', subjectIssue);
      persist();
      host.setStepStatus(councilId, 'failed', subjectIssue);
      emitPhase(councilId);
      return { stop: subjectIssue };
    }
    if (advisorWork !== null) {
      if (advisorRun === null) return { stop: null };
      foldAdvisorRun(advisorRun, split.members, outcomes, councilReviewers, councilId);
      if (!advisorRun.error) emitCouncil({ verdict: null });
    }
    const gate = resolveCouncilGate(kind, round, outcomes, councilId, council.subjectSha256);
    if (!gate.proceed) {
      finishPhase(ledger, councilId, 'failed', gate.error);
      upsertCouncil(kind, round, { round, kind, reviewers: councilReviewers, verdict: null });
      persist();
      host.setStepStatus(councilId, 'failed', gate.error);
      emitPhase(councilId);
      return { stop: gate.error };
    }
    const byKey = new Map<string, CouncilFinding>();
    for (const entry of councilReviewers) {
      const label = entry.id as string;
      for (const finding of (entry.findings as ReviewResult['findings'] | undefined) ?? []) {
        const key = `${finding.severity}|${finding.title}`;
        const current = byKey.get(key);
        if (current) current.by = `${current.by}, ${label}`;
        else byKey.set(key, { ...finding, by: label });
      }
    }
    const findings = [...byKey.values()];
    const verdict: 'approve' | 'request_changes' = councilReviewers.some((r) => r.verdict === 'request_changes')
      ? 'request_changes'
      : 'approve';
    finishPhase(ledger, councilId, 'done');
    upsertCouncil(kind, round, { round, kind, reviewers: councilReviewers, verdict, findings });
    const consumedMessageIds = completeBoundaryMessages(councilId, councilBoundaryMessages);
    persist();
    host.setStepStatus(councilId, 'done');
    emitPhase(councilId);
    emitBoundaryMessagesConsumed(councilId, consumedMessageIds);
    emitCouncil({ verdict, findings });
    return { verdict, findings };
  };

  const findingsPrompt = (name: string, findings: readonly ReviewResult['findings'][number][]): string => {
    const path = join(artifactDir, `findings-${name}.json`);
    writeJsonAtomic(path, findings);
    return boundedFindings(findings, path);
  };

  try {

    const startStatePath = join(artifactDir, 'start-state.json');
    const captureInvocationId = 'runtime:capture';
    const captureInputSha256 = sha256(
      JSON.stringify({
        inputHashVersion: 2,
        operation: 'capture',
        worktree: host.cwd,
      }),
    );
    const recoveredCapture = reusableInvocation(
      captureInvocationId,
      captureInputSha256,
      z.record(z.string(), z.unknown()),
    );
    if (recoveredCapture && !phaseDone('capture')) {
      startPhase(ledger, { id: 'capture', name: 'Capture', kind: 'op' });
      finishPhase(ledger, 'capture', 'done');
      persist();
      host.setStepStatus('capture', 'done');
      emitPhase('capture');
    }
    if (phaseDone('capture') && !recoveredCapture) {
      invalidateFollowingPhases('capture');
      const phase = ledger.phases.find((entry) => entry.id === 'capture');
      if (phase) phase.status = 'pending';
    }
    const captureError = recoveredCapture
      ? null
      : await opPhase('capture', 'Capture', async () => {
          const invocation = beginInvocation({
            id: captureInvocationId,
            phaseId: 'capture',
            role: 'runtime',
            binding: { runner: 'harness', model: 'capture' },
            inputSha256: captureInputSha256,
          });
          const result = await runtime.run(
            'capture',
            ['--worktree', host.cwd, '--output', startStatePath],
            {
              onSpawn: (identity) => {
                invocation.process = { ...identity };
                persist();
                emitInvocation(invocation);
              },
            },
          );
          if (!result.ok) {
            const error = `capture failed: ${
              (result.error ?? result.stderr ?? '').trim() || 'non-zero exit'
            }`;
            finishInvocation(invocation, 'failed', { error });
            return { ok: false, error };
          }
          if (!existsSync(startStatePath)) {
            const error = 'capture reported success but wrote no start-state artifact';
            finishInvocation(invocation, 'failed', { error });
            return { ok: false, error };
          }
          finishInvocation(invocation, 'completed', {
            artifactPath: startStatePath,
          });
          return { ok: true };
        });
    if (captureError === 'cancelled') return null;
    if (captureError) return captureError;

    /**
     * The gate's reference point: the same validation commands, run once on
     * the still-untouched worktree. A red baseline is the repo's own debt —
     * run c54c2ed4 spent every repair round on a `yarn test` failure that
     * predated its first edit, then died reporting it. Later gates compare
     * against this and block only on regressions the run introduced.
     *
     * Fails OPEN and loud: a baseline that cannot run leaves
     * `ledger.baselineValidation` unset (delta gating off, today's strict
     * behavior), because an infrastructure hiccup here must not kill a run.
     */
    const baselineGateId = 'baseline-gate';
    if (
      runtimeAgentic.validationCommands.length > 0 &&
      ledger.baselineValidation === undefined &&
      !phaseDone(baselineGateId)
    ) {
      const agentWorkStarted = ledger.phases.some((phase) => phase.kind === 'agent');
      if (agentWorkStarted) {
        host.emit({
          type: 'note',
          stepId: 'capture',
          message:
            'this run started before the baseline gate existed and has already run agent phases — ' +
            'pre-existing validation failures cannot be told apart from regressions, so the gate stays strict',
        });
      } else {
        const baselineArtifactSchema = z.object({
          version: z.literal(1),
          checks: z.array(validationCheckSchema),
        });
        const baselinePath = join(artifactDir, 'validation-baseline.json');
        const baselineInvocationId = 'validation:baseline';
        const baselineInputSha256 = sha256(
          JSON.stringify({
            inputHashVersion: 2,
            operation: 'baseline-validation',
            commands: runtimeAgentic.validationCommands,
            trustedConfigSha256: ledger.trustedConfig?.sha256 ?? null,
          }),
        );
        const recoveredBaseline = reusableInvocation(
          baselineInvocationId,
          baselineInputSha256,
          baselineArtifactSchema,
        );
        if (recoveredBaseline) {
          ledger.baselineValidation = recoveredBaseline.checks;
          startPhase(ledger, { id: baselineGateId, name: 'Baseline gate', kind: 'op' });
          finishPhase(ledger, baselineGateId, 'done');
          persist();
          host.upsertStep({ id: baselineGateId, name: 'Baseline gate', kind: 'check' });
          host.setStepStatus(baselineGateId, 'done');
          emitPhase(baselineGateId);
        } else {
          const baselineError = await opPhase(baselineGateId, 'Baseline gate', async () => {
            const invocation = beginInvocation({
              id: baselineInvocationId,
              phaseId: baselineGateId,
              role: 'validation',
              binding: { runner: 'bash' },
              inputSha256: baselineInputSha256,
            });
            const controller = new AbortController();
            const offBaselineInterrupt = host.onInterrupt(() => controller.abort());
            try {
              const checks = await validate(runtimeAgentic.validationCommands, host.cwd, {
                signal: controller.signal,
                logDir: artifactDir,
                logPrefix: 'validation-baseline-',
                // Every command, so a later one that is red on main has evidence to compare with.
                continueAfter: new Set(runtimeAgentic.validationCommands),
                onSpawn: (identity) => {
                  invocation.process = { ...identity };
                  persist();
                  emitInvocation(invocation);
                },
                onExit: () => {
                  invocation.process = undefined;
                  persist();
                  emitInvocation(invocation);
                },
              });
              if (host.isCancelled()) {
                finishInvocation(invocation, 'interrupted', {
                  error: 'run cancelled during the baseline gate',
                });
                return { ok: true };
              }
              ledger.baselineValidation = checks;
              writeJsonAtomic(baselinePath, { version: 1, checks });
              finishInvocation(invocation, 'completed', { artifactPath: baselinePath });
              const red = checks.filter((check) => check.status === 'failed');
              if (red.length > 0) {
                const detail = red
                  .map(
                    (check) =>
                      `\`${check.command}\`${
                        check.failureIds?.length ? ` (${check.failureIds.join(', ')})` : ''
                      }`,
                  )
                  .join('; ');
                ledger.decisions.push({
                  at: new Date().toISOString(),
                  kind: 'baseline-gate.red',
                  by: 'driver',
                  detail,
                });
                host.emit({
                  type: 'note',
                  stepId: baselineGateId,
                  message:
                    `the validation gate is RED on the untouched worktree: ${detail}. ` +
                    `These failures predate this run — later gates will tolerate them (loudly) and block only on regressions beyond them.`,
                });
              }
              return { ok: true };
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              finishInvocation(invocation, 'failed', { error: detail });
              host.emit({
                type: 'note',
                stepId: baselineGateId,
                message: `the baseline gate could not run (${detail}) — continuing with the strict gate (every failure blocks)`,
              });
              return { ok: true }; // fail open: strict gating is the safe fallback
            } finally {
              offBaselineInterrupt();
            }
          });
          if (baselineError === 'cancelled') return null;
          if (baselineError) return baselineError;
        }
      }
    }

    const baselineUnavailable = ledger.baselineValidation?.find(harnessCheckUnavailable);
    if (!operatorReview && !ledger.phases.some((phase) => phase.kind === 'agent') && baselineUnavailable) {
      ledger.validation = ledger.baselineValidation ?? [];
      ledger.environment = { ...inspectHarnessEnvironment(host.cwd), status: 'needs-setup', detail: baselineUnavailable.evidence };
      if (requestedAction) requestedAction.status = 'failed';
      host.emit({ type: 'harness.environment.updated', environment: ledger.environment });
      setOutcome({ status: 'blocked', blockingReasons: ['Project checks could not run. Prepare the project before implementation.'] });
      return 'Project checks could not run. Prepare the project before implementation.';
    }
    const gitDriftError = async (phaseId: string): Promise<string | null> => {
      if (!existsSync(startStatePath)) return null;
      const result = await runtime.run('verify', [
        '--worktree',
        host.cwd,
        '--start-state',
        startStatePath,
      ]);
      if (result.ok) return null;
      let drift: string[] = [];
      try {
        const parsed = JSON.parse(result.stdout) as { status?: unknown; drift?: unknown };
        if (parsed.status === 'drifted' && Array.isArray(parsed.drift)) {
          drift = parsed.drift.filter((entry): entry is string => typeof entry === 'string');
        }
      } catch {
        return null; // unreadable verdict — leave it to `stage`
      }
      if (drift.length === 0) return null;
      host.emit({
        type: 'note',
        stepId: phaseId,
        message: `git state drifted during "${phaseId}" — stopping now rather than at handoff:\n- ${drift.join('\n- ')}`,
      });
      return `git state changed during "${phaseId}", so this run can no longer produce a staged-only handoff:\n- ${drift.join(
        '\n- ',
      )}`;
    };

    const allowlist = new Set<string>();
    const allowlistOrigin = new Map<string, string>();
    const addToAllowlist = (path: string, phaseId: string): void => {
      allowlist.add(path);
      if (!allowlistOrigin.has(path)) allowlistOrigin.set(path, phaseId);
    };
    /**
     * Explicit assumptions and accepted specification risks that implementation
     * reviewers must retain.
     *
     * On 71edb02c a known open design question vanished before implementation,
     * and the implementation councils then burned their rounds rediscovering
     * and oscillating over it. Carrying assumptions forward prevents that.
     */
    const unresolvedSpecFindings: string[] = [];
    let suggestedCommit: string | undefined;
    let implementSummary: string | undefined;
    let diagnosisSummary = '';
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
     * after a full review round has already been spent. Checked as the phase's
     * result contract, so a rejected result is retried, never reused.
     */
    const specPathViolation = (p: string): string | null => {
      if (!p || p.startsWith('/') || p.split('/').includes('..')) {
        return `returned an unsafe spec path: ${p}`;
      }
      // Every directory, not only the leaf: through a symlinked one the unsandboxed runtime read a
      // file the sandbox denies and sent it to the reviewers.
      let parent: string | null = null;
      try {
        parent = realpathSync(join(host.cwd, dirname(p)));
      } catch {
        // a missing directory is reported below
      }
      if (parent !== null && parent !== join(realpathSync(host.cwd), dirname(p))) {
        return `reported "${p}" through a symlinked directory; write the spec as a regular file inside the run worktree`;
      }
      if (!existsSync(join(host.cwd, p))) {
        return existsSync(join(host.repoRoot, p))
          ? `wrote "${p}" to the main checkout (${join(host.repoRoot, p)}) ` +
              `instead of the run worktree (${host.cwd}). Reviewers read the worktree copy, so the ` +
              `council would fail on a spec that looks present. Write the spec inside the worktree.`
          : `reported "${p}" but no such file exists in the run worktree (${host.cwd})`;
      }
      if (!hashFile(join(host.cwd, p))) {
        return `reported "${p}", which is not a regular file in the run worktree (symlinks are refused)`;
      }
      return null;
    };
    const acceptSpecResult =
      roles && roles.reviewers.length > 0
        ? (result: z.infer<typeof specResultSchema>) => specPathViolation(result.specPath)
        : undefined;
    if (operatorReview) {
      implementSummary = ledger.stage.prBody?.split('\n## Validation')[0] ?? input.task;
    } else if (isFeature) {
      const spec = await agentPhase(
        'spec',
        'Specify',
        phaseSkills.specWriting,
        [
          `Write the specification for this feature brief, following the already-injected ${phaseSkills.specWriting} instructions in full.`,
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
          `This session is non-interactive, so any Open Questions gate cannot stop on the user: answer each open question yourself with the most defensible assumption, record question + chosen assumption in the spec's Open Questions section, and list them in the result's "openQuestions".`,
          `When you are done write a JSON result file at the path in $CEZ_HARNESS_RESULT_FILE of the shape:`,
          `{"summary": "<one-paragraph spec summary>", "specPath": "<repo-relative path of the spec file>", "files": ["<spec file>"], "openQuestions": ["<question> — assumed: <the assumption you proceeded under>"]}`,
        ].join('\n'),
        specResultSchema,
        'spec',
        roles?.orchestrator,
        acceptSpecResult,
      );
      if ('cancelled' in (spec as object)) return null;
      if ('error' in (spec as object)) return (spec as { error: string }).error;
      const specResult = spec as z.infer<typeof specResultSchema>;
      let finalSpecPath = specResult.specPath;
      diagnosisSummary = specResult.summary;
      for (const f of specResult.files ?? []) allowlist.add(f);
      if (specResult.openQuestions?.length) {
        unresolvedSpecFindings.push(
          ...specResult.openQuestions.map((q) => `[open-question] ${q}`),
        );
        host.emit({
          type: 'note',
          stepId: 'spec',
          message:
            `the spec proceeded under ${specResult.openQuestions.length} recorded assumption${
              specResult.openQuestions.length === 1 ? '' : 's'
            } (non-interactive Open Questions gate):\n- ${specResult.openQuestions.join('\n- ')}`,
        });
      }

      // Spec council (2026-07-24, parity with the upstream multi wrapper):
      // each of the three bounded cycles is a pre-implementation audit followed
      // by a spec-writing repair when findings remain. The final cycle still
      // gets its repair; the budget limits fresh audits, not fixes for findings
      // Cezar has already paid to discover. Role-based runs only — `standard`
      // keeps one standalone pre-implementation audit.
      if (roles && roles.reviewers.length > 0) {
        const MAX_SPEC_ROUNDS = 3;
        const specOrchestrator = roles.orchestrator;
        const specBasis = sha256(JSON.stringify(specResult));
        const recordedSpecRounds =
          ledger.rounds?.spec?.basis === specBasis ? ledger.rounds.spec : undefined;
        let specPath = recordedSpecRounds?.specPath ?? finalSpecPath;
        const revisedFiles = new Set(recordedSpecRounds?.files ?? []);
        if (recordedSpecRounds) {
          finalSpecPath = specPath;
          diagnosisSummary = recordedSpecRounds.summary;
          for (const f of revisedFiles) allowlist.add(f);
        }
        const saveSpecRounds = (
          round: number,
          extra: { findings?: AttributedFinding[]; done?: true } = {},
        ): void => {
          ledger.rounds = {
            ...ledger.rounds,
            spec: {
              round,
              basis: specBasis,
              specPath,
              summary: diagnosisSummary,
              files: [...revisedFiles],
              ...extra,
            },
          };
          persist();
        };
        /** Answer a council's findings in the spec; `undefined` once revised,
         *  otherwise what the driver returns. */
        const reviseSpec = async (
          sround: number,
          specFindings: AttributedFinding[],
        ): Promise<string | null | undefined> => {
          const revise = await agentPhase(
            `spec-${sround + 1}`,
            `Revise spec (round ${sround} feedback)`,
            phaseSkills.specWriting,
            [
              `The spec council requested changes on the specification at ${specPath}. Address every finding, update the spec file in place, and keep it implementation-accurate.`,
              ``,
              `Findings:`,
              findingsPrompt(`spec-${sround}`, specFindings),
              ``,
              `When you are done write a JSON result file at the path in $CEZ_HARNESS_RESULT_FILE of the shape:`,
              `{"summary": "<one-paragraph summary of the revision>", "specPath": "<repo-relative spec path>", "files": ["<spec file>"]}`,
            ].join('\n'),
            specResultSchema,
            'spec',
            specOrchestrator,
            acceptSpecResult,
          );
          if ('cancelled' in (revise as object)) return null;
          if ('error' in (revise as object)) return (revise as { error: string }).error;
          const revised = revise as z.infer<typeof specResultSchema>;
          specPath = revised.specPath;
          finalSpecPath = specPath;
          diagnosisSummary = revised.summary;
          for (const f of revised.files ?? []) {
            allowlist.add(f);
            revisedFiles.add(f);
          }
          if (sround === MAX_SPEC_ROUNDS) {
            if (!ledger.decisions.some((decision) => decision.kind === 'spec.closing-fixes')) {
              ledger.decisions.push({
                at: new Date().toISOString(),
                kind: 'spec.closing-fixes',
                by: 'driver',
                detail: `round:${sround}`,
              });
            }
            persist();
            host.emit({
              type: 'note',
              stepId: `spec-${sround + 1}`,
              message:
                `applied the findings from pre-implementation audit ${sround}/${MAX_SPEC_ROUNDS}; ` +
                `the audit budget is exhausted, so implementation continues without buying a fourth audit`,
            });
          }
          saveSpecRounds(sround + 1, sround === MAX_SPEC_ROUNDS ? { done: true } : {});
          return undefined;
        };
        const firstSpecRound = recordedSpecRounds?.round ?? 1;
        // A finished loop is history: implementation already built on its spec.
        for (
          let sround = firstSpecRound;
          sround <= MAX_SPEC_ROUNDS && !recordedSpecRounds?.done;
          sround += 1
        ) {
          if (host.isCancelled()) return null;
          // A council that already asked for changes is not paid for again.
          const pendingRevision =
            sround === firstSpecRound ? recordedSpecRounds?.findings : undefined;
          if (pendingRevision) {
            const stop = await reviseSpec(sround, pendingRevision);
            if (stop !== undefined) return stop;
            continue;
          }
          const specViolation = specPathViolation(specPath);
          if (specViolation) return `the spec phase ${specViolation}`;
          let specBytes: Buffer | null = null;
          try {
            const entry = readHarnessFsEntry(join(host.cwd, specPath), HARNESS_JSON_ARTIFACT_MAX_BYTES * 4);
            if (entry.kind === 'file') specBytes = entry.content;
          } catch {
            // reported below
          }
          if (!specBytes) {
            return `could not hash the specification before council round ${sround}: ${specPath}`;
          }
          const specSubjectSha256 = sha256(specBytes);
          // The runtime reads its subject unsandboxed: it gets these verified bytes, never a worktree
          // path a reviewer could re-point mid-council.
          const specArtifact = join(artifactDir, `spec-subject-r${sround}.md`);
          writeFileSync(specArtifact, specBytes);
          const councilId = sround === 1 ? 'spec-review' : `spec-review-${sround}`;
          const councilName = `Spec council (round ${sround})`;
          const specRound = await runCouncilRound({
            kind: 'spec',
            round: sround,
            councilId,
            councilName,
            skill: phaseSkills.preImplement,
            reviewers: roles.reviewers,
            reviewerName: (label) => `${councilName} — ${label}`,
            promptText: [
              `You are a FRESH review context. Audit the feature SPECIFICATION at ${specPath} (read it from this worktree) to staff-engineer standard, following the already-injected ${phaseSkills.preImplement} instructions in full: risks, backward compatibility, security, data/API contracts, migration and rollback safety, testability, gaps, implementation-readiness, and simplicity.`,
              ``,
              `The feature brief: ${input.task}`,
              ``,
              `When you are done write a JSON result file at the path in $CEZ_HARNESS_RESULT_FILE of the shape:`,
              `{"verdict": "approve" | "request_changes", "findings": [{"severity": "blocker|major|minor|nit", "title": "…", "location": "path:line", "evidence": "…"}]}`,
              `Any blocker or major finding means "request_changes"; only minor/nit findings (or none) means "approve".`,
            ].join('\n'),
            subjectSha256: specSubjectSha256,
            currentSubjectSha256: async () => hashFile(join(host.cwd, specPath)),
            advisorCriteria: [
              `Spec council criteria (run ${host.runId}).`,
              ``,
              `The subject is the feature SPECIFICATION at ${specPath} — not a code diff.`,
              `Feature brief: ${input.task}`,
              ``,
              `Judge risks, backward compatibility, gaps, implementation-readiness, and simplicity.`,
            ].join('\n'),
            advisorArtifact: specArtifact,
          });
          if ('stop' in specRound) return specRound.stop;
          const { verdict: specVerdict, findings: specFindings } = specRound;
          if (specVerdict === 'approve') {
            saveSpecRounds(sround, { done: true });
            break;
          }
          saveSpecRounds(sround, { findings: specFindings });
          const stop = await reviseSpec(sround, specFindings);
          if (stop !== undefined) return stop;
        }
      }

      if (!roles || roles.reviewers.length === 0) {
        const preImplement = await agentPhase(
          'pre-implement',
          'Pre-implementation audit',
          phaseSkills.preImplement,
          [
            `Audit the completed specification at ${finalSpecPath} before implementation.`,
            `Follow the already-injected pre-implementation instructions in full: verify backward compatibility,`,
            `security, data/API contracts, migration and rollback safety, testability, and whether`,
            `the plan is concrete enough to implement without guessing.`,
            ``,
            `Feature brief: ${input.task}`,
            ``,
            `This phase is read-only. Save the detailed report under $CEZ_HARNESS_ARTIFACT_DIR.`,
            `When done, write a result file at $CEZ_HARNESS_RESULT_FILE of the shape:`,
            `{"status":"ready|blocked","summary":"…","reportPath":"<absolute or artifact-relative report path>","findings":[{"severity":"blocker|major|minor","title":"…","evidence":"…"}]}`,
            `Use "blocked" whenever a blocker or major design gap remains.`,
          ].join('\n'),
          preImplementResultSchema,
          'spec',
          roles?.orchestrator,
        );
        if ('cancelled' in (preImplement as object)) return null;
        if ('error' in (preImplement as object)) return (preImplement as { error: string }).error;
        const preImplementResult = preImplement as z.infer<typeof preImplementResultSchema>;
        const preImplementBlockers = preImplementResult.findings.filter(
          (finding) => finding.severity === 'blocker' || finding.severity === 'major',
        );
        if (
          (preImplementResult.status === 'blocked' || preImplementBlockers.length > 0) &&
          !ledger.decisions.some(
            (decision) => decision.kind === 'spec.accept' && decision.detail === 'pre-implement:1',
          )
        ) {
          const findings = decisionFindings(
            preImplementBlockers.map(
              (finding) => `[${finding.severity}] ${finding.title}: ${finding.evidence}`,
            ),
            preImplementResult.summary,
          );
          setOutcome({
            status: 'contested',
            blockingReasons: findings,
            pendingDecision: {
              kind: 'spec',
              gate: 'pre-implement',
              round: 1,
              findings,
            },
          });
          return 'pre-implementation audit found unresolved specification risks; explicit acceptance is required before implementation';
        }
      }
    } else {
      const qualify = await agentPhase(
        'qualify',
        'Qualify',
          phaseSkills.qualify,
        [
          `Qualify this tracker issue with the ${phaseSkills.qualify} skill: decide whether it is a real, still-unfixed defect on the current branch.`,
          ``,
          `Issue:`,
          input.task,
          ``,
          `Cezar already holds the run-local issue lease. Skip the skill's tracker claim and all tracker mutations.`,
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
        setOutcome({ status: 'no-action', blockingReasons: [] });
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
        phaseSkills.diagnose,
        [
          `Diagnose the root cause of this issue with the ${phaseSkills.diagnose} skill. Read-only — locate the cause and the minimal change surface; do not fix anything yet.`,
          ``,
          `Issue:`,
          input.task,
          ``,
          `Qualification evidence: ${qualifyResult.evidence}`,
          ``,
          `Use the supplied issue text and evidence as the chain input. Do not claim or mutate the tracker.`,
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

    const agentic = runtimeAgentic;
    type AttributedFinding = ReviewResult['findings'][number] & { by?: string };
    let reviewFindings: AttributedFinding[] = [];
    let survivingBlockers: AttributedFinding[] = [];

    const firstImplementPrompt = [
      isFeature
        ? `Implement this feature in the current worktree, following the specification summary below.`
        : `Fix this issue in the current worktree with the ${phaseSkills.fix} skill. Add the mandatory regression test and prove the complete fix through its validation workflow.`,
      ``,
      `Task:`,
      input.task,
      ``,
      `${isFeature ? 'Specification' : 'Diagnosis'}: ${diagnosisSummary}`,
      ``,
      `Hard boundaries: edit only this worktree; create NO commit; perform NO push, PR, or other remote write; do not weaken or delete tests.`,
      `When you are done write a JSON result file at the path in $CEZ_HARNESS_RESULT_FILE of the shape:`,
      `{"changedPaths": ["<every repo-relative file you changed or created>"], "summary": "<what changed and why>", "suggestedCommit": "<conventional commit subject>"}`,
    ].join('\n');
    // A resume continues the loop this brief started; feedback clears it.
    const implementationBasis = sha256(firstImplementPrompt);
    const recordedRounds =
      !operatorReview && ledger.rounds?.implementation?.basis === implementationBasis
        ? ledger.rounds.implementation
        : undefined;
    if (recordedRounds) {
      reviewFindings = structuredClone(recordedRounds.findings);
      for (const [path, phaseId] of Object.entries(recordedRounds.allowlist)) {
        addToAllowlist(path, phaseId);
      }
      suggestedCommit = recordedRounds.suggestedCommit ?? suggestedCommit;
      implementSummary = recordedRounds.summary ?? implementSummary;
    }
    if (operatorReview) {
      const selected = new Set(operatorReview.findingIds);
      reviewFindings = (ledger.findingHistory ?? []).filter((finding) => selected.has(finding.id)).map((finding) => ({
        severity: finding.severity, title: finding.title,
        ...(finding.location ? { location: finding.location } : {}),
        ...(finding.evidence ? { evidence: finding.evidence } : {}),
        by: finding.reviewers.join(', '),
      }));
    }

    /**
     * Rounds spent repairing the validation gate rather than answering a review.
     *
     * A failing gate short-circuits the council (`continue` below), so before
     * this the round was still charged to the review budget: a run whose first
     * validate failed got two review rounds instead of three, and spent one of
     * its three fixes on breakage the reviewers never saw. Observed on
     * 71edb02c, where round one went entirely to unrelated pre-existing test
     * failures and the councils then ran out of rounds mid-disagreement.
     *
     * Validation repair gets its own small budget on top. It is capped
     * separately so a permanently red gate still terminates.
     */
    let validationRepairRounds = recordedRounds?.validationRepairRounds ?? 0;
    const MAX_VALIDATION_REPAIR_ROUNDS = 2;
    const validationRepairPhases = new Set<string>(recordedRounds?.repairPhases);
    const recordedClosingRepair = implementationDecisions().find(
      (decision) => decision.kind === 'review.closing-fixes',
    );
    const recordedClosingRound = recordedClosingRepair?.detail?.match(/^round:(\d+)$/)?.[1];
    let closingRepairStartRound = recordedClosingRound
      ? Number(recordedClosingRound) + 1
      : undefined;
    if (operatorReview) closingRepairStartRound = undefined;

    // Closing fixes have no fresh council; recover its paid findings on every entry.
    if (closingRepairStartRound !== undefined && (recordedRounds?.round ?? 1) >= closingRepairStartRound) {
      const closingCouncil = ledger.councils.find(
        (council) => council.kind === 'implementation' && council.round === closingRepairStartRound! - 1,
      );
      const closingReview = reviewResultSchema.safeParse(closingCouncil);
      const closingFindings = closingReview.success
        ? closingCouncil!.findings as AttributedFinding[]
        : reviewFindings;
      survivingBlockers = closingFindings.filter(
        (finding) => finding.severity === 'blocker' || finding.severity === 'major',
      );
    }

    /**
     * The gate's verdict over a round's checks, measured against the baseline:
     * returns the blocking description (what a repair round must fix, with the
     * real extracted evidence), or null when every failure was already present
     * on the untouched worktree. Tolerated failures are announced, marked
     * `preexisting` on the persisted checks, and recorded as a decision — loud,
     * never silent (run c54c2ed4 died blaming a pre-existing upstream failure).
     */
    const describeGateVerdict = (
      checks: HarnessValidationCheck[],
      validateId: string,
    ): string | null => {
      const gate = computeGateRegressions(checks, ledger.baselineValidation);
      if (gate.tolerated.length > 0) {
        const reasons = gate.tolerated.map((entry) => entry.reason);
        ledger.decisions.push({
          at: new Date().toISOString(),
          kind: 'validation.preexisting-tolerated',
          by: 'driver',
          detail: reasons.join('; '),
        });
        persist();
        host.emit({
          type: 'note',
          stepId: validateId,
          message:
            `validation gate: tolerating ${gate.tolerated.length} pre-existing failure(s) already red at baseline —\n- ${reasons.join(
              '\n- ',
            )}\nThe repo owes these fixes; this run is not charged for them.`,
        });
      }
      if (gate.blocking.length === 0) return null;
      const first = gate.blocking[0]!;
      const newIds = first.newFailureIds?.length
        ? ` — new failures vs baseline: ${first.newFailureIds.join(', ')}`
        : '';
      return `\`${first.command}\` exited ${first.exitCode}${newIds}: ${first.evidence}`;
    };

    /**
     * What each earlier round demanded and what the fixer did about it.
     *
     * Reviewers are fresh contexts by design — that is what makes them
     * independent — but with no record of earlier rounds a reviewer can demand
     * a change and then block its reversal. Run 71edb02c hit exactly that: one
     * model raised a blocker on sanitizing error responses ("existing fields
     * retyped to internal keys"), the fixer restored the raw contract as
     * instructed, and the same model then raised two blockers for exposing raw
     * errors. The loop was unwinnable and exhausted into a contested handoff.
     *
     * Independence is preserved — reviewers still read the diff themselves and
     * are never told what verdict to reach. They are only denied the ability to
     * reverse an accepted fix without noticing they are doing it.
     */
    const roundHistory: Array<{ round: number; demanded: string[]; response: string }> =
      structuredClone(recordedRounds?.history ?? []);

    /** Prior rounds — and any open spec question — rendered for a reviewer. */
    const priorRoundsAppendix = (): string => {
      if (roundHistory.length === 0 && unresolvedSpecFindings.length === 0) return '';
      const path = join(artifactDir, 'findings-prior-rounds.json');
      writeJsonAtomic(path, { unresolvedSpecFindings, roundHistory });
      const findings = [
        ...unresolvedSpecFindings.map((title) => ({ severity: 'major' as const, title: `Known-open design question: ${title}` })),
        ...roundHistory.flatMap((entry) => entry.demanded.map((demand) => {
          const severity = /^\[(blocker|major|minor|nit)\]/.exec(demand)?.[1] as keyof typeof SEVERITY_RANK | undefined;
          return {
            severity: severity ?? 'major' as const,
            title: `Round ${entry.round} required: ${demand}`,
            evidence: `Round ${entry.round} response: ${entry.response || '(not recorded)'}`,
          };
        })),
      ];
      return [
        '',
        'Context: known-open design questions and earlier rounds of this same review:',
        boundedFindings(findings, path),
        'A defensible choice on a known-open design question is not itself a defect.',
        'Judge the current diff on its own merits; history is context, not a verdict.',
        "If reversing an earlier requirement, explicitly justify why it was wrong in the finding's evidence.",
      ].join('\n');
    };

    /** One extra fix/validate iteration is admitted after the final paid
     * review. Validation-only repair rounds can extend either side without
     * purchasing another review. */
    const implementationLoopLimit = (): number =>
      operatorReview?.round ?? Math.max(
        ledger.loops.maxFixRounds +
          validationRepairRounds +
          (closingRepairStartRound === undefined ? 0 : 1),
        (closingRepairStartRound ?? 0) + validationRepairRounds,
      );

    /** The loop's state entering `round` — everything a resume needs to continue there. */
    const saveImplementationRounds = (round: number): void => {
      if (operatorReview) return;
      ledger.rounds = {
        ...ledger.rounds,
        implementation: {
          round,
          basis: implementationBasis,
          validationRepairRounds,
          repairPhases: [...validationRepairPhases],
          findings: structuredClone(reviewFindings),
          history: structuredClone(roundHistory),
          allowlist: Object.fromEntries(allowlistOrigin),
          ...(suggestedCommit !== undefined ? { suggestedCommit } : {}),
          ...(implementSummary !== undefined ? { summary: implementSummary } : {}),
        },
      };
      persist();
    };

    for (let round = operatorReview?.round ?? recordedRounds?.round ?? 1; round <= implementationLoopLimit(); round += 1) {
      saveImplementationRounds(round);
      const isFirst = round === 1;
      const isClosingRepair =
        closingRepairStartRound !== undefined && round >= closingRepairStartRound;
      const implementId = operatorReview ? `operator-fix-${operatorReview.id}` : isFirst
        ? 'implement'
        : round === closingRepairStartRound
          ? 'fix-final'
          : `fix-${round}`;
      const reviewId = isFirst ? 'review' : `review-${round}`;

      const implementPrompt = isFirst
        ? firstImplementPrompt
        : [
            `A fresh code review of your project's uncommitted diff confirmed blocking findings. Fix them in the current worktree.`,
            ``,
            `Confirmed findings:`,
            findingsPrompt(`fix-${round}`, reviewFindings),
            ``,
            `When a finding cites a "full output:" log path, read that log for the complete failure detail before re-running long suites.`,
            `Hard boundaries: edit only this worktree; create NO commit; perform NO push or PR; do not weaken or delete tests.`,
            `When you are done write a JSON result file at the path in $CEZ_HARNESS_RESULT_FILE of the shape:`,
            `{"changedPaths": ["<every repo-relative file you changed>"], "summary": "<what you fixed>"}`,
          ].join('\n');

      const implement = operatorReview && operatorReview.action !== 'fix'
        ? { changedPaths: [] as string[], summary: 'User requested verification of the current changes.' }
        : await agentPhase(
        implementId,
        isFirst
          ? 'Implement'
          : round === closingRepairStartRound
            ? `Closing fixes (round ${round - 1} feedback)`
            : `Fixes (round ${round - 1} feedback)`,
        isFeature ? phaseSkills.implementSpec : phaseSkills.fix,
        implementPrompt,
        isFirst ? implementResultSchema : fixResultSchema,
        isFirst ? 'implement' : 'fix',
        roles?.implementer,
      );
      if ('cancelled' in (implement as object)) return null;
      if ('error' in (implement as object)) return (implement as { error: string }).error;
      const implementResult = implement as z.infer<typeof fixResultSchema>;
      for (const path of implementResult.changedPaths) addToAllowlist(path, implementId);
      suggestedCommit = implementResult.suggestedCommit ?? suggestedCommit;
      implementSummary = implementResult.summary ?? implementSummary;
      const answering = roundHistory[roundHistory.length - 1];
      if (answering && !answering.response) answering.response = implementResult.summary ?? '';

      const implementDrift = await gitDriftError(implementId);
      if (implementDrift) return implementDrift;
      const validateId = operatorReview ? `operator-validate-${operatorReview.id}` : isFirst
        ? 'validate'
        : round === closingRepairStartRound
          ? 'validate-final'
          : `validate-${round}`;
      let validationFailed: string | null = null;
      const validationArtifactSchema = z.object({
        version: z.literal(1),
        status: z.enum(['passed', 'failed']),
        checks: z.array(validationCheckSchema),
      });
      const validationPath = join(artifactDir, `validation-${validateId}.json`);
      let validationSubjectSha256: string;
      try {
        validationSubjectSha256 = await snapshotReviewSubject(host.cwd);
      } catch (error) {
        return `could not capture the validation subject: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      const validationInputSha256 = sha256(
        JSON.stringify({
          inputHashVersion: 2,
          commands: agentic.validationCommands,
          subjectSha256: validationSubjectSha256,
          trustedConfigSha256: ledger.trustedConfig?.sha256 ?? null,
        }),
      );
      const validationInvocationId = `validation:${validateId}`;
      const recoveredValidation = reusableInvocation(
        validationInvocationId,
        validationInputSha256,
        validationArtifactSchema,
      );
      if (recoveredValidation) {
        ledger.validation = recoveredValidation.checks;
                host.emit({ type: 'harness.validation.updated', checks: ledger.validation, actionRevision: harnessActionRevision(ledger) });
        validationFailed = describeGateVerdict(
          recoveredValidation.checks,
          validateId,
        );
        if (!phaseDone(validateId)) {
          startPhase(ledger, {
            id: validateId,
            name: isFirst ? 'Validate' : `Validate (round ${round})`,
            kind: 'op',
          });
          finishPhase(ledger, validateId, 'done');
          persist();
          host.setStepStatus(validateId, 'done');
          emitPhase(validateId);
        }
        host.emit({
          type: 'note',
          stepId: validateId,
          message: 'reused hash-bound validation evidence from the durable ledger',
        });
      } else if (phaseDone(validateId)) {
        invalidateFollowingPhases(validateId);
        const phase = ledger.phases.find((entry) => entry.id === validateId);
        if (phase) phase.status = 'pending';
      }
      const validateError = recoveredValidation
        ? null
        : await opPhase(
            validateId,
            isFirst ? 'Validate' : `Validate (round ${round})`,
            async () => {
              const invocation = beginInvocation({
                id: validationInvocationId,
                phaseId: validateId,
                role: 'validation',
                binding: { runner: 'bash' },
                inputSha256: validationInputSha256,
              });
              if (agentic.validationCommands.length === 0) {
                ledger.validation = [];
                writeJsonAtomic(validationPath, {
                  version: 1,
                  status: 'passed',
                  checks: [],
                });
                finishInvocation(invocation, 'completed', {
                  artifactPath: validationPath,
                });
                host.emit({
                  type: 'note',
                  stepId: validateId,
                  message:
                    'no validation commands configured in the immutable agentic snapshot — gate recorded as empty',
                });
                return { ok: true };
              }
              const controller = new AbortController();
              const offValidationInterrupt = host.onInterrupt(() => controller.abort());
              try {
                const checks = await validate(agentic.validationCommands, host.cwd, {
                  signal: controller.signal,
                  logDir: artifactDir,
                  logPrefix: `validation-${validateId}-`,
                  continueAfter: new Set(
                    (ledger.baselineValidation ?? [])
                      .filter((check) => check.status === 'failed')
                      .map((check) => check.command),
                  ),
                  onSpawn: (identity) => {
                    invocation.process = { ...identity };
                    persist();
                    emitInvocation(invocation);
                  },
                  onExit: () => {
                    invocation.process = undefined;
                    persist();
                    emitInvocation(invocation);
                  },
                });
                if (host.isCancelled()) {
                  finishInvocation(invocation, 'interrupted', {
                    error: 'run cancelled during validation',
                  });
                  return { ok: true };
                }
                validationFailed = describeGateVerdict(checks, validateId);
                ledger.validation = checks;
                host.emit({ type: 'harness.validation.updated', checks: ledger.validation, actionRevision: harnessActionRevision(ledger) });
                const artifact = {
                  version: 1 as const,
                  status: checks.every((check) => check.status === 'passed')
                    ? ('passed' as const)
                    : ('failed' as const),
                  checks,
                };
                writeJsonAtomic(validationPath, artifact);
                finishInvocation(invocation, 'completed', {
                  artifactPath: validationPath,
                });
                return { ok: true };
              } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                finishInvocation(invocation, 'failed', { error: detail });
                return { ok: false, error: `validation could not run: ${detail}` };
              } finally {
                offValidationInterrupt();
              }
            },
          );
      if (validateError === 'cancelled') return null;
      if (validateError) {
        if (operatorReview) { operatorReview.status = 'failed'; operatorReview.error = validateError; }
        setOutcome({ status: 'blocked', blockingReasons: [validateError] });
        return validateError;
      }
      const unavailable = ledger.validation.find(harnessCheckUnavailable);
      if (unavailable) {
        ledger.environment = { ...inspectHarnessEnvironment(host.cwd), status: 'needs-setup', detail: unavailable.evidence };
        if (requestedAction) { requestedAction.status = 'failed'; requestedAction.error = unavailable.evidence; }
        host.emit({ type: 'harness.environment.updated', environment: ledger.environment });
        setOutcome({ status: 'blocked', blockingReasons: ['Project checks could not run. Prepare the project and retry verification.'] });
        return 'Project checks could not run. Prepare the project and retry verification.';
      }
      if (validationFailed) {
        if (operatorReview) {
          operatorReview.status = 'failed';
          operatorReview.error = validationFailed;
          setOutcome({ status: 'blocked', blockingReasons: [validationFailed] });
          return validationFailed;
        }
        reviewFindings = [{ severity: 'blocker', title: 'validation gate failed', evidence: validationFailed }];
        ledger.loops.fixRounds = Math.max(0, round - validationRepairRounds - 1);
        persist();
        if (validationRepairRounds >= MAX_VALIDATION_REPAIR_ROUNDS) {
          const reason = `validation gate still failing after ${MAX_VALIDATION_REPAIR_ROUNDS + 1} repair rounds: ${validationFailed}`;
          setOutcome({ status: 'blocked', blockingReasons: [reason] });
          return reason;
        }
        validationRepairRounds += 1;
        validationRepairPhases.add(`fix-${round + 1}`);
        host.emit({
          type: 'note',
          stepId: validateId,
          message:
            `validation gate failed — spending a repair round on it. This does NOT consume a ` +
            `review round (${ledger.loops.fixRounds}/${ledger.loops.maxFixRounds} used).`,
        });
        continue;
      }
      if (isClosingRepair) {
        // Fixed but never re-reviewed: the spec keeps such blockers contested, never verified
        // (2026-07-23-harness-orchestration).
        survivingBlockers = survivingBlockers.map((finding) => ({
          ...finding,
          title: `${finding.title} — addressed by the closing fix, not re-reviewed`,
        }));
        ledger.findingHistory = ledger.findingHistory?.map((finding) =>
          finding.kind === 'implementation' && finding.status === 'open'
            ? { ...finding, status: 'fixed-unverified' } : finding);
        persist();
        host.emit({ type: 'harness.findings.updated', findings: ledger.findingHistory });
        host.emit({
          type: 'note',
          stepId: validateId,
          message:
            `validated the fixes for code-review cycle ${ledger.loops.maxFixRounds}/${ledger.loops.maxFixRounds}; ` +
            `the review budget is exhausted, so staging continues without buying a fourth review — ` +
            `its findings stay contested until the risk is accepted`,
        });
        break;
      }
      const validationEvidenceSha256 = hashFile(validationPath);
      if (!validationEvidenceSha256) {
        const reason = `validation evidence is missing before ${reviewId}`;
        setOutcome({ status: 'blocked', blockingReasons: [reason] });
        return reason;
      }
      const reviewPromptText = [
        `You are a FRESH review context with no implementation transcript — review this worktree's complete uncommitted diff against the base branch, following the already-injected ${phaseSkills.codeReview} instructions in full.`,
        ``,
        `The task under review: ${input.task}`,
        `Validation gate: ${
          ledger.validation.length === 0
            ? 'no commands configured'
            : ledger.validation.map((c) => `${c.command} → ${c.status}${c.preexisting ? ' (failed at baseline too — tolerated as pre-existing)' : ''}`).join('; ')
        }`,
        `Validation evidence sha256: ${validationEvidenceSha256}`,
        ``,
        `Confirm findings against the code itself. When you are done write a JSON result file at the path in $CEZ_HARNESS_RESULT_FILE of the shape:`,
        `{"verdict": "approve" | "request_changes", "findings": [{"severity": "blocker|major|minor|nit", "title": "…", "location": "path:line", "evidence": "…"}]}`,
        `Verdict follows ${phaseSkills.codeReview} mechanically: any blocker or major finding means "request_changes"; only minor/nit findings (or none) means "approve".`,
      ].join('\n') + priorRoundsAppendix();

      let mergedFindings: AttributedFinding[];
      let mergedVerdict: 'approve' | 'request_changes';

      if (roles && roles.reviewers.length > 0) {
        let implementationSubjectSha256: string;
        try {
          implementationSubjectSha256 = await snapshotReviewSubject(host.cwd);
        } catch (error) {
          return `could not capture the implementation review subject: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
        const councilName = `Council review (round ${round})`;
        const implementationRound = await runCouncilRound({
          kind: 'implementation',
          round,
          councilId: reviewId,
          councilName,
          skill: phaseSkills.codeReview,
          reviewers: roles.reviewers,
          reviewerName: (label) => `Review — ${label}`,
          promptText: reviewPromptText,
          subjectSha256: implementationSubjectSha256,
          currentSubjectSha256: () => snapshotReviewSubject(host.cwd),
          hashExtra: { validationEvidenceSha256 },
          advisorCriteria: `${[
            `Role-based cezar council criteria (run ${host.runId}).`,
            ``,
            `The task under review: ${input.task}`,
            `Validation gate: ${
              ledger.validation.length === 0
                ? 'no commands configured'
                : ledger.validation.map((c) => `${c.command} → ${c.status}${c.preexisting ? ' (failed at baseline too — tolerated as pre-existing)' : ''}`).join('; ')
            }`,
            `Validation evidence sha256: ${validationEvidenceSha256}`,
            ``,
            `Review the worktree's uncommitted diff (the subject) against these facts.`,
          ].join('\n')}${priorRoundsAppendix()}`,
        });
        if ('stop' in implementationRound) return implementationRound.stop;
        mergedFindings = implementationRound.findings;
        mergedVerdict = implementationRound.verdict;
      } else {
        const review = await agentPhase(
          reviewId,
          isFirst ? 'Review (round 1)' : `Review (round ${round})`,
          phaseSkills.codeReview,
          reviewPromptText,
          reviewResultSchema,
          'review',
        );
        if ('cancelled' in (review as object)) return null;
        if ('error' in (review as object)) return (review as { error: string }).error;
        const reviewResult = review as ReviewResult;
        mergedFindings = reviewResult.findings.map((f) => ({ ...f, by: 'claude' }));
        const soloCoerced = coerceReviewVerdict(reviewResult);
        mergedVerdict = soloCoerced.verdict;
        if (soloCoerced.coercedFrom) {
          host.emit({
            type: 'note',
            stepId: reviewId,
            message:
              `the review reported "${soloCoerced.coercedFrom}" alongside its own blocker/major ` +
              `findings — verdict coerced to "${soloCoerced.verdict}"`,
          });
        }
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
        upsertCouncil('implementation', round, {
          round,
          kind: 'implementation',
          verdict: mergedVerdict,
          findings: mergedFindings,
        });
        persist();
      }

      const blocking = mergedFindings.filter((f) => f.severity === 'blocker' || f.severity === 'major');
      survivingBlockers = blocking;
      if (mergedVerdict === 'approve' || blocking.length === 0) break;
      if (operatorReview) break;

      ledger.loops.fixRounds = round;
      persist();
      if (round >= ledger.loops.maxFixRounds + validationRepairRounds) {
        closingRepairStartRound = round + 1;
        if (!implementationDecisions().some((decision) => decision.kind === 'review.closing-fixes')) {
          ledger.decisions.push({
            at: new Date().toISOString(),
            kind: 'review.closing-fixes',
            by: 'driver',
            detail: `round:${round}`,
          });
        }
        persist();
        host.emit({
          type: 'note',
          stepId: reviewId,
          message:
            `code-review cycle ${ledger.loops.maxFixRounds}/${ledger.loops.maxFixRounds} found blocking issues — ` +
            `applying its confirmed findings in one closing fix pass, then validating without buying a fourth review`,
        });
      }
      roundHistory.push({
        round,
        demanded: blocking.map(
          (f) => `[${f.severity}] ${f.title}${f.location ? ` (${f.location})` : ''}${f.by ? ` — raised by ${f.by}` : ''}`,
        ),
        response: '',
      });
      reviewFindings = blocking;
    }

    if (survivingBlockers.length > 0 && ledger.outcome.status === 'pending') {
      setOutcome({
        status: 'contested',
        blockingReasons: survivingBlockers.map(
          (finding) => `[${finding.severity}] ${finding.title} (raised by ${finding.by})`,
        ),
      });
      host.emit({
        type: 'note',
        message:
          `staging with ${survivingBlockers.length} unresolved blocker/major finding(s) — ` +
          `publishing stays gated until the risk is accepted`,
      });
    }

    const unappliedMessagesBlock = (): string | null => {
      mergeOperatorMutations();
      const unconsumedMessages = ledger.pendingMessages.filter((message) => !message.consumedAt);
      if (unconsumedMessages.length === 0) return null;
      const reason =
        UNAPPLIED_MESSAGES_REASON +
        unconsumedMessages.map((message) => message.id).join(', ') +
        ' — Continue applies them as feedback';
      setOutcome({ status: 'blocked', blockingReasons: [reason] });
      persist();
      return reason;
    };
    const unappliedBeforeStage = unappliedMessagesBlock();
    if (unappliedBeforeStage) return unappliedBeforeStage;

    const invalidateStage = (): void => {
      const phase = ledger.phases.find((entry) => entry.id === 'stage');
      if (phase) {
        phase.status = 'pending';
        phase.startedAt = undefined;
        phase.endedAt = undefined;
        phase.error = undefined;
      }
      ledger.stage = { status: 'pending' };
      persist();
      emitPhase('stage');
      host.emit({ type: 'harness.stage.updated', stage: ledger.stage, actionRevision: harnessActionRevision(ledger) });
    };
    const resetStageIndex = async (): Promise<string | undefined> => {
      for (let attempt = 0; ; attempt += 1) {
        const error = resetIndexToHead(host.cwd);
        if (!error) return;
        const locked = /index\.lock|another git process/i.test(error);
        if (locked && attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
          continue;
        }
        const lockPath = join(pinnedGitEnv(host.cwd)?.GIT_DIR ?? '', 'index.lock');
        const reason = locked
          ? `another git process holds the index lock — Continue to retry; if no git process is running, delete ${lockPath}, then Continue`
          : `could not reset the harness index — Continue to retry: ${error}`;
        setOutcome({ status: 'blocked', blockingReasons: [reason] });
        return reason;
      }
    };
    const resetBeforeStage = !(phaseDone('stage') && ledger.stage.status === 'staged');
    if (resetBeforeStage) {
      invalidateStage();
      const error = await resetStageIndex();
      if (error) return error;
    }
    const allowlistPath = join(artifactDir, 'allowlist.txt');
    const discoverStagePaths = (): string | null => {
      const discoveredPaths = discoverChangedPaths(host.cwd, [...allowlist]);
      if (discoveredPaths === null) {
        const reason =
          'could not derive the complete changed-path set from git; refusing to stage a model-declared subset';
        return reason;
      }
      const omitted = discoveredPaths.filter((path) => !allowlist.has(path));
      if (omitted.length > 0) {
        host.emit({
          type: 'note',
          stepId: 'stage',
          message:
            `phase result allowlists omitted ${omitted.length} changed path(s); Cezar derived the ` +
            `complete handoff from git and will stage them too:\n- ${omitted.join('\n- ')}`,
        });
      }
      allowlist.clear();
      for (const path of discoveredPaths) allowlist.add(path);
      const unsafeStagePath = [...allowlist].find(
        (path) => /[\x00-\x1f\x7f]/.test(path) || path.startsWith('/') || path.split(/[\\/]/).includes('..'),
      );
      if (unsafeStagePath) {
        return `cannot stage unsafe changed path: ${JSON.stringify(unsafeStagePath)}`;
      }
      writeFileSync(allowlistPath, `${[...allowlist].sort().join('\n')}\n`, 'utf8');
      return null;
    };
    const discoveryError = discoverStagePaths();
    if (discoveryError) {
      setOutcome({ status: 'blocked', blockingReasons: [discoveryError] });
      return discoveryError;
    }
    const stageResultPath = join(artifactDir, 'stage-result.json');
    const stageInvocationId = 'runtime:stage';
    let stageSubjectSha256: string;
    try {
      stageSubjectSha256 = await snapshotStageSubject(host.cwd);
    } catch (error) {
      const reason = `could not capture the complete stage subject: ${
        error instanceof Error ? error.message : String(error)
      }`;
      setOutcome({ status: 'blocked', blockingReasons: [reason] });
      return reason;
    }
    const stageInputHash = () => sha256(
      JSON.stringify({
        inputHashVersion: 2,
        operation: 'stage',
        startStateSha256: hashFile(startStatePath),
        allowlistSha256: hashFile(allowlistPath),
        subjectSha256: stageSubjectSha256,
      }),
    );
    let stageInputSha256 = stageInputHash();
    const recoveredStage = resetBeforeStage ? null : reusableInvocation(
      stageInvocationId,
      stageInputSha256,
      harnessStageResultSchema,
    );
    if (recoveredStage) {
      if (ledger.outcome.status === 'pending') setOutcome({ status: 'ready', blockingReasons: [] });
      host.emit({
        type: 'note',
        stepId: 'stage',
        message: 'reused the hash-bound staged handoff from the durable ledger',
      });
      return null;
    }
    if (!resetBeforeStage) {
      // Keep validation and contested outcomes when only staging expires.
      invalidateStage();
      const error = await resetStageIndex();
      if (error) return error;
      const discoveryError = discoverStagePaths();
      if (discoveryError) {
        setOutcome({ status: 'blocked', blockingReasons: [discoveryError] });
        return discoveryError;
      }
      stageInputSha256 = stageInputHash();
    }
    // Scope report: which staged files the task actually asked for, and which
    // came in as collateral while making a red gate green again. 71edb02c staged
    // 48 files for a UI task; 14 of them were unrelated pre-existing test and
    // tooling breakage repaired in-band, and nothing in the handoff said so.
    const collateral = [...allowlistOrigin.entries()]
      .filter(([, phaseId]) => validationRepairPhases.has(phaseId))
      .map(([path]) => path)
      .sort();
    if (collateral.length > 0) {
      host.emit({
        type: 'note',
        stepId: 'stage',
        message:
          `${collateral.length} of ${allowlist.size} staged paths were touched only to repair the ` +
          `validation gate, not to implement the task — review them separately, they may belong ` +
          `in their own change:\n- ${collateral.join('\n- ')}`,
      });
    }

    const stageError = await opPhase('stage', 'Stage', async () => {
      const invocation = beginInvocation({
        id: stageInvocationId,
        phaseId: 'stage',
        role: 'runtime',
        binding: { runner: 'harness', model: 'stage' },
        inputSha256: stageInputSha256,
      });
      const result = await runtime.run(
        'stage',
        [
          '--worktree',
          host.cwd,
          '--start-state',
          startStatePath,
          '--paths-file',
          allowlistPath,
          '--output',
          stageResultPath,
        ],
        {
          onSpawn: (identity) => {
            invocation.process = { ...identity };
            persist();
            emitInvocation(invocation);
          },
        },
      );
      if (!result.ok) {
        const error = `stage refused the handoff: ${
          (result.error ?? result.stderr ?? result.stdout ?? '').trim() ||
          'non-zero exit'
        }`;
        finishInvocation(invocation, 'failed', { error });
        return { ok: false, error };
      }
      if (!existsSync(stageResultPath)) {
        const error = 'stage reported success but wrote no stage-result artifact';
        finishInvocation(invocation, 'failed', { error });
        return { ok: false, error };
      }
      finishInvocation(invocation, 'completed', {
        artifactPath: stageResultPath,
      });
      return { ok: true };
    });
    if (stageError === 'cancelled') return null;
    if (stageError) {
      ledger.stage = { ...ledger.stage, status: 'failed', error: stageError };
      setOutcome({ status: 'blocked', blockingReasons: [stageError] });
      host.emit({ type: 'harness.stage.updated', stage: ledger.stage, actionRevision: harnessActionRevision(ledger) });
      return stageError;
    }

    // Advisory findings the runtime demoted from refusals (whitespace nits,
    // leftovers outside the handoff — run aad28178). They ride the run log AND
    // the prepared PR body, so the human gate sees them wherever it reads.
    let stageWarnings: string[] = [];
    let stagedPaths: string[] = [];
    const rejectStageResult = (reason: string): void => {
      const invocation = ledger.invocations.find((entry) => entry.id === stageInvocationId);
      if (invocation) finishInvocation(invocation, 'failed', { error: reason });
      finishPhase(ledger, 'stage', 'failed', reason);
      host.setStepStatus('stage', 'failed', reason);
      emitPhase('stage');
    };
    try {
      const parsedStage = harnessStageResultSchema.safeParse(
        JSON.parse(readHarnessArtifactText(stageResultPath)),
      );
      if (!parsedStage.success) {
        const reason = `stage result is invalid: ${parsedStage.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`;
        rejectStageResult(reason);
        ledger.stage = { ...ledger.stage, status: 'failed', error: reason };
        setOutcome({ status: 'blocked', blockingReasons: [reason] });
        return reason;
      }
      stageWarnings = parsedStage.data.warnings ?? [];
      stagedPaths = parsedStage.data.stagedPaths;
      if (!samePathSet(stagedPaths, [...allowlist])) {
        const reason =
          'stage result is incomplete: staged paths do not exactly match the complete git-derived handoff';
        rejectStageResult(reason);
        ledger.stage = { ...ledger.stage, status: 'failed', error: reason };
        setOutcome({ status: 'blocked', blockingReasons: [reason] });
        return reason;
      }
    } catch (error) {
      const reason = `could not read stage result: ${
        error instanceof Error ? error.message : String(error)
      }`;
      rejectStageResult(reason);
      ledger.stage = { ...ledger.stage, status: 'failed', error: reason };
      setOutcome({ status: 'blocked', blockingReasons: [reason] });
      return reason;
    }
    for (const warning of stageWarnings) {
      host.emit({ type: 'note', stepId: 'stage', message: `staged with a warning — ${warning}` });
    }

    ledger.stage = {
      status: 'staged',
      startStatePath,
      allowlistPath,
      stagedPaths,
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
        ...(ledger.outcome.status === 'contested'
          ? [
              ``,
              `## Unresolved review findings`,
              ...ledger.outcome.blockingReasons.map((reason) => `- ${reason}`),
              ...(ledger.outcome.acceptedAt
                ? [
                    ``,
                    `Risk accepted by the user at ${ledger.outcome.acceptedAt}: ${ledger.outcome.acceptanceReason ?? '(no reason recorded)'}`,
                  ]
                : []),
            ]
          : []),
        ...(unresolvedSpecFindings.length > 0
          ? [
              ``,
              `## Spec council — open questions (the build proceeded)`,
              ...unresolvedSpecFindings.map((finding) => `- ${finding}`),
            ]
          : []),
        ...(stageWarnings.length > 0
          ? [``, `## Handoff warnings`, ...stageWarnings.map((warning) => `- ${warning}`)]
          : []),
        ``,
        `Staged by the cezar harness driver (stage-only: no commit, push, or PR was created).`,
      ].join('\n'),
    };
    // A message the server queued while the stage op ran was acknowledged; it blocks the handoff
    // instead of being dropped.
    const unappliedAfterStage = unappliedMessagesBlock();
    if (unappliedAfterStage) {
      host.emit({ type: 'harness.stage.updated', stage: ledger.stage, actionRevision: harnessActionRevision(ledger) });
      return unappliedAfterStage;
    }
    if (ledger.outcome.status === 'pending') {
      setOutcome({ status: 'ready', blockingReasons: [] });
    }
    if (requestedAction) {
      requestedAction.status = 'completed';
      requestedAction.subjectSha256 = await snapshotReviewSubject(host.cwd);
    }
    persist();
    if (requestedAction) host.emit({ type: 'harness.review-action.updated', action: requestedAction, actionRevision: harnessActionRevision(ledger) });
    host.emit({ type: 'harness.stage.updated', stage: ledger.stage, actionRevision: harnessActionRevision(ledger) });
    host.emit({
      type: 'note',
      message: 'staged handoff ready — review the diff, then commit/push/PR from the cockpit. HEAD, refs, and reflogs verified unchanged.',
    });
    return null;
  } finally {
    if (!issueClaimStaysHeld(ledger)) releaseHeldIssueClaim();
    offInterrupt();
  }
}
