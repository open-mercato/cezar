import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkEnvNameIssue } from '@open-mercato/cezar-contract';
import { CheckEnv, CheckEnvError } from './check-env.ts';
import { loadWorkspaceConfig } from './config.ts';

const USAGE = 'Usage: cezar check-env list | set <NAME> | unset <NAME>   [--repo <dir>]\n' +
  '  set reads the value from stdin (pipe it in, or type it at the hidden prompt) — never from argv.';

export interface CheckEnvCliIo {
  log: (line: string) => void;
  error: (line: string) => void;
  /** Reads the value for `set`. Injected so tests never touch a real terminal. */
  readValue?: () => Promise<string>;
}

/**
 * `cezar check-env` (spec 2026-10-06-agentic-e2e-checks Phase 1). Local-only, like
 * `tracker-connections`: it writes the same store the cockpit does and needs no running
 * server. A value is never taken from argv — nothing lands in shell history or `ps` — and
 * only names are ever printed.
 */
export async function runCheckEnvCommand(
  args: string[],
  io: CheckEnvCliIo = { log: console.log, error: console.error },
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const rest = [...args];
  let repo = process.cwd();
  const repoAt = rest.indexOf('--repo');
  if (repoAt >= 0) {
    const value = rest[repoAt + 1];
    if (!value) {
      io.error(USAGE);
      return 1;
    }
    repo = value;
    rest.splice(repoAt, 2);
  }
  const action = parseAction(rest);
  if (!action) {
    io.error(USAGE);
    return 1;
  }
  if (action.kind !== 'list') {
    const issue = checkEnvNameIssue(action.name);
    if (issue) {
      io.error(`cezar check-env: ${action.name} — ${issue}`);
      return 1;
    }
  }

  const project = await registeredProject(repo);
  if (!project) {
    io.error('cezar check-env: this folder is not a registered cezar project — open it in cezar once, then retry.');
    return 1;
  }
  const store = new CheckEnv(env);
  try {
    if (action.kind === 'list') {
      for (const stored of await store.names(project.id, project.root)) io.log(stored);
      return 0;
    }
    if (action.kind === 'set') {
      const value = await (io.readValue ?? readValueFromStdin)();
      if (value === '') {
        io.error('cezar check-env: empty value — nothing saved');
        return 1;
      }
      await store.set(project.id, project.root, action.name, value);
      io.log(action.name);
      return 0;
    }
    if (!(await store.unset(project.id, project.root, action.name))) {
      io.error(`cezar check-env: no check credential named ${action.name}`);
      return 1;
    }
    io.log(action.name);
    return 0;
  } catch (error) {
    io.error(
      error instanceof CheckEnvError
        ? `cezar check-env: ${error.message}`
        : 'cezar check-env: cannot access check credentials — check local storage permissions.',
    );
    return 1;
  }
}

/** `list` takes no operand; `set` and `unset` take exactly a name. Parsing it into this shape
 *  once is what lets the body below use `action.name` as a string without an assertion. */
type CheckEnvAction = { kind: 'list' } | { kind: 'set' | 'unset'; name: string };

function parseAction(rest: string[]): CheckEnvAction | undefined {
  const [command, ...operands] = rest;
  if (command === 'list' && operands.length === 0) return { kind: 'list' };
  const [name] = operands;
  if ((command === 'set' || command === 'unset') && name !== undefined && operands.length === 1) {
    return { kind: command, name };
  }
  return undefined;
}

async function registeredProject(repo: string): Promise<{ id: string; root: string } | undefined> {
  const root = await realpath(resolve(repo)).catch(() => resolve(repo));
  const config = await loadWorkspaceConfig();
  return config.projects.find((project) => project.root === root);
}

/**
 * The value from stdin: piped input is read whole (one trailing newline dropped); a terminal
 * gets a prompt with echo off, so the key is never on screen.
 */
async function readValueFromStdin(): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  process.stderr.write('value (input hidden): ');
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((done, fail) => {
    let value = '';
    const finish = (result: string | Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
      if (result instanceof Error) fail(result);
      else done(result);
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') return finish(value);
        if (char === '\u0003') return finish(new CheckEnvError('cancelled'));
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}
