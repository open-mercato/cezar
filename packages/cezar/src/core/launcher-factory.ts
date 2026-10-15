import type { SandboxConfig } from '../config.ts';
import { localLauncher, type ProcessLauncher } from './process-launcher.ts';
import { PodmanLauncher } from './podman-launcher.ts';

/**
 * The single place a `sandbox` config block becomes a launcher — the twin of
 * `runner-factory.ts`, which maps a backend id onto a runner. Keeping the two
 * separate is the point: WHERE a task runs and WHICH agent runs it are
 * independent, so every backend gets isolation for free.
 *
 * Absent or disabled config yields the local launcher, so an install that says
 * nothing behaves exactly as it always has.
 */
export function createLauncher(
  sandbox: SandboxConfig | undefined,
  /** The per-task container podman execs into; the engine creates it per run. */
  container?: { name: string; publishedPort?: number; homes?: { claude: string; kimi: string }; claudeContainerLogin?: boolean },
  /** Secrets fetched on the host for this turn — see `PodmanLauncher`. */
  fetchedEnv: readonly string[] = [],
): ProcessLauncher {
  if (!sandbox?.enabled) return localLauncher;
  // Without a container there is nothing to exec into. Falling back to local would run the agent
  // UNISOLATED while the config says otherwise, so the caller must supply one — see the engine's
  // per-task creation.
  if (!container) return localLauncher;
  return new PodmanLauncher(
    sandbox, container.name, 'podman', container.publishedPort, fetchedEnv, container.homes, container.claudeContainerLogin === true,
  );
}
