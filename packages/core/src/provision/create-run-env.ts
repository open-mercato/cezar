import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectEnvSpec, RunEnv } from './run-env.js';
import { NativeShellEnv } from './native-shell-env.js';
import { DockerComposeEnv, type ComposeCommand } from './docker-compose-env.js';
import { detectComposeFile, firstComposeService } from './compose-detect.js';

const execFileAsync = promisify(execFile);

export interface CreateRunEnvOpts {
  worktreePath: string;
  spec: ProjectEnvSpec;
  /** Unique per run; used to name the compose project. */
  runId: string;
  onWarn?: (message: string) => void;
}

/** Sanitize a run id into a compose-project-safe slug (lowercase alnum + dashes). */
function composeProjectName(runId: string): string {
  const slug =
    runId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 24) || 'run';
  return `cezar-${slug}`;
}

/**
 * Detect how compose is invoked on this host. Prefers the v2 plugin
 * (`docker compose`), falls back to the v1 binary (`docker-compose`), returns
 * `null` when neither is available.
 */
export async function resolveComposeCommand(): Promise<ComposeCommand | null> {
  try {
    await execFileAsync('docker', ['compose', 'version']);
    return { bin: 'docker', lead: ['compose'] };
  } catch {
    // fall through
  }
  try {
    await execFileAsync('docker-compose', ['version']);
    return { bin: 'docker-compose', lead: [] };
  } catch {
    return null;
  }
}

/**
 * Build the `RunEnv` for a checked-out worktree from the resolved
 * `autofix.projectEnv` spec.
 *
 *  - `kind: 'native'` → host shell.
 *  - `kind: 'compose'` → docker compose (throws if Docker isn't available —
 *    compose-based runs are self-hosted-runner only).
 *  - `kind: 'auto'` → compose if a compose file exists in the worktree AND
 *    Docker is available, else native.
 */
export async function createRunEnv(opts: CreateRunEnvOpts): Promise<RunEnv> {
  const { worktreePath, spec } = opts;

  const explicitCompose = spec.kind === 'compose';
  const composeFileRel = spec.compose.file.trim() || detectComposeFile(worktreePath);
  const wantCompose = explicitCompose || (spec.kind === 'auto' && composeFileRel != null);

  if (!wantCompose) {
    return new NativeShellEnv(worktreePath, spec);
  }

  if (!composeFileRel) {
    throw new Error(
      `projectEnv.kind is 'compose' but no compose file was found in the repo. ` +
        `Add a docker-compose.yml or set autofix.projectEnv.compose.file.`,
    );
  }

  const compose = await resolveComposeCommand();
  if (!compose) {
    if (spec.kind === 'auto') {
      // Auto-detected a compose file but this host has no Docker — fall back to
      // native rather than failing the run. (The managed cloud path has no
      // Docker; compose runs belong on a self-hosted runner.)
      opts.onWarn?.(
        `[run-env] found ${composeFileRel} but Docker is not available here; falling back to the native shell env. ` +
          `Run this workspace on a self-hosted runner to use the compose env.`,
      );
      return new NativeShellEnv(worktreePath, spec);
    }
    throw new Error(
      `projectEnv.kind is 'compose' but Docker is not available on this runner. ` +
        `Compose-based runs require a self-hosted runner with a Docker daemon.`,
    );
  }

  const service = spec.compose.service.trim() || firstComposeService(worktreePath, composeFileRel);
  if (!service) {
    throw new Error(
      `could not determine the app service in ${composeFileRel}. ` +
        `Set autofix.projectEnv.compose.service to the service install/build/test should run in.`,
    );
  }

  return new DockerComposeEnv({
    worktreePath,
    composeFile: resolve(worktreePath, composeFileRel),
    service,
    workdir: spec.compose.workdir || '/app',
    project: composeProjectName(opts.runId),
    compose,
    spec,
  });
}
