/**
 * The `cez-manager` command words, in one place: the CLI dispatches on them, and turn stats read
 * them to tell routing from lookups (spec 2026-11-21-manager-short-sessions-and-memory § 2.3).
 */

export const MANAGER_COMMANDS = ['status', 'attention', 'tasks', 'prs', 'task', 'workflows', 'merge', 'automation', 'job', 'propose-action', 'rename', 'memory', 'history'] as const;
export const MANAGER_TASK_SUBCOMMANDS = ['create', 'say', 'switch', 'cancel', 'retry', 'follow', 'unfollow'] as const;
export const MANAGER_JOB_SUBCOMMANDS = ['add', 'list', 'remove'] as const;
export const MANAGER_MEMORY_SUBCOMMANDS = ['list', 'set', 'remove'] as const;
/** `cez automation`'s own subcommands, which `cez-manager automation` passes through. */
export const MANAGER_AUTOMATION_SUBCOMMANDS = ['create', 'add', 'report', 'run', 'update', 'check', 'list', 'show', 'enable', 'pause', 'delete', 'export', 'import', 'schema'] as const;

type Command = (typeof MANAGER_COMMANDS)[number];

/** Each command's subcommands; a command missing here takes none. */
export const MANAGER_SUBCOMMANDS: Partial<Record<Command, readonly string[]>> = {
  task: MANAGER_TASK_SUBCOMMANDS,
  job: MANAGER_JOB_SUBCOMMANDS,
  memory: MANAGER_MEMORY_SUBCOMMANDS,
  automation: MANAGER_AUTOMATION_SUBCOMMANDS,
};

/** What acts on cezar or hands work on; every other command word only reads. `true`: the command
 *  itself acts; a set: those subcommands act. */
export const MANAGER_ROUTES: Partial<Record<Command, true | ReadonlySet<string>>> = {
  merge: true,
  'propose-action': true,
  rename: true,
  task: new Set(['create', 'say', 'switch', 'follow', 'unfollow', 'cancel', 'retry']),
  job: new Set(['add', 'remove']),
  memory: new Set(['set', 'remove']),
  automation: new Set(['create', 'add', 'report', 'run', 'update', 'enable', 'pause', 'delete', 'import']),
};

export const isManagerCommand = (word: string): word is Command => (MANAGER_COMMANDS as readonly string[]).includes(word);
