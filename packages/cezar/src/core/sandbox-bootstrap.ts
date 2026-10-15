import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { acceptSuggestions, loadProposal } from './containerfile-store.ts';
import { renderContainerfile } from './containerfile-suggest.ts';
import type { SandboxConfig } from '../config.ts';

/**
 * Write down what a first isolated run in an UNCONFIGURED repo learned.
 *
 * A repo can now isolate without ever having been configured: the machine-wide
 * template supplies the credentials, caches and limits, and a per-task toggle
 * can turn isolation on by itself. That is convenient and it is also invisible —
 * nothing on disk says the project isolates, Settings shows it as off, and every
 * package the first task installed is thrown away with the container.
 *
 * So the first isolated run leaves two artifacts behind, and only ever the first:
 *
 *  - a MINIMAL `sandbox` block — `enabled` and a name, nothing else. Writing the
 *    fully merged configuration would be the easy thing and the wrong one: the
 *    repo would pin today's copy of the machine template and stop following it,
 *    so changing an ssh key machine-wide would quietly miss every project that
 *    had ever run a task.
 *  - the installs the agent performed, as a `Containerfile`, so the NEXT task
 *    starts from an image that already has them. This is the one place cezar
 *    accepts install suggestions on the operator's behalf, and it is bounded to
 *    the bootstrap case: a repo that has a config, or already has a
 *    Containerfile, keeps the propose-and-accept flow, because there the file is
 *    something its owner is maintaining.
 */
export interface BootstrapResult {
  /** The config written, when one was. */
  config?: string;
  /** The Containerfile written, when installs were observed. */
  containerfile?: string;
  /** How many install commands were written into it. */
  installs: number;
}

export function bootstrapRepoSandbox(
  repoRoot: string,
  dataDir: string,
  sandbox: SandboxConfig,
): BootstrapResult {
  const result: BootstrapResult = { installs: 0 };
  const configPath = join(repoRoot, '.ai/cezar', 'config.json');
  // The gate: a repo that has said ANYTHING owns its own configuration, and
  // this must not edit it.
  if (existsSync(configPath)) return result;

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify({ sandbox: { enabled: true, name: sandbox.name || basename(repoRoot) } }, null, 2)}\n`,
    'utf8',
  );
  result.config = configPath;

  // Everything the agent installed, in one go. `acceptSuggestions` renders the
  // whole file rather than appending, and moves the commands out of `pending`
  // so the Settings panel does not then offer what is already written.
  const pending = loadProposal(dataDir).pending;
  if (pending.length === 0) return result;
  if (existsSync(join(repoRoot, sandbox.containerfile))) return result;
  const written = acceptSuggestions(
    dataDir,
    repoRoot,
    sandbox.containerfile,
    pending.map((s) => s.command),
    (all) => renderContainerfile(all),
  );
  result.containerfile = written.written;
  result.installs = written.accepted.length;
  return result;
}
