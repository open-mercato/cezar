import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { isMap, isNode, parse as parseYaml, parseDocument as parseYamlDocument } from 'yaml';
import { providerFileMethodSchema, providersFileSchema, runnerSchema, type ProvidersFile, type Runner } from '@open-mercato/cezar-contract';
import { authMethods, providerHostKey, retainStartupHostKey } from './core/agent-auth-methods.ts';
import { ProviderAuthService } from './core/provider-auth.ts';
import { applyProviderChanges, providerEntries, refreshProviderModels, removeProviderMethod, type ProviderChange, type ProviderLogin } from './agent-providers/service.ts';
import { readAgentProviders } from './workspace/agent-providers.ts';

const LIMIT = 1024 * 1024;
const HELP = `cezar providers apply <file|json|-> [--no-fetch]
cezar providers set <runner> <method> [--label TEXT] [--base-url URL] [--key-stdin | --key-env NAME | --key-file PATH] [--active] [--no-fetch]
cezar providers select <runner> <method|none>
cezar providers remove <runner> <method>
cezar providers list [--json]`;

async function stdinText() {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > LIMIT) throw new Error('Provider input exceeds 1 MiB.');
    parts.push(bytes);
  }
  return Buffer.concat(parts).toString('utf8');
}

async function boundedFile(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > LIMIT) throw new Error('Provider input must be a regular file under 1 MiB.');
    const data = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== info.size) throw new Error('Provider input changed while reading.');
    return { value: data.subarray(0, offset).toString('utf8'), mode: info.mode };
  } finally { await file.close(); }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isNode(value);
}

// On a syntax error, walk the surviving mapping nodes directly without resolving aliases.
function field(value: unknown, key: string): unknown {
  if (isMap(value)) return value.get(key);
  return record(value) ? value[key] : undefined;
}

function values(value: unknown): unknown[] {
  if (isMap(value)) return value.items.map(pair => pair.value);
  return record(value) ? Object.values(value) : [];
}

function keySources(raw: unknown, names: Set<string>) {
  for (const agent of values(field(raw, 'agents'))) {
    for (const method of values(field(agent, 'methods'))) {
      const name = providerFileMethodSchema.shape.apiKeyEnv.safeParse(field(method, 'apiKeyEnv'));
      if (name.success && name.data) names.add(name.data);
    }
  }
}

async function readDocument(source: string, stdin: () => Promise<string>, sources: Set<string>) {
  const inline = source.trimStart().startsWith('{');
  const file = !inline && source !== '-' ? await boundedFile(source) : undefined;
  const text = file?.value ?? (inline ? source : await stdin());
  if (Buffer.byteLength(text) > LIMIT) throw new Error('Provider input exceeds 1 MiB.');
  let raw: unknown;
  try {
    raw = inline || (file && extname(source).toLowerCase() === '.json') ? JSON.parse(text) : parseYaml(text);
  } catch {
    // This tree is for cleanup only. Keep the original parser's rejection and diagnostic.
    const partial = parseYamlDocument(text, { logLevel: 'silent' });
    keySources(partial.contents, sources);
    throw new Error('Invalid providers JSON or YAML.');
  }
  keySources(raw, sources);
  const parsed = providersFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid providers document at ' + (parsed.error.issues[0]?.path.join('.') || 'version/agents') + '.');
  for (const agent of Object.values(parsed.data.agents)) {
    for (const method of Object.values(agent.methods ?? {})) {
      if (method.apiKey === undefined) continue;
      if (inline) throw new Error('A key on the command line is visible in ps; use apiKeyEnv, apiKeyFile or --providers -');
      if (file && (file.mode & 0o077) !== 0) throw new Error('Inline key requires a private providers file. Run chmod 600 on ' + source + '.');
    }
  }
  return parsed.data;
}

function envName(name: string) {
  return process.platform === 'win32' ? name.toUpperCase() : name;
}

async function changesFrom(doc: ProvidersFile, keys: ReadonlyMap<string, string | undefined>): Promise<ProviderChange[]> {
  const changes: ProviderChange[] = [];
  for (const runner of runnerSchema.options) {
    const entry = doc.agents[runner];
    if (!entry) continue;
    const methods: ProviderChange['methods'] = [];
    for (const [id, { apiKey, apiKeyFile, apiKeyEnv, ...rest }] of Object.entries(entry.methods ?? {})) {
      let key = apiKey;
      if (apiKeyEnv) key = keys.get(envName(apiKeyEnv));
      if (apiKeyFile) {
        try { key = (await boundedFile(apiKeyFile)).value.replace(/\r?\n$/, ''); }
        catch { throw new Error('Could not read the key file for ' + runner + '/' + id + '.'); }
      }
      if ((apiKeyEnv || apiKeyFile || apiKey !== undefined) && !key?.trim()) throw new Error('Empty key source for ' + runner + '/' + id + '.');
      methods.push({ id, ...rest, ...(key ? { apiKey: key } : {}) });
    }
    changes.push({ runner, active: entry.active, methods });
  }
  return changes;
}

async function loginStatus(runners?: Runner[], env = process.env): Promise<ProviderLogin[]> {
  const auth = new ProviderAuthService({ cwd: process.cwd(), env });
  if (runners) {
    const rows: ProviderLogin[] = [];
    for (const runner of runners) rows.push(await auth.loginStatus(runner));
    return rows;
  }
  return (await auth.status()).providers.map(row => ({ ...row, methods: auth.methodStatuses(row.provider) }));
}

async function applyChanges(changes: ProviderChange[], origin: 'cli' | 'file', logins: typeof loginStatus, present: Record<string, string> = {}) {
  const { agents } = await readAgentProviders();
  const runners = changes.filter(({ runner, active, methods }) => {
    const caps = authMethods(runner);
    if (caps.mode !== 'one') return false;
    if (active === undefined) return methods.length > 0 && !agents[runner];
    const selected = caps.methods.find(method => method.id === active);
    return selected?.kind === 'subscription' || (!!selected?.hostKeyEnv &&
      !agents[runner]?.methods[selected.id] && !methods.some(method => method.id === selected.id));
  }).map(change => change.runner);
  if (!runners.length) return applyProviderChanges(changes, origin, []);
  // Local status parsers need presence, while their child processes inherit the scrubbed environment.
  const env = Object.keys(present).length ? { ...process.env, ...present } : process.env;
  const rows = await logins(runners, env);
  const evidence = rows.map(row => {
    const methods = { ...row.methods };
    for (const method of authMethods(row.provider).methods) {
      if (providerHostKey(row.provider, method, present)) methods[method.id] = 'connected';
    }
    return { ...row, methods };
  });
  return applyProviderChanges(changes, origin, evidence);
}

async function importMethods(doc: ProvidersFile, origin: 'cli' | 'file', logins: typeof loginStatus, sources: Iterable<string>) {
  // One import per CLI process. Take every input before the first await and never re-export it.
  const keys = new Map(Array.from(sources, name => [envName(name), Object.hasOwn(process.env, name) ? process.env[name] : undefined] as const));
  const present: Record<string, string> = Object.create(null);
  for (const [name, value] of keys) {
    delete process.env[name];
    if (value?.trim()) present[name] = '1';
  }
  const changes = await changesFrom(doc, keys);
  const fetches = await applyChanges(changes, origin, logins, present);
  return { changes, fetches, keys };
}

async function applyDocument(source: string, stdin: typeof stdinText, logins: typeof loginStatus) {
  const sources = new Set<string>();
  let doc: ProvidersFile;
  try { doc = await readDocument(source, stdin, sources); }
  catch (error) {
    for (const name of sources) delete process.env[name];
    throw error;
  }
  return importMethods(doc, 'file', logins, sources);
}

export async function applyProvidersAtStartup(source: string) {
  const { changes, fetches, keys } = await applyDocument(source, stdinText, loginStatus);
  if (keys.size) {
    const { agents } = await readAgentProviders();
    for (const { runner, active } of changes) {
      const entry = agents[runner];
      if (!active || entry?.active !== active || entry.methods[active]) continue;
      const method = authMethods(runner).methods.find(m => m.id === active);
      if (method) retainStartupHostKey(runner, method, keys);
    }
  }
  return fetches;
}

type MethodRef = { runner: ProviderChange['runner']; id: string };
export async function fetchAppliedProviders(fetches: MethodRef[], warn: (text: string) => void = console.warn) {
  for (const { runner, id } of fetches) {
    try {
      const { error } = await refreshProviderModels(runner, id);
      if (error) warn(runner + '/' + id + ': ' + error);
    } catch { warn(runner + '/' + id + ': Could not refresh models. Retry in Settings.'); }
  }
}

export async function runProvidersCommand(argv: string[], io = { stdin: stdinText, log: console.log, error: console.error, logins: loginStatus }): Promise<number> {
  try {
    const [command, ...args] = argv;
    if (!command || command === '--help' || command === 'help') { io.log(HELP); return 0; }
    const optionsByCommand: Record<string, NonNullable<ParseArgsConfig['options']>> = {
      apply: { 'no-fetch': { type: 'boolean' } },
      set: { label: { type: 'string' }, 'base-url': { type: 'string' }, 'key-stdin': { type: 'boolean' },
        'key-env': { type: 'string' }, 'key-file': { type: 'string' }, active: { type: 'boolean' }, 'no-fetch': { type: 'boolean' } },
      remove: {}, select: {}, list: { json: { type: 'boolean' } },
    } as const;
    if (!Object.hasOwn(optionsByCommand, command)) throw new Error(HELP);
    let parsed;
    try {
      parsed = parseArgs({ args, options: optionsByCommand[command]!, allowPositionals: true, strict: true });
    } catch { throw new Error('Invalid providers flags. ' + HELP); }
    const { positionals, values } = parsed;
    if (positionals.length !== (command === 'list' ? 0 : command === 'apply' ? 1 : 2)) throw new Error(HELP);
    if (command === 'list') {
      const agents = await providerEntries(await io.logins());
      if (values.json) io.log(JSON.stringify({ agents }));
      else for (const agent of agents) for (const method of agent.methods) {
        io.log([agent.runner, method.id, method.state, method.id === agent.active ? 'active' : '', method.keyHint,
          method.baseUrl, method.origin, method.modelCount === undefined ? '' : method.modelCount + ' models'].filter(Boolean).join(' · '));
      }
      return 0;
    }
    if (command === 'apply') {
      const { changes, fetches } = await applyDocument(positionals[0]!, io.stdin, io.logins);
      if (!values['no-fetch']) await fetchAppliedProviders(fetches, io.error);
      for (const change of changes) {
        for (const method of change.methods) io.log('Saved ' + change.runner + '/' + method.id);
        if (!change.methods.length) io.log('Updated ' + change.runner);
      }
      return 0;
    }
    const result = runnerSchema.safeParse(positionals[0]);
    if (!result.success) throw new Error('Unknown runner.');
    const runner = result.data;
    const id = positionals[1]!;
    if (command === 'remove') await removeProviderMethod(runner, id);
    else if (command === 'select') await applyChanges([{ runner, active: id === 'none' ? null : id, methods: [] }], 'cli', io.logins);
    else {
      if ([values['key-stdin'], values['key-env'], values['key-file']].filter(v => v !== undefined).length > 1) throw new Error('Choose one key source.');
      const doc = providersFileSchema.safeParse({ version: 1, agents: { [runner]: {
        ...(values.active ? { active: id } : {}), methods: { [id]: {
          label: values.label, baseUrl: values['base-url'], apiKeyEnv: values['key-env'], apiKeyFile: values['key-file'],
          ...(values['key-stdin'] ? { apiKey: (await io.stdin()).replace(/\r?\n$/, '') } : {}),
        } },
      } } });
      if (!doc.success) throw new Error('Invalid method settings.');
      const keyEnv = doc.data.agents[runner]?.methods?.[id]?.apiKeyEnv;
      const { fetches } = await importMethods(doc.data, 'cli', io.logins, keyEnv ? [keyEnv] : []);
      if (!values['no-fetch']) await fetchAppliedProviders(fetches, io.error);
    }
    io.log('Updated ' + runner + '/' + id);
    return 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : 'Provider configuration failed.');
    return 1;
  }
}
