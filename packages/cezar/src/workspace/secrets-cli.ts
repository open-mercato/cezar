import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SECRET_AUDIENCES, secretNameIssue, type SecretAudience } from '@open-mercato/cezar-contract';
import { SecretStore, SecretsError, type SecretScopeRef } from './secrets.ts';
import { loadWorkspaceConfig } from './config.ts';

const USAGE = 'Usage: cezar secrets list | set <NAME> [--audience checks,cezar] | unset <NAME>   [--workspace] [--repo <dir>]\n' +
  '  set reads the value from stdin (pipe it in, or type it at the hidden prompt) — never from argv.\n' +
  '  --workspace addresses the user\'s own secrets, shared by every project; the default is this project\'s.\n' +
  `  --audience names who may read the secret (${SECRET_AUDIENCES.join(', ')}); the default is checks.`;

export interface SecretsCliIo {
  log: (line: string) => void;
  error: (line: string) => void;
  /** Reads the value for `set`. Injected so tests never touch a real terminal. */
  readValue?: () => Promise<string>;
}

/**
 * `cezar secrets` (spec 2026-10-10-project-secrets-vault-options). Local-only, like
 * `tracker-connections`: it writes the same store the cockpit does and needs no running
 * server. A value is never taken from argv — nothing lands in shell history or `ps` — and
 * only names and metadata are ever printed.
 */
export async function runSecretsCommand(
  args: string[],
  io: SecretsCliIo = { log: console.log, error: console.error },
  env: NodeJS.ProcessEnv = process.env,
  store: SecretStore = new SecretStore(env),
): Promise<number> {
  const parsed = parseArgs(args);
  if (!parsed) {
    io.error(USAGE);
    return 1;
  }
  const { action, workspace, repo, audiences } = parsed;
  if (action.kind !== 'list') {
    const issue = secretNameIssue(action.name);
    if (issue) {
      io.error(`cezar secrets: ${action.name} — ${issue}`);
      return 1;
    }
  }

  let scope: SecretScopeRef;
  if (workspace) {
    scope = { kind: 'workspace' };
  } else {
    const project = await registeredProject(repo ?? process.cwd());
    if (!project) {
      io.error('cezar secrets: this folder is not a registered cezar project — open it in cezar once, then retry (or pass --workspace).');
      return 1;
    }
    scope = { kind: 'project', projectId: project.id, root: project.root };
  }
  try {
    if (action.kind === 'list') {
      const [listed, keyBackend] = await Promise.all([store.list(scope), store.keyBackend()]);
      for (const secret of listed.secrets) io.log(`${secret.name}\t${secret.audiences.join(',')}`);
      if (listed.skipped) io.error(`cezar secrets: store skipped — ${listed.skipped}`);
      io.error(keyBackend === 'keychain'
        ? '# encrypted with a data key in the OS keychain'
        : '# encrypted with a data key in ~/.cezar/secrets/.key (no OS keychain in use) — private file, not a vault');
      return 0;
    }
    if (action.kind === 'set') {
      const value = await (io.readValue ?? readValueFromStdin)();
      if (value === '') {
        io.error('cezar secrets: empty value — nothing saved');
        return 1;
      }
      await store.set(scope, action.name, value, audiences);
      io.log(action.name);
      return 0;
    }
    if (!(await store.unset(scope, action.name))) {
      io.error(`cezar secrets: no secret named ${action.name}`);
      return 1;
    }
    io.log(action.name);
    return 0;
  } catch (error) {
    io.error(
      error instanceof SecretsError
        ? `cezar secrets: ${error.message}`
        : 'cezar secrets: cannot access the secret store — check local storage permissions.',
    );
    return 1;
  }
}

/** `list` takes no operand; `set` and `unset` take exactly a name. Parsing it into this shape
 *  once is what lets the body above use `action.name` as a string without an assertion. */
type SecretsAction = { kind: 'list' } | { kind: 'set' | 'unset'; name: string };

interface ParsedArgs {
  action: SecretsAction;
  workspace: boolean;
  repo?: string;
  audiences?: SecretAudience[];
}

function parseArgs(args: string[]): ParsedArgs | undefined {
  const rest = [...args];
  let workspace = false;
  let repo: string | undefined;
  let audiences: SecretAudience[] | undefined;
  for (let i = 0; i < rest.length; ) {
    const flag = rest[i];
    if (flag === '--workspace') {
      workspace = true;
      rest.splice(i, 1);
    } else if (flag === '--repo' || flag === '--audience') {
      const value = rest[i + 1];
      if (!value) return undefined;
      if (flag === '--repo') repo = value;
      else {
        const names = value.split(',').map((s) => s.trim()).filter(Boolean);
        if (!names.length || !names.every((n): n is SecretAudience => (SECRET_AUDIENCES as readonly string[]).includes(n))) return undefined;
        audiences = names;
      }
      rest.splice(i, 2);
    } else {
      i++;
    }
  }
  const [command, ...operands] = rest;
  if (command === 'list' && operands.length === 0) return { action: { kind: 'list' }, workspace, repo };
  const [name] = operands;
  if ((command === 'set' || command === 'unset') && name !== undefined && operands.length === 1) {
    if (command === 'unset' && audiences) return undefined;
    return { action: { kind: command, name }, workspace, repo, audiences };
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
        if (char === '\u0003') return finish(new SecretsError('cancelled'));
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}
