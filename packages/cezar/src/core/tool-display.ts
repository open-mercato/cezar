/**
 * Tool display model — turns a backend tool name + raw input into the
 * `{toolKind, title, subtitle?}` a tool card renders. Computed ONCE here in
 * the protocol layer (paseo's pattern), never in components, so the thread,
 * activity groups and notifications all say the same thing.
 *
 * Pure function over untrusted input: tool inputs come off the wire and may
 * be null, partial (streamed incrementally) or arbitrarily malformed —
 * `toolDisplay` must never throw.
 *
 * Known names covered (matched case-insensitively so claude's `Bash` and
 * opencode's `bash` share one row):
 *  - claude:   Bash, Edit, Write, NotebookEdit, Read, Glob, Grep, WebFetch,
 *              WebSearch, Task, Agent, Skill, TodoWrite, TaskCreate,
 *              TaskUpdate, TaskList, mcp__server__tool
 *  - codex:    commandExecution, contextCompaction, fileChange, imageView,
 *              mcpToolCall, webSearch, plan
 *              (codex's checklist arrives as the `turn/plan/updated`
 *              notification, not as a tool call — `todoList` is kept below only
 *              as tolerance for its non-app-server transports)
 *  - opencode: bash, edit, write, read, grep, glob, webfetch, task, todowrite
 */

import type { ToolKind } from './ui-events.ts';

export interface ToolDisplay {
  toolKind: ToolKind;
  /** Human line for the card trigger, e.g. "Ran npm test". */
  title: string;
  /** Secondary detail, e.g. the claude Bash `description`. */
  subtitle?: string;
}

/** Longest title/subtitle we emit — display truncation belongs here, not in
 *  every component that renders a tool line. */
const MAX_LABEL = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Collapse whitespace (multi-line commands become one line) and cap length. */
function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_LABEL ? `${collapsed.slice(0, MAX_LABEL - 1)}…` : collapsed;
}

/** First non-empty string among `input[keys...]`, normalized for display. */
function field(input: unknown, ...keys: string[]): string | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() !== '') return oneLine(value);
  }
  return undefined;
}

/** claude Bash carries `command: string`; codex commandExecution may carry
 *  a string or an argv array — join the string members. */
function commandText(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const command = input.command;
  if (typeof command === 'string' && command.trim() !== '') return oneLine(command);
  if (Array.isArray(command)) {
    const argv = command.filter((part): part is string => typeof part === 'string');
    if (argv.length > 0) return oneLine(argv.join(' '));
  }
  return undefined;
}

/** File paths listed by a codex `fileChange` item (`changes: [{path}]`). */
function changePaths(input: unknown): string[] {
  if (!isRecord(input) || !Array.isArray(input.changes)) return [];
  const paths: string[] = [];
  for (const change of input.changes) {
    if (isRecord(change) && typeof change.path === 'string' && change.path.trim() !== '') {
      paths.push(change.path);
    }
  }
  return paths;
}

/** The opencode research heuristic for unknown tools: the first plausible
 *  human label in the input, in a fixed priority order. */
function heuristicLabel(input: unknown): string | undefined {
  return field(input, 'description', 'query', 'url', 'filePath', 'file_path', 'path', 'pattern', 'name');
}

/** Verb + optional object → "Read src/a.ts", or just the verb when the
 *  input gave us nothing usable. */
function titled(verb: string, label: string | undefined): string {
  return label ? `${verb} ${label}` : verb;
}

export function toolDisplay(name: string, input?: unknown): ToolDisplay {
  const key = typeof name === 'string' ? name.toLowerCase() : '';

  switch (key) {
    case 'bash':
    case 'commandexecution':
      return {
        toolKind: 'execute',
        title: titled('Ran', commandText(input)),
        subtitle: field(input, 'description'),
      };

    case 'edit':
    case 'multiedit':
      return { toolKind: 'edit', title: titled('Edit', field(input, 'file_path', 'filePath', 'path')) };
    case 'write':
      return { toolKind: 'edit', title: titled('Write', field(input, 'file_path', 'filePath', 'path')) };
    case 'notebookedit':
      return {
        toolKind: 'edit',
        title: titled('Edit', field(input, 'notebook_path', 'notebookPath', 'file_path', 'filePath', 'path')),
      };
    case 'filechange': {
      const paths = changePaths(input);
      const label = paths.length === 1 ? paths[0] : paths.length > 1 ? `${paths.length} files` : undefined;
      return { toolKind: 'edit', title: titled('Edit', label) };
    }

    case 'read':
      return { toolKind: 'read', title: titled('Read', field(input, 'file_path', 'filePath', 'path')) };
    case 'imageview':
      return { toolKind: 'read', title: titled('View image', field(input, 'path')) };
    case 'glob':
    case 'grep':
      return {
        toolKind: 'search',
        title: titled('Search', field(input, 'pattern', 'query')),
        subtitle: field(input, 'path'),
      };

    case 'webfetch':
      return { toolKind: 'fetch', title: titled('Fetch', field(input, 'url')) };
    case 'websearch':
      return { toolKind: 'fetch', title: titled('Web search', field(input, 'query')) };

    // Sub-agent spawns. claude dispatches these through `Agent` today and
    // `Task` historically (opencode uses `task`) — both spellings resolve, and
    // the row says which agent, falling back to the subagent type when the
    // call carried no description.
    case 'task':
    case 'agent': {
      const verb = key === 'agent' ? 'Agent' : 'Task';
      const subagent = field(input, 'subagent_type', 'subagentType');
      const label = field(input, 'description', 'prompt') ?? subagent;
      return {
        toolKind: 'task',
        title: label ? `${verb}: ${label}` : verb,
        // Don't repeat the subagent type when it is already the title.
        subtitle: label === subagent ? undefined : subagent,
      };
    }

    // claude's `Skill` invocation: `{skill, args?}` — the skill name is the
    // whole point of the row, so it goes in the title.
    case 'skill': {
      const skill = field(input, 'skill', 'name', 'command');
      return {
        toolKind: 'task',
        title: skill ? `Skill: ${skill}` : 'Skill',
        subtitle: field(input, 'args', 'description'),
      };
    }

    case 'todowrite':
    case 'todolist':
    case 'plan':
    case 'taskcreate':
    case 'taskupdate':
    case 'tasklist':
      return { toolKind: 'plan', title: 'Update plan' };

    case 'contextcompaction':
      return { toolKind: 'other', title: 'Compacted context' };

    case 'mcptoolcall': {
      const server = field(input, 'server');
      const tool = field(input, 'tool');
      if (server && tool) return { toolKind: 'other', title: `${server}.${tool}` };
      return { toolKind: 'other', title: 'MCP tool', subtitle: heuristicLabel(input) };
    }
  }

  // claude/opencode MCP tools are named `mcp__server__tool` → "server.tool".
  if (key.startsWith('mcp__')) {
    const parts = name.split('__').filter((part) => part !== '');
    if (parts.length >= 3) {
      return { toolKind: 'other', title: `${parts[1]}.${parts.slice(2).join('__')}` };
    }
  }

  // Unknown tool: keep the backend's name as the title, heuristic subtitle.
  return {
    toolKind: 'other',
    title: typeof name === 'string' && name.trim() !== '' ? oneLine(name) : 'Tool',
    subtitle: heuristicLabel(input),
  };
}
