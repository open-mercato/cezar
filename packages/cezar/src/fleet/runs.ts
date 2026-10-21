import { execFile } from 'node:child_process';
import type { FleetJob } from '@open-mercato/cezar-contract';
import { parseRemote } from '../git-remotes.ts';
import { readHandoff } from '../handoff.ts';
import { expandTilde } from '../paths.ts';
import { checkoutRepo, parseRepoRef } from '../server/checkout.ts';
import { getRepoInfo } from '../server/git.ts';
import { createDraftPr } from '../server/pr.ts';
import type { ProjectContext } from '../server/project-context.ts';
import { loadWorkflows } from '../workflows/load.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { listProjects, registerProject } from '../workspace/projects.ts';
import type { FleetRunHost } from './worker.ts';

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
  context: (projectId: string) => Promise<ProjectContext>;
}

const FETCH_TIMEOUT_MS = 120_000;

function fetchOrigin(root: string): Promise<void> {
  if (process.env.CEZ_DRY_RUN === '1') return Promise.resolve();
  return new Promise((resolve) => {
    execFile('git', ['fetch', 'origin'], { cwd: root, timeout: FETCH_TIMEOUT_MS }, () => resolve());
  });
}

function refExists(root: string, ref: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root }, (err) => resolve(!err));
  });
}

/** The fork point for a requested base: the freshest `origin/<base>`, else the local branch. */
async function forkPoint(root: string, base: string): Promise<string> {
  for (const ref of [`origin/${base}`, base]) if (await refExists(root, ref)) return ref;
  throw new Error(`base branch "${base}" not found in ${root}`);
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
    const cloned = await checkoutRepo({
      url: job.repoUrl,
      projectsDir: expandTilde((await loadWorkspaceConfig()).projectsDir),
      onProgress: () => {},
    });
    if (!cloned.ok) throw new Error(`could not clone ${job.repoUrl}: ${cloned.error}`);
    const entry = await registerProject(cloned.target, 'checkout');
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
        await fetchOrigin(project.root);
        fork = await forkPoint(project.root, job.baseBranch);
      }
      const run = project.manager.startRun(workflow, {
        task: job.task,
        ...(job.model ? { model: job.model } : {}),
        ...(job.runner ? { runner: job.runner } : {}),
        autonomous: true,
      });
      // The recorded fork point wins in `execute` (and is the PR base); written in the same tick,
      // before the run can read it.
      if (fork) project.store.updateRun(run.id, { baseBranch: fork });
      owners.set(run.id, project);
      return run.id;
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
