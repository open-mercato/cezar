import type { FleetJob } from '@open-mercato/cezar-contract';
import { execFile } from 'node:child_process';
import { isSafeGitRef } from '../git-refs.ts';
import { isGithubHost } from '../github-hosts.ts';
import { autosaveCommit, resolveBaseRef, taskRemotes } from '../git-worktree.ts';
import { parseRemote } from '../git-remotes.ts';
import { readHandoff } from '../handoff.ts';
import { expandTilde } from '../paths.ts';
import { checkoutRepo, parseRepoRef } from '../server/checkout.ts';
import { classifyRepo, cloneHttpsRepo, branchWebUrl, type GitCloneRunner } from './clone.ts';
import { getRepoInfo } from '../server/git.ts';
import { createDraftPr } from '../server/pr.ts';
import type { ProjectContext } from '../server/project-context.ts';
import { loadWorkflows } from '../workflows/load.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { listProjects, registerProject } from '../workspace/projects.ts';
import type { FleetRunHost, RecoveredRun } from './worker.ts';

/**
 * The real `FleetRunHost`: maps a job onto this node's projects and RunManagers. A job names its
 * repo by URL; the node finds the registered project whose remote matches, or clones it into the
 * workspace projects dir and registers it, then starts an autonomous run (it must never park on a
 * user who is not there) and, when asked, pushes the branch + opens a draft PR.
 */

/** `host/owner/repo`, lowercased: the one spelling two remotes of the same repo share. */
export function repoKey(url: string): string | null {
  const parsed = parseRemote(url);
  if (parsed) return `${parsed.host}/${parsed.owner}/${parsed.repo}`.toLowerCase();
  const github = parseRepoRef(url); // `owner/repo` shorthand
  return github ? `github.com/${github.owner}/${github.repo}`.toLowerCase() : null;
}

export type BootProject = Pick<ProjectContext, 'root' | 'dataDir' | 'store' | 'manager'>;

export interface FleetRunHostDeps {
  /** The project this process booted in (served from `deps.manager`, not a second context). */
  boot: BootProject;
  /** Every other project: built lazily by the server's shared context map. */
  context: (projectId: string) => Promise<BootProject>;
  /** Called after a clone registered a NEW project (the server announces it to open cockpits). */
  onProjectAdded?: (project: { id: string; root: string }) => void;
  /** Test seam for the https clone. */
  cloneRunner?: GitCloneRunner;
}

/** Autosave and push the run's branch to the push remote (non-GitHub hosts have no `gh pr create`). */
async function pushBranch(run: { worktreePath?: string; branch?: string }, remote: string): Promise<{ ok: true; branchUrl?: string } | { ok: false; error: string }> {
  const { worktreePath, branch } = run;
  if (!worktreePath || !branch) return { ok: false, error: 'this task has no worktree/branch to publish' };
  const saved = await autosaveCommit(worktreePath, 'pre-PR');
  if (saved === 'refused') return { ok: false, error: 'worktree has unresolved merge conflicts' };
  if (saved === 'failed') return { ok: false, error: 'could not commit the final changes' };
  const branchUrl = branchWebUrl(remote, branch);
  if (process.env.CEZ_DRY_RUN === '1') return { ok: true, ...(branchUrl ? { branchUrl } : {}) };
  const remotes = await taskRemotes(worktreePath);
  if (!remotes.push || !isSafeGitRef(branch)) return { ok: false, error: 'no git remote to push to' };
  const pushed = await new Promise<string | null>((done) => {
    execFile('git', ['push', '-u', remotes.push as string, '--', branch], { cwd: worktreePath, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8' },
      (err, _out, stderr) => done(err ? (stderr || err.message).trim().split('\n').slice(-2).join(' ') : null));
  });
  return pushed === null ? { ok: true, ...(branchUrl ? { branchUrl } : {}) } : { ok: false, error: `git push failed — ${pushed}` };
}

export function createFleetRunHost(deps: FleetRunHostDeps): FleetRunHost {
  // runId -> the project that owns it, so get/cancel/publish need no lookup.
  const owners = new Map<string, BootProject>();
  // One clone per repo at a time: two jobs for the same new repo must not race `mkdir`.
  const resolving = new Map<string, Promise<BootProject>>();

  async function findProject(key: string): Promise<BootProject | undefined> {
    const bootRemote = (await getRepoInfo(deps.boot.root))?.remote;
    if (bootRemote && repoKey(bootRemote) === key) return deps.boot;
    for (const project of await listProjects()) {
      if (project.status !== 'ok') continue;
      const remote = (await getRepoInfo(project.root))?.remote;
      if (remote && repoKey(remote) === key) return deps.context(project.id);
    }
    return undefined;
  }

  async function resolveProject(job: FleetJob): Promise<BootProject> {
    const key = repoKey(job.repoUrl);
    if (!key) throw new Error(`cannot tell which repository "${job.repoUrl}" is`);
    const known = await findProject(key);
    if (known) return known;
    const kind = classifyRepo(job.repoUrl);
    if (kind.kind === 'invalid') throw new Error('repo must be owner/repo, a GitHub URL, or a plain https:// git URL without credentials');
    const projectsDir = expandTilde((await loadWorkspaceConfig()).projectsDir);
    let target: string;
    if (kind.kind === 'github') {
      const cloned = await checkoutRepo({ url: job.repoUrl, projectsDir, onProgress: () => {} });
      if (!cloned.ok) throw new Error(`could not clone ${job.repoUrl}: ${cloned.error}`);
      target = cloned.target;
    } else {
      const cloned = await cloneHttpsRepo(kind.repo, projectsDir, deps.cloneRunner);
      if (!cloned.ok) throw new Error(`could not clone ${kind.repo.url}: ${cloned.error}`);
      target = cloned.target;
    }
    const before = new Set((await listProjects()).map((p) => p.root));
    const entry = await registerProject(target, 'checkout');
    // Open cockpits learn about the new project the way they do for one added from the UI.
    if (!before.has(entry.root)) deps.onProjectAdded?.(entry);
    return deps.context(entry.id);
  }

  return {
    async start(job) {
      const key = repoKey(job.repoUrl) ?? job.repoUrl;
      let pending = resolving.get(key);
      if (!pending) {
        pending = resolveProject(job).finally(() => resolving.delete(key));
        resolving.set(key, pending);
      }
      const project = await pending;
      const name = job.workflowId ?? 'quick-task';
      const workflow = (await loadWorkflows(project.root)).workflows.find((w) => w.name === name);
      if (!workflow) throw new Error(`unknown workflow "${name}" in ${project.root}`);
      let fork: string | undefined;
      if (job.baseBranch) {
        // Validates the ref (option-like values are refused) and picks the freshest of local/remote.
        const resolved = await resolveBaseRef(project.root, job.baseBranch);
        if (!resolved) throw new Error(`base branch "${job.baseBranch}" not found in ${project.root}`);
        fork = resolved;
      }
      const run = project.manager.startRun(workflow, {
        task: job.task,
        ...(job.model ? { model: job.model } : {}),
        ...(job.runner ? { runner: job.runner } : {}),
        autonomous: true,
      });
      // The recorded fork point wins in `execute` (and is the PR base); written in the same tick,
      // before the run can read it.
      project.store.updateRun(run.id, { fleetJobId: job.id, fleetOpenPr: job.openPr, ...(fork ? { baseBranch: fork } : {}) });
      owners.set(run.id, project);
      return run.id;
    },

    /** Startup: live runs left by a previous process of this node. The worker reports them; the
     *  hub either still assigns the job here (adopted) or answers `drop` (cancelled). */
    async recover() {
      const projects: BootProject[] = [deps.boot];
      for (const entry of await listProjects()) {
        if (entry.status !== 'ok' || entry.root === deps.boot.root) continue;
        const project = await deps.context(entry.id).catch(() => undefined);
        if (project) projects.push(project);
      }
      const found: RecoveredRun[] = [];
      for (const project of new Set(projects)) {
        for (const run of project.store.listRuns()) {
          if (!run.fleetJobId || owners.has(run.id)) continue;
          if (!['queued', 'waiting', 'running'].includes(run.status)) continue;
          owners.set(run.id, project);
          found.push({ jobId: run.fleetJobId, runId: run.id, openPr: run.fleetOpenPr !== false });
        }
      }
      return found;
    },

    get(runId) {
      const run = owners.get(runId)?.store.getRun(runId);
      if (!run) return undefined;
      // An autonomous run only parks at `waiting` once its nudge cap is spent and nobody is there
      // to answer: publish what exists. A usage-limit stop schedules its own resume: still running.
      const status = run.status === 'waiting' ? 'review' : run.status === 'failed' && run.autoResumeAt ? 'running' : run.status;
      return { status, branch: run.branch, error: run.error };
    },

    cancel(runId) {
      owners.get(runId)?.manager.cancel(runId);
    },

    async publish(runId) {
      const project = owners.get(runId);
      const run = project?.store.getRun(runId);
      if (!project || !run) return { ok: false, error: 'run not found' };
      // A parked session still owns the worktree; stop it so the final autosave sees a quiet tree.
      if (project.manager.isActive(runId)) await project.manager.cancelAndWait(runId);
      const remote = (await getRepoInfo(project.root))?.remote;
      const host = remote ? parseRemote(remote)?.host : undefined;
      if (remote && host && !isGithubHost(host)) {
        // Only GitHub has `gh pr create`: elsewhere the branch is pushed and its name (and page) reported.
        const pushed = await project.manager.lifecycle.withWorktreeMutation(runId, () => pushBranch(run, remote));
        if (!pushed.ok) return pushed;
        project.store.updateRun(runId, { status: 'done', finishedAt: run.finishedAt ?? new Date().toISOString() });
        project.store.appendEvent(runId, { type: 'note', message: `branch pushed by fleet: ${run.branch}${pushed.branchUrl ? ` (${pushed.branchUrl})` : ''}` });
        return pushed;
      }
      // Same sequence as `POST /runs/:id/pr`: serialized with other worktree mutations.
      const outcome = await project.manager.lifecycle.withWorktreeMutation(runId, () =>
        createDraftPr({ repoRoot: project.root, run, handoffText: readHandoff(project.dataDir, runId), draft: true }),
      );
      if (!outcome.ok) return outcome;
      project.store.updateRun(runId, { pullRequestUrl: outcome.url, status: 'done', finishedAt: run.finishedAt ?? new Date().toISOString() });
      project.store.appendEvent(runId, { type: 'note', message: `draft PR created by fleet: ${outcome.url}` });
      return { ok: true, url: outcome.url };
    },
  };
}
