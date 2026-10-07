import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Commands a task's project already defines (spec `.ai/specs/2026-10-07-task-workspace.md` §6:
 * "Commands discovered from the project show their source file and run only after explicit
 * selection, in a new terminal tab. Manual commands are also allowed.").
 *
 * Discovery only — nothing here runs anything. The source file travels with every entry because
 * that is what makes a suggested command trustworthy: `dev` means one thing in `package.json`
 * and another in a `Makefile`, and a user about to hand a shell a command deserves to see which
 * one they are about to run.
 *
 * Zero config, like everything else cezar discovers: no manifest, no list to maintain, and a
 * project with none of these files simply offers nothing and lets the user type their own.
 */

export interface DiscoveredCommand {
  /** What would be typed into a shell, verbatim. */
  command: string;
  /** The file it came from, relative to the worktree — shown beside it. */
  source: string;
  /** The script's own text, when the source records one. Lets a user see what `dev` actually is
   *  before running it. */
  detail?: string;
}

/** A bound on how many of each kind are offered. A generated `package.json` can carry a hundred
 *  scripts, and a picker that long is not a picker. */
const PER_SOURCE_LIMIT = 40;

/**
 * Everything discoverable in a worktree.
 *
 * Never throws and never rejects: an unreadable file, a malformed `package.json`, a worktree that
 * was reclaimed mid-read — each is "nothing from that source", because this feeds a convenience
 * list and must not be able to break the drawer that shows it.
 */
export async function discoverCommands(worktree: string): Promise<DiscoveredCommand[]> {
  const [scripts, targets] = await Promise.all([
    readPackageScripts(worktree),
    readMakefileTargets(worktree),
  ]);
  return [...scripts, ...targets];
}

async function readPackageScripts(worktree: string): Promise<DiscoveredCommand[]> {
  const text = await readIfPresent(join(worktree, 'package.json'));
  if (text === null) return [];
  return parsePackageScripts(text);
}

/** `package.json` → `npm run <name>`, in the order the file lists them. */
export function parsePackageScripts(text: string): DiscoveredCommand[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (typeof scripts !== 'object' || scripts === null) return [];

  const out: DiscoveredCommand[] = [];
  for (const [name, body] of Object.entries(scripts as Record<string, unknown>)) {
    if (out.length >= PER_SOURCE_LIMIT) break;
    // A script name with shell metacharacters is not a name npm would accept, and quoting it
    // here would only hide that. Skip rather than offer something that would not run.
    if (!/^[\w.:@-]+$/.test(name)) continue;
    out.push({
      command: `npm run ${name}`,
      source: 'package.json',
      ...(typeof body === 'string' && body.trim() !== '' ? { detail: body.trim() } : {}),
    });
  }
  return out;
}

async function readMakefileTargets(worktree: string): Promise<DiscoveredCommand[]> {
  for (const name of ['Makefile', 'makefile', 'GNUmakefile']) {
    const text = await readIfPresent(join(worktree, name));
    if (text !== null) return parseMakefileTargets(text).map((entry) => ({ ...entry, source: name }));
  }
  return [];
}

/**
 * `Makefile` → `make <target>`.
 *
 * Only targets that start a line, name themselves with ordinary characters, and are not pattern
 * or special rules. Make's grammar is far larger than this; the aim is to recognise the handful
 * of targets a human would have run anyway, not to parse Make.
 */
export function parseMakefileTargets(text: string): DiscoveredCommand[] {
  const out: DiscoveredCommand[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    if (out.length >= PER_SOURCE_LIMIT) break;
    // `name:` or `name: deps`, at column zero. Excludes `.PHONY`, `%.o`, variables (`X := y`)
    // and recipe lines (which are indented by a tab).
    const match = /^([A-Za-z][\w.-]*)\s*:(?!=)/.exec(line);
    if (!match) continue;
    const target = match[1]!;
    if (seen.has(target)) continue;
    seen.add(target);
    out.push({ command: `make ${target}`, source: 'Makefile' });
  }
  return out;
}

/** A file's text, or null when it is absent, unreadable, or implausibly large for a manifest. */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, 'utf8');
    return text.length > 512_000 ? null : text;
  } catch {
    return null;
  }
}
