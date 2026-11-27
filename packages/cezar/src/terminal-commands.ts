import {
  TERMINAL_COMMANDS_MAX,
  terminalCommandSchema,
  type ConfiguredCommandEntry,
  type TerminalCommand,
  type TerminalCommandsState,
} from '@open-mercato/cezar-contract';

import { readRaw, writeScopedKey } from './start-app.ts';
import { loadWorkspaceConfig } from './workspace/config.ts';

/**
 * Run commands a project defines for its task terminals (#1555): `terminalCommands` in the repo's
 * `.ai/cezar/config.json` (the team's) and in the project's entry of `~/.cezar/config.json`
 * (yours). Optional in both; a value that is not a list counts as absent, like `startApp`.
 */
const KEY = 'terminalCommands';

const warned = new Set<string>();

/** Per-entry salvage: one hand-edited entry with a newline or control byte is dropped (with one
 *  warning per distinct entry), never the whole list and never the terminal. */
function parse(value: unknown, where: string): TerminalCommand[] {
  if (!Array.isArray(value)) return [];
  const out: TerminalCommand[] = [];
  for (const raw of value) {
    const parsed = terminalCommandSchema.safeParse(raw);
    if (parsed.success) {
      if (out.length < TERMINAL_COMMANDS_MAX) out.push(parsed.data);
      continue;
    }
    const key = `${where}\0${JSON.stringify(raw)}`;
    if (warned.has(key)) continue;
    warned.add(key);
    console.warn(`[cez] ignoring an invalid ${KEY} entry in ${where}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  }
  return out;
}

export async function readTerminalCommands(dataDir: string, root: string): Promise<TerminalCommandsState> {
  const entry = (await loadWorkspaceConfig()).projects.find((project) => project.root === root);
  return {
    project: parse((await readRaw(dataDir))[KEY], '.ai/cezar/config.json'),
    personal: entry ? parse((entry as Record<string, unknown>)[KEY], '~/.cezar/config.json') : [],
    personalAvailable: entry !== undefined,
  };
}

/** Yours first, then the team's; a command line both define is offered once, as yours. */
export function configuredCommands(state: TerminalCommandsState): ConfiguredCommandEntry[] {
  const seen = new Set<string>();
  const out: ConfiguredCommandEntry[] = [];
  for (const scope of ['personal', 'project'] as const) {
    for (const entry of state[scope]) {
      if (seen.has(entry.command)) continue;
      seen.add(entry.command);
      out.push({ ...entry, scope });
    }
  }
  return out;
}

/** Replaces one scope's list; an empty list removes the key. */
export function writeTerminalCommands(
  dataDir: string,
  root: string,
  scope: 'project' | 'personal',
  commands: TerminalCommand[],
): Promise<boolean> {
  return writeScopedKey(dataDir, root, scope, KEY, commands.length > 0 ? commands : null);
}
