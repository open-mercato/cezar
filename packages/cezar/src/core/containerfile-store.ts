import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { extractInstalls, mergeSuggestions, type InstallSuggestion } from './containerfile-suggest.ts';

/**
 * The pending "your agents installed these — want them in the image?" proposal
 * for one project.
 *
 * Kept next to the run store rather than in `config.json` because it is
 * OBSERVATION, not configuration: cezar wrote it by watching, the user never
 * typed it, and accepting it is what turns it into configuration (a
 * `Containerfile` the user then owns).
 *
 * Degrades to empty on any read problem, like every other user-facing file
 * here: a malformed proposal must not break the settings page that renders it.
 */

const suggestionSchema = z.object({
  command: z.string().min(1),
  manager: z.enum(['apt', 'npm', 'pnpm', 'yarn', 'pip', 'pipx', 'go', 'cargo', 'gem', 'apk', 'dnf']),
});

const fileSchema = z.object({
  /** Installs seen since the proposal was last accepted or dismissed. */
  pending: z.array(suggestionSchema).default([]),
  /** Commands written into the Containerfile — the render list. */
  accepted: z.array(z.string()).default([]),
  /**
   * Commands the user said no to. Kept ONLY so they are never proposed again;
   * they must never reach the rendered file. These were previously folded into
   * `accepted` ("accepted means decided"), which meant a later Accept rebuilt
   * the file from that list and wrote in a command the user had refused.
   */
  dismissed: z.array(z.string()).default([]),
  updatedAt: z.string().optional(),
});

export type ContainerfileProposal = z.infer<typeof fileSchema>;

const EMPTY: ContainerfileProposal = { pending: [], accepted: [], dismissed: [] };

export function proposalPath(dataDir: string): string {
  return join(dataDir, 'container-suggestions.json');
}

export function loadProposal(dataDir: string): ContainerfileProposal {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(proposalPath(dataDir), 'utf8')));
    return parsed.success ? parsed.data : EMPTY;
  } catch {
    return EMPTY;
  }
}

function save(dataDir: string, proposal: ContainerfileProposal): void {
  const path = proposalPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...proposal, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/**
 * Record what one shell command installed. Called for every `Bash` tool call
 * an agent makes, so it must be cheap and must never throw into the run:
 * losing a suggestion is a missed convenience, failing a task is not.
 *
 * Already-accepted commands are skipped — once a package is in the
 * Containerfile, the image has it and re-proposing it would be noise.
 */
export function noteInstalls(dataDir: string, command: string): void {
  try {
    const found = extractInstalls(command);
    if (found.length === 0) return;
    const current = loadProposal(dataDir);
    // Neither written nor refused: those are the only ones worth proposing.
    const decided = new Set([...current.accepted, ...current.dismissed]);
    const fresh = found.filter((f) => !decided.has(f.command));
    if (fresh.length === 0) return;
    const pending = mergeSuggestions(current.pending, fresh);
    if (pending.length === current.pending.length) return;
    save(dataDir, { ...current, pending });
  } catch {
    // observation is best-effort, always
  }
}

/**
 * Accept some of the pending suggestions: write the Containerfile and remember
 * the commands so they are never proposed again.
 *
 * The image is NOT rebuilt here. The container running right now already has
 * these tools — that is where the suggestion came from — so rebuilding would
 * pay for an image nobody is waiting on. `ensureImage` notices the changed file
 * and rebuilds before the NEXT task instead.
 */
export function acceptSuggestions(
  dataDir: string,
  repoRoot: string,
  containerfileRelPath: string,
  commands: string[],
  render: (accepted: InstallSuggestion[]) => string,
): { written: string; accepted: InstallSuggestion[] } {
  const current = loadProposal(dataDir);
  const chosen = current.pending.filter((s) => commands.includes(s.command));
  const keptPending = current.pending.filter((s) => !commands.includes(s.command));

  const acceptedAll = mergeSuggestions(
    current.accepted.map((command) => ({ command, manager: managerOf(command) })),
    chosen,
  );

  const target = join(repoRoot, containerfileRelPath);
  mkdirSync(dirname(target), { recursive: true });
  let existing: string | undefined;
  try {
    existing = readFileSync(target, 'utf8');
  } catch {
    existing = undefined;
  }
  if (existing === undefined) {
    writeFileSync(target, render(acceptedAll), 'utf8');
  } else {
    // A file that exists is the USER's, whoever wrote its first line: they may have hand-edited
    // cezar's render or written their own `FROM`. Rewriting it from `accepted` silently threw
    // that work away, so only the commands it does not already run are appended.
    const present = new Set(existing.split('\n').map((line) => line.trim()));
    const added = chosen.filter((s) => !present.has(`RUN ${s.command}`)).map((s) => `RUN ${s.command}`);
    if (added.length > 0) {
      const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
      writeFileSync(target, `${existing}${separator}${added.join('\n')}\n`, 'utf8');
    }
  }

  save(dataDir, {
    pending: keptPending,
    accepted: acceptedAll.map((s) => s.command),
    dismissed: current.dismissed,
  });
  return { written: target, accepted: acceptedAll };
}

/** Drop suggestions without writing them — the user said no. */
export function dismissSuggestions(dataDir: string, commands: string[]): ContainerfileProposal {
  const current = loadProposal(dataDir);
  const next: ContainerfileProposal = {
    ...current,
    pending: current.pending.filter((s) => !commands.includes(s.command)),
    // Its own list: do-not-propose-again is not the same as write-this-down.
    dismissed: [...new Set([...current.dismissed, ...commands])],
  };
  save(dataDir, next);
  return next;
}

/** Recover the manager from a rendered command, for re-rendering the file. */
function managerOf(command: string): InstallSuggestion['manager'] {
  if (command.startsWith('apt-get')) return 'apt';
  if (command.startsWith('apk')) return 'apk';
  if (command.startsWith('dnf')) return 'dnf';
  if (command.startsWith('npm')) return 'npm';
  if (command.startsWith('pnpm')) return 'pnpm';
  if (command.startsWith('yarn')) return 'yarn';
  if (command.startsWith('pipx')) return 'pipx';
  if (command.startsWith('pip')) return 'pip';
  if (command.startsWith('go')) return 'go';
  if (command.startsWith('cargo')) return 'cargo';
  return 'gem';
}

/** True when a project has an on-disk Containerfile already. */
export function hasContainerfile(repoRoot: string, relPath: string): boolean {
  return existsSync(join(repoRoot, relPath));
}
