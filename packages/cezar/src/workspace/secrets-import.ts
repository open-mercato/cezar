import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  SECRET_BINDING_SCHEMES, secretBindingSchema, secretNameIssue, secretValueIssue,
  type SecretBinding,
} from '@open-mercato/cezar-contract';
import { SecretStore, SecretsError, type SecretScopeRef } from './secrets.ts';

export const IMPORT_USAGE = 'Usage: cezar secrets import-sandcastle [--dir <path>] [--workspace] [--repo <dir>] [--bind NAME=host1,host2:header:scheme[:SENTINEL]]... [--replace] [--allow-file-key] [--apply]\n' +
  '  Copies the credential-proxy store of run-pi-in-colima (default $RPI_PROXY_STORE_DIR or ~/.sandcastle-secrets) into Cezar proxy secrets. Dry run unless --apply; the source is only read.\n' +
  '  A provider key is bound to its providers.json upstream host (Authorization: bearer). A forwards.env entry has no recorded destination and needs --bind.';

export interface ImportArgs {
  dir?: string;
  workspace: boolean;
  repo?: string;
  apply: boolean;
  replace: boolean;
  allowFileKey: boolean;
  binds: Map<string, SecretBinding>;
}

export interface ImportIo { log: (line: string) => void; error: (line: string) => void }

export function parseImportArgs(args: string[]): ImportArgs | string {
  const parsed: ImportArgs = { workspace: false, apply: false, replace: false, allowFileKey: false, binds: new Map() };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--workspace') parsed.workspace = true;
    else if (flag === '--apply') parsed.apply = true;
    else if (flag === '--replace') parsed.replace = true;
    else if (flag === '--allow-file-key') parsed.allowFileKey = true;
    else if (flag === '--dir' || flag === '--repo' || flag === '--bind') {
      const value = args[++i];
      if (!value) return IMPORT_USAGE;
      if (flag === '--dir') parsed.dir = value;
      else if (flag === '--repo') parsed.repo = value;
      else {
        const bound = parseBind(value);
        if (typeof bound === 'string') return bound;
        parsed.binds.set(bound.name, bound.binding);
      }
    } else return IMPORT_USAGE;
  }
  return parsed;
}

function parseBind(spec: string): { name: string; binding: SecretBinding } | string {
  const eq = spec.indexOf('=');
  const parts = (eq < 0 ? [] : spec.slice(eq + 1).split(':'));
  const [hosts, header, scheme, sentinel] = parts;
  if (eq < 1 || parts.length < 3 || parts.length > 4 || !hosts || !header || !(SECRET_BINDING_SCHEMES as readonly string[]).includes(scheme ?? '')) {
    return `--bind ${spec.slice(0, Math.max(eq, 0)) || '…'}: expected NAME=host1,host2:header:${SECRET_BINDING_SCHEMES.join('|')}[:SENTINEL]`;
  }
  const parsed = secretBindingSchema.safeParse({
    hosts: [...new Set(hosts.split(',').map((h) => h.trim()).filter(Boolean))].sort(), header, scheme, ...(sentinel ? { sentinel } : {}),
  });
  if (!parsed.success) return `--bind ${spec.slice(0, eq)}: ${parsed.error.issues[0]?.message ?? 'invalid binding'}`;
  return { name: spec.slice(0, eq), binding: parsed.data };
}

type EnvFile = { values: Map<string, string> } | { problem: string };

async function readEnvFile(path: string, label: string, required: boolean): Promise<EnvFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !required) return { values: new Map() };
    return { problem: `cannot read ${label}` };
  }
  const values = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) return { problem: `${label} line ${index + 1} is not NAME=value` };
    const rest = match[2]!;
    const quoted = /^(['"])(.*)\1$/.exec(rest);
    values.set(match[1]!, quoted ? quoted[2]! : rest);
  }
  return { values };
}

interface Candidate { name: string; binding?: SecretBinding; value?: string; origin: string; problem?: string; skip?: string }

async function readProviders(dir: string): Promise<Candidate[] | string> {
  let doc: unknown;
  try {
    doc = JSON.parse(await readFile(join(dir, 'providers.json'), 'utf8'));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? `no providers.json in ${dir} — is this a credential-proxy store? (--dir)`
      : 'cannot read providers.json (unreadable or not JSON)';
  }
  const providers = (doc as { providers?: Record<string, { upstream?: unknown; apiKeyEnv?: unknown; local?: unknown }> } | null)?.providers;
  if (!providers || typeof providers !== 'object') return 'providers.json has no providers object';
  const keys = await readEnvFile(join(dir, 'provider-keys.env'), 'provider-keys.env', false);
  if ('problem' in keys) return keys.problem;
  const byName = new Map<string, Candidate>();
  for (const [provider, entry] of Object.entries(providers)) {
    if (typeof entry?.apiKeyEnv !== 'string' || entry.apiKeyEnv === '') continue;
    const name = entry.apiKeyEnv;
    const origin = `provider ${provider}`;
    if (entry.local === true) { byName.set(`${name}\0${provider}`, { name, origin, skip: 'local provider, no credential leaves the machine' }); continue; }
    let host = '';
    try { host = new URL(String(entry.upstream)).hostname.toLowerCase(); } catch { /* reported below */ }
    const previous = byName.get(name);
    if (previous?.binding && host && !previous.binding.hosts.includes(host)) {
      previous.binding = secretBindingSchema.parse({ ...previous.binding, hosts: [...previous.binding.hosts, host].sort() });
      previous.origin += `, ${provider}`;
      continue;
    }
    const binding = secretBindingSchema.safeParse({ hosts: [host], header: 'Authorization', scheme: 'bearer', sentinel: name });
    byName.set(name, {
      name, origin, value: keys.values.get(name),
      ...(binding.success ? { binding: binding.data } : { problem: `${origin}: upstream is not an https hostname the proxy can bind (${binding.error.issues[0]?.message ?? 'invalid'})` }),
      ...(keys.values.has(name) ? {} : { problem: `${origin}: ${name} has no value in provider-keys.env` }),
    });
  }
  return [...byName.values()];
}

async function readForwards(dir: string, binds: Map<string, SecretBinding>, taken: Set<string>): Promise<Candidate[] | string> {
  const forwards = await readEnvFile(join(dir, 'forwards.env'), 'forwards.env', false);
  if ('problem' in forwards) return forwards.problem;
  const out: Candidate[] = [];
  for (const [name, value] of forwards.values) {
    if (taken.has(name)) { out.push({ name, origin: 'forwards.env', skip: 'already imported as a provider key' }); continue; }
    const binding = binds.get(name);
    if (!binding) { out.push({ name, origin: 'forwards.env', skip: `needs a binding: add --bind ${name}=host1,host2:header:scheme` }); continue; }
    out.push({ name, origin: 'forwards.env', value, binding: { ...binding, sentinel: binding.sentinel ?? name } });
  }
  for (const name of binds.keys()) {
    if (!forwards.values.has(name)) out.push({ name, origin: '--bind', problem: `--bind ${name} matches no forwards.env entry` });
  }
  return out;
}

function issueOf(c: Candidate): string | undefined {
  if (c.problem) return c.problem;
  if (c.skip) return undefined;
  const nameIssue = secretNameIssue(c.name);
  if (nameIssue) return `${c.origin}: ${nameIssue}`;
  const valueIssue = c.value === undefined ? undefined : secretValueIssue(c.value);
  return valueIssue ? `${c.origin}: the value is refused (${valueIssue})` : undefined;
}

const describe = (binding: SecretBinding) => `${binding.hosts.join(',')} ${binding.header} ${binding.scheme}`;

export async function runImportSandcastle(
  args: string[],
  io: ImportIo,
  env: NodeJS.ProcessEnv,
  store: SecretStore,
  scopeFor: (workspace: boolean, repo?: string) => Promise<SecretScopeRef | undefined>,
): Promise<number> {
  const parsed = parseImportArgs(args);
  if (typeof parsed === 'string') { io.error(parsed.startsWith('Usage') ? parsed : `cezar secrets: ${parsed}\n${IMPORT_USAGE}`); return 1; }
  const dir = resolve(parsed.dir ?? env.RPI_PROXY_STORE_DIR ?? join(env.HOME ?? homedir(), '.sandcastle-secrets'));
  const scope = await scopeFor(parsed.workspace, parsed.repo);
  if (!scope) { io.error('cezar secrets: this folder is not a registered cezar project — open it in cezar once, then retry (or pass --workspace).'); return 1; }
  const providers = await readProviders(dir);
  if (typeof providers === 'string') { io.error(`cezar secrets: ${providers}`); return 1; }
  const forwards = await readForwards(dir, parsed.binds, new Set(providers.filter((c) => !c.skip).map((c) => c.name)));
  if (typeof forwards === 'string') { io.error(`cezar secrets: ${forwards}`); return 1; }

  let existing: Set<string>;
  try { existing = new Set((await store.list(scope)).secrets.map((s) => s.name)); } catch { io.error('cezar secrets: cannot access the secret store — check local storage permissions.'); return 1; }
  const todo: Candidate[] = [];
  let problems = 0;
  for (const c of [...providers, ...forwards]) {
    const issue = issueOf(c)
    if (issue) { problems++; io.log(`error\t${c.name}\t${issue}`); continue; }
    if (c.skip) { io.log(`skip\t${c.name}\t${c.origin}: ${c.skip}`); continue; }
    if (existing.has(c.name) && !parsed.replace) { io.log(`skip\t${c.name}\talready stored; --replace overwrites it`); continue; }
    todo.push(c);
    io.log(`${parsed.apply ? 'import' : 'would import'}\t${c.name}\t${describe(c.binding!)}${existing.has(c.name) ? '\t(replaces)' : ''}`);
  }
  const fileKey = (await store.keyBackend()) === 'file';
  if (problems > 0) { io.error(`cezar secrets: ${problems} entr${problems === 1 ? 'y' : 'ies'} cannot be imported — nothing was written.`); return 1; }
  if (fileKey && parsed.apply && !parsed.allowFileKey) {
    io.error('cezar secrets: the data key is a private file, not the OS keychain — the Vito launcher cannot use proxy secrets under it. Nothing was written; pass --allow-file-key to import anyway.');
    return 1;
  }
  if (!parsed.apply) {
    io.error(`# dry run: ${todo.length} to import, nothing written; pass --apply${fileKey ? ' (and --allow-file-key: the data key is a file, not the OS keychain)' : ''}`);
    return 0;
  }
  try {
    for (const c of todo) await store.set(scope, c.name, c.value!, ['proxy'], c.binding);
  } catch (error) {
    io.error(error instanceof SecretsError ? `cezar secrets: ${error.message}` : 'cezar secrets: cannot access the secret store — check local storage permissions; re-run to finish.');
    return 1;
  }
  io.error(`# imported ${todo.length}; ${fileKey ? 'the data key is a file, so the Vito launcher will refuse these until an OS keychain is used' : 'source left untouched'}`);
  return 0;
}
