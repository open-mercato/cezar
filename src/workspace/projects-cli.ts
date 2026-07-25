import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { workspaceConfigPath } from '../paths.js';
import { loadWorkspaceConfig } from './config.js';
import { listProjects, registerProject, removeProject, shouldRegisterProject } from './projects.js';

/**
 * `cezar projects` (spec 2026-07-20-multi-project-workspace, step 5.2) — the
 * terminal twin of Settings → Projects, for the operator who is on a server (or
 * an ssh session) and has no cockpit in front of them.
 *
 * It talks to `~/.cezar/config.json` through `./projects.js` directly, NOT over
 * HTTP: the whole point is that it works with no server running, on a box where
 * the cockpit is behind an nginx login. `CEZ_HOME` therefore selects which
 * workspace it operates on, exactly as it does for `serve`.
 */

export interface ProjectsCommandIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

const defaultIo: ProjectsCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

const USAGE = `usage:
  cezar projects [list]        list the registered projects
  cezar projects add [<dir>]   register a folder (default: --repo, else cwd)
  cezar projects remove <id>   drop a registry entry (the repo is untouched)

  add/remove are unavailable when CEZ_SINGLE_PROJECT=1`;

const SINGLE_PROJECT_ADD_ERROR = 'single-project mode is enabled; adding projects is disabled';
const SINGLE_PROJECT_REMOVE_ERROR = 'single-project mode is enabled; removing projects is disabled';

/**
 * Run one `projects` subcommand. Returns the process exit code (0 ok, 1 for a
 * usage error, an unknown id, or a folder the registration guards refuse) so
 * `src/index.ts` can assign it to `process.exitCode` like every other command.
 */
export async function runProjectsCommand(
  args: string[],
  opts: { defaultRoot: string; bootProjectId?: string; env?: NodeJS.ProcessEnv; io?: ProjectsCommandIo },
): Promise<number> {
  const io = opts.io ?? defaultIo;
  const singleProject = (opts.env ?? process.env).CEZ_SINGLE_PROJECT === '1';
  const [sub = 'list', ...rest] = args;
  switch (sub) {
    case 'list':
      return listCommand(io, singleProject, opts.bootProjectId);
    case 'add':
      if (singleProject) {
        io.error(SINGLE_PROJECT_ADD_ERROR);
        return 1;
      }
      return addCommand(rest[0] ? resolve(rest[0]) : opts.defaultRoot, io);
    case 'remove':
    case 'rm':
      if (singleProject) {
        io.error(SINGLE_PROJECT_REMOVE_ERROR);
        return 1;
      }
      return removeCommand(rest[0], io);
    default:
      io.error(`unknown projects subcommand: ${sub}\n`);
      io.error(USAGE);
      return 1;
  }
}

/** `ok` shows the branch when git could name one; the other states say why. */
function statusLabel(entry: { status: string; branch?: string }): string {
  if (entry.status === 'missing') return 'missing';
  if (entry.status === 'not-git') return 'not a git repo';
  return entry.branch ?? 'ok';
}

/** Same ✓/✗ vocabulary the `serve` banner uses for its environment checks. */
function statusMark(status: string): string {
  return status === 'missing' ? '✗' : status === 'not-git' ? '·' : '✓';
}

async function listCommand(
  io: ProjectsCommandIo,
  singleProject: boolean,
  bootProjectId?: string,
): Promise<number> {
  const projects = bootProjectId
    ? await listProjects({ projectId: bootProjectId })
    : singleProject
      ? []
      : await listProjects();
  if (projects.length === 0) {
    io.log('\n  no projects registered yet');
    io.log('  start the cockpit in a repo (npx cezar) or add one: cezar projects add <dir>\n');
    return 0;
  }
  const idWidth = Math.max(...projects.map((p) => p.id.length));
  const labelWidth = Math.max(...projects.map((p) => statusLabel(p).length));
  io.log('');
  for (const project of projects) {
    const label = statusLabel(project).padEnd(labelWidth);
    io.log(`  ${statusMark(project.status)} ${project.id.padEnd(idWidth)}  ${label}  ${project.root}`);
  }
  io.log(`\n  ${projects.length} project(s) — registry: ${workspaceConfigPath()}\n`);
  return 0;
}

async function addCommand(root: string, io: ProjectsCommandIo): Promise<number> {
  try {
    if (!(await stat(root)).isDirectory()) throw new Error('not a directory');
  } catch {
    io.error(`not a directory: ${root}`);
    return 1;
  }
  // Same guards `serve`/`run` apply at boot: a task worktree or `$HOME` itself
  // is served happily but never registered, and asking for it explicitly does
  // not buy an exemption.
  if (!(await shouldRegisterProject(root))) {
    io.error(`refusing to register ${root} — cezar task worktrees and your home directory are not projects`);
    return 1;
  }
  const known = new Set((await loadWorkspaceConfig()).projects.map((p) => p.id));
  const entry = await registerProject(root);
  // Registration dedupes by realpath, so a second `add` of the same folder
  // (or a symlink to it) reports the entry that already exists.
  io.log(known.has(entry.id) ? `  = ${entry.id} (already registered)  ${entry.root}` : `  + ${entry.id}  ${entry.root}`);
  return 0;
}

async function removeCommand(id: string | undefined, io: ProjectsCommandIo): Promise<number> {
  if (!id) {
    io.error(USAGE);
    return 1;
  }
  // Unlike `DELETE /api/projects/:projectId`, there is no boot-project refusal
  // here: that rule exists because a running server would break its own
  // sidebar, and the CLI runs with no server and no boot project. Removing the
  // repo you normally serve is therefore allowed — and self-healing, since the
  // next `cezar serve` in it registers it again (said in the note below).
  if (!(await removeProject(id))) {
    io.error(`unknown project: ${id}`);
    return 1;
  }
  io.log(`  - ${id} (registry entry only — the repo and its .ai/cezar/ are untouched)`);
  return 0;
}
