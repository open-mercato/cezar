import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs, constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  SECRET_AUDIENCES,
  secretAudienceSchema,
  secretNameIssue,
  secretValueIssue,
  type SecretAudience,
  type SecretEntry,
  type SecretKeyBackend,
  type StepSecretBinding,
} from '@open-mercato/cezar-contract';
import { assertCezarHomeWriteIsSandboxed, cezarHomeDir } from '../paths.ts';
import { PROJECT_ID_RE } from './config.ts';
import { osKeychain, type DataKeyring } from './secret-keyring.ts';

/**
 * Project and workspace secrets (spec `2026-10-10-project-secrets-vault-options`).
 *
 * One JSON file per scope holder under `~/.cezar/secrets/`: `<projectId>.json` for a project,
 * `workspace.json` for the user's whole workspace. The file carries every secret's METADATA in
 * the clear (name, audiences, timestamps) and its VALUE as AES-256-GCM ciphertext under one
 * per-machine data key. The data key lives in the OS keychain when one is usable
 * (`secret-keyring.ts`) and in `~/.cezar/secrets/.key` (`0600`) otherwise — in which case the
 * store is exactly as strong as a private plaintext file, and `keyBackend()` says so.
 *
 * Values never enter `process.env`: a consumer asks `resolve()` for an AUDIENCE and gets only
 * the secrets that admit it. There is no agent audience, so `buildChildEnv`'s prefix matching
 * can never pass one to a backend — the leak the old "export the key before starting cezar"
 * advice caused, which silently switched Claude Code and Codex to API billing.
 *
 * Same write discipline as `TrackerConnections`: a `0700` directory with a `*` `.gitignore`,
 * `0600` files, `O_NOFOLLOW` bounded reads, atomic tmp/rename writes, a cross-process mkdir
 * lock for read-modify-write, and `assertCezarHomeWriteIsSandboxed`. Not an OS-user boundary.
 *
 * A project slug can be handed to another repository after the first is removed from the
 * registry, so a project file records the root it belongs to; a file whose recorded root is not
 * the asking project's reads as empty instead of handing one repo's keys to another.
 */

/** A file larger than this is not one this store wrote. Bounded read, like the tracker store. */
const FILE_MAX_BYTES = 1024 * 1024;
const CIPHER = 'aes-256-gcm';
const FILE_VERSION = 1;
const KEY_FILE = '.key';
const DEFAULT_AUDIENCES: readonly SecretAudience[] = ['checks'];

export class SecretsError extends Error {}

/** Which file a call addresses. A project's identity is its slug AND its root (see above). */
export type SecretScopeRef = { kind: 'project'; projectId: string; root: string } | { kind: 'workspace' };

const storedSecretSchema = z.object({
  audiences: z.array(secretAudienceSchema).min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  iv: z.string(),
  data: z.string(),
  tag: z.string(),
});
type StoredSecret = z.infer<typeof storedSecretSchema>;

const secretFileSchema = z.object({
  version: z.literal(FILE_VERSION),
  root: z.string().optional(),
  secrets: z.record(z.string(), storedSecretSchema),
});
type SecretFile = z.infer<typeof secretFileSchema>;

/**
 * A read of one scope's store. `skipped` is set only when a store the user DID write could not
 * be used — bad modes, a symlink, a corrupt file, a recorded root that is not this project's, or
 * a data key that no longer decrypts it. Reading as empty is the right degradation (a corrupt
 * store must never stop runs), but doing it silently left the user no way to tell "I never
 * stored it" from "cezar ignored what I stored": the value is write-only, so there is nothing
 * to inspect and compare. The caller turns this into one note on the run.
 */
export interface SecretsRead {
  values: Record<string, { value: string; audiences: SecretAudience[] }>;
  skipped?: string;
}

/** What a consumer gets back: the variables it may see, and what it should tell the user. */
export interface ResolvedSecrets {
  values: Record<string, string>;
  /** One line each: a skipped store, a bound name that is not stored, a name the audience may not read. */
  notes: string[];
}

export interface SecretStoreOptions {
  /** The OS keychain to keep the data key in. Default: `osKeychain()`; tests inject a fake. */
  keychain?: () => Promise<DataKeyring | null>;
}

export class SecretStore {
  private readonly directory: string;
  private readonly keychain: () => Promise<DataKeyring | null>;
  private dataKey: { key: Buffer; backend: SecretKeyBackend } | undefined;

  constructor(env: NodeJS.ProcessEnv = process.env, options: SecretStoreOptions = {}) {
    this.directory = join(cezarHomeDir(env), 'secrets');
    this.keychain = options.keychain ?? (() => osKeychain(env));
  }

  /**
   * Which backend holds (or would hold) this machine's data key. Never creates one: an
   * existing key file wins, then an existing keychain item, then whatever a first write would
   * pick. The cockpit shows this next to the list so a file fallback is never silent.
   */
  async keyBackend(): Promise<SecretKeyBackend> {
    const found = await this.loadDataKey();
    if (found) return found.backend;
    const keychain = await this.keychain();
    if (!keychain) return 'file';
    try {
      await keychain.get();
      return 'keychain';
    } catch {
      return 'file';
    }
  }

  /** Stored entries, sorted by name. Absent or unreadable storage is an empty list, never a throw. */
  async list(scope: SecretScopeRef): Promise<{ secrets: SecretEntry[]; skipped?: string }> {
    const read = await this.read(scope);
    const secrets = Object.entries(read.values)
      .map(([name, entry]) => ({ name, audiences: entry.audiences, updatedAt: entry.updatedAt }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return read.skipped ? { secrets, skipped: read.skipped } : { secrets };
  }

  /**
   * One scope's secrets, decrypted, read fresh. Resolved once per use, so an edit applies to
   * the next check rather than one already running. Every failure reads as empty: a check
   * without its credential fails on its own terms, and a corrupt store must not stop runs.
   */
  async read(scope: SecretScopeRef): Promise<SecretsRead & { values: Record<string, { value: string; audiences: SecretAudience[]; updatedAt: string }> }> {
    const id = fileId(scope);
    if (!id) return { values: {} };
    let file: SecretFile;
    try {
      await this.checkDirectory();
      file = parseSecretFile(await this.readFile(this.file(id)));
    } catch (error) {
      // No directory and no file are the ordinary "nothing stored" cases and say nothing. Every
      // other failure — a loosened mode, a symlink (`ELOOP` from `O_NOFOLLOW`), an oversized
      // or corrupt file — is a store that exists and was not used.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { values: {} };
      return {
        values: {},
        skipped: error instanceof SecretsError
          ? error.message
          : 'the store is unreadable — check the modes on ~/.cezar/secrets (0700 dir, 0600 file)',
      };
    }
    if (scope.kind === 'project') {
      const owner = await canonicalRoot(scope.root);
      if (file.root !== owner) {
        return { values: {}, skipped: `the store belongs to another project root (${file.root ?? 'none recorded'}), not ${owner}` };
      }
    }
    if (Object.keys(file.secrets).length === 0) return { values: {} };
    const dataKey = await this.loadDataKey();
    if (!dataKey) {
      return { values: {}, skipped: 'the data key is gone — the OS keychain item or ~/.cezar/secrets/.key was removed; store the secrets again' };
    }
    const values: Record<string, { value: string; audiences: SecretAudience[]; updatedAt: string }> = {};
    for (const [name, stored] of Object.entries(file.secrets)) {
      if (secretNameIssue(name)) continue;
      const value = decrypt(dataKey.key, aad(id, name), stored);
      if (value === null) {
        return { values: {}, skipped: 'the data key does not decrypt this store — it was written under another key (a reset keychain, a replaced key file); store the secrets again' };
      }
      values[name] = { value, audiences: stored.audiences, updatedAt: stored.updatedAt };
    }
    return { values };
  }

  async set(scope: SecretScopeRef, name: string, value: string, audiences: readonly SecretAudience[] = DEFAULT_AUDIENCES): Promise<void> {
    const issue = secretNameIssue(name) ?? secretValueIssue(value);
    if (issue) throw new SecretsError(issue);
    const admitted = [...new Set(audiences)].filter((a): a is SecretAudience => (SECRET_AUDIENCES as readonly string[]).includes(a));
    if (admitted.length === 0) throw new SecretsError(`a secret names at least one audience (${SECRET_AUDIENCES.join(', ')})`);
    const dataKey = await this.loadOrCreateDataKey();
    await this.update(scope, (file, id) => {
      const now = new Date().toISOString();
      file.secrets[name] = {
        audiences: admitted,
        createdAt: file.secrets[name]?.createdAt ?? now,
        updatedAt: now,
        ...encrypt(dataKey.key, aad(id, name), value),
      };
      return true;
    });
  }

  /** Remove `name`. `false` when it was not stored — the route answers 404. */
  async unset(scope: SecretScopeRef, name: string): Promise<boolean> {
    return this.update(scope, (file) => {
      if (!(name in file.secrets)) return false;
      delete file.secrets[name];
      return true;
    });
  }

  /**
   * What ONE consumer may see: the secrets of `project` (when given) and of the workspace that
   * admit `audience`, the project's winning on a shared name. With `bindings`, exactly the
   * named secrets — each optionally renamed with `as` — and a line in `notes` for every name
   * that is not stored or that the audience may not read. Nothing stored stays silent only when
   * nothing was asked for: a bound name is a request, and an unmet request is said.
   */
  async resolve(
    project: { projectId: string; root: string } | undefined,
    audience: SecretAudience,
    bindings?: readonly StepSecretBinding[],
  ): Promise<ResolvedSecrets> {
    const notes: string[] = [];
    const sources: Array<{ label: string; read: SecretsRead }> = [{ label: 'workspace', read: await this.read({ kind: 'workspace' }) }];
    if (project) sources.push({ label: 'project', read: await this.read({ kind: 'project', ...project }) });
    for (const source of sources) {
      if (source.read.skipped) notes.push(`${source.label} secrets skipped — ${source.read.skipped}`);
    }
    const lookup = (name: string) => {
      for (const source of [...sources].reverse()) {
        const entry = source.read.values[name];
        if (entry) return entry;
      }
      return undefined;
    };
    const values: Record<string, string> = {};
    if (!bindings) {
      for (const source of sources) {
        for (const [name, entry] of Object.entries(source.read.values)) {
          if (entry.audiences.includes(audience)) values[name] = entry.value;
        }
      }
      return { values, notes };
    }
    for (const binding of bindings) {
      const name = typeof binding === 'string' ? binding : binding.name;
      const as = typeof binding === 'string' ? name : (binding.as ?? name);
      const entry = lookup(name);
      if (!entry) {
        notes.push(`secret ${name} is not stored for this project or workspace`);
        continue;
      }
      if (!entry.audiences.includes(audience)) {
        notes.push(`secret ${name} is not available to ${audience} (audiences: ${entry.audiences.join(', ')})`);
        continue;
      }
      values[as] = entry.value;
    }
    return { values, notes };
  }

  private file(id: string): string {
    return join(this.directory, `${id}.json`);
  }

  private async update(scope: SecretScopeRef, mutate: (file: SecretFile, id: string) => boolean): Promise<boolean> {
    const id = fileId(scope);
    if (!id) throw new SecretsError('invalid project id');
    const owner = scope.kind === 'project' ? await canonicalRoot(scope.root) : undefined;
    await this.prepare();
    return this.locked(id, async () => {
      let file: SecretFile = { version: FILE_VERSION, ...(owner ? { root: owner } : {}), secrets: {} };
      try {
        const existing = parseSecretFile(await this.readFile(this.file(id)));
        // A file left by another root is that root's, and that root is gone from this slug:
        // the first write by the slug's new owner starts it over instead of inheriting it.
        if (existing.root === owner) file = existing;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SecretsError)) throw error;
      }
      if (!mutate(file, id)) return false;
      await this.save(this.file(id), `${JSON.stringify(file, null, 2)}\n`);
      return true;
    });
  }

  /**
   * The data key, from wherever it already is: the key file first (a machine that fell back once
   * keeps its secrets readable even after a keychain appears), then the keychain. `null` when
   * neither has one. Cached for the process: the key is immutable once created.
   */
  private async loadDataKey(): Promise<{ key: Buffer; backend: SecretKeyBackend } | null> {
    if (this.dataKey) return this.dataKey;
    try {
      const key = Buffer.from((await this.readFile(join(this.directory, KEY_FILE))).trim(), 'base64');
      if (key.length === 32) return (this.dataKey = { key, backend: 'file' });
    } catch {
      // No key file, or not one we wrote: look in the keychain.
    }
    const keychain = await this.keychain();
    if (!keychain) return null;
    try {
      const key = await keychain.get();
      if (key) return (this.dataKey = { key, backend: 'keychain' });
    } catch {
      // A locked or unreachable store reads as "no key here"; a first write will try the file.
    }
    return null;
  }

  /** The data key, created under the cross-process lock when this is the machine's first write. */
  private async loadOrCreateDataKey(): Promise<{ key: Buffer; backend: SecretKeyBackend }> {
    const found = await this.loadDataKey();
    if (found) return found;
    await this.prepare();
    return this.locked('key', async () => {
      const raced = await this.loadDataKey();
      if (raced) return raced;
      const key = randomBytes(32);
      const keychain = await this.keychain();
      if (keychain) {
        try {
          await keychain.set(key);
          return (this.dataKey = { key, backend: 'keychain' });
        } catch {
          // The keychain refused the write (locked, denied): the file is the working fallback.
        }
      }
      await this.save(join(this.directory, KEY_FILE), `${key.toString('base64')}\n`);
      return (this.dataKey = { key, backend: 'file' });
    });
  }

  private async checkDirectory(): Promise<void> {
    const directory = await fs.lstat(this.directory);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      (process.platform !== 'win32' && (directory.mode & 0o077) !== 0)
    ) {
      throw new SecretsError('the store directory is unusable — ~/.cezar/secrets must be a 0700 directory, not a symlink');
    }
  }

  private async prepare(): Promise<void> {
    assertCezarHomeWriteIsSandboxed(this.directory);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.checkDirectory();
    await this.save(join(this.directory, '.gitignore'), '# Managed private secrets; never commit this directory.\n*\n');
  }

  private async readFile(path: string): Promise<string> {
    const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > FILE_MAX_BYTES || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
        throw new SecretsError('the store file is unusable — it must be a regular 0600 file');
      }
      // Bound the actual read, too: the file can grow after fstat.
      const buffer = Buffer.alloc(FILE_MAX_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > FILE_MAX_BYTES) throw new SecretsError('the store file is unusable — it is larger than this store ever writes');
      return buffer.subarray(0, offset).toString('utf8');
    } finally {
      await file.close();
    }
  }

  private async save(path: string, text: string): Promise<void> {
    assertCezarHomeWriteIsSandboxed(path);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, path);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }

  /** Atomic mkdir serializes cockpit/CLI read-modify-writes. Never steal from a live owner. */
  private async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    const lock = join(this.directory, `${id}.lock`);
    const owner = join(lock, String(process.pid));
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.mkdir(lock, { mode: 0o700 });
        await fs.writeFile(owner, '', { flag: 'wx', mode: 0o600 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 200) throw error;
        const age = await fs.lstat(lock).catch(() => null);
        if (!age) continue;
        const owners = await fs.readdir(lock).catch(() => []);
        if (owners.length === 1 && /^[1-9][0-9]*$/.test(owners[0]!)) {
          try {
            process.kill(Number(owners[0]), 0);
          } catch (killError) {
            if ((killError as NodeJS.ErrnoException).code === 'ESRCH') {
              // Exclusive unlink elects one reaper.
              try {
                await fs.unlink(join(lock, owners[0]!));
                await fs.rmdir(lock);
              } catch {}
            }
          }
        } else if (owners.length === 0 && Date.now() - age.mtimeMs > 60_000) {
          await fs.rmdir(lock).catch(() => {});
        }
        await new Promise((done) => setTimeout(done, 10));
      }
    }
    try {
      return await action();
    } finally {
      await fs.unlink(owner).catch(() => {});
      await fs.rmdir(lock).catch(() => {});
    }
  }
}

/** The file a scope lives in, or `undefined` for a project id that is not a slug (never a path). */
function fileId(scope: SecretScopeRef): string | undefined {
  if (scope.kind === 'workspace') return 'workspace';
  return PROJECT_ID_RE.test(scope.projectId) && scope.projectId !== 'workspace' ? scope.projectId : undefined;
}

/** Binds a ciphertext to its slot: a value moved between files or names does not decrypt. */
function aad(fileId: string, name: string): Buffer {
  return Buffer.from(`cezar-secret\0${fileId}\0${name}`, 'utf8');
}

function encrypt(key: Buffer, associated: Buffer, value: string): Pick<StoredSecret, 'iv' | 'data' | 'tag'> {
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, key, iv);
  cipher.setAAD(associated);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), data: data.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

/** `null` when the key or the slot does not match — a wrong key fails the tag, never garbles. */
function decrypt(key: Buffer, associated: Buffer, stored: Pick<StoredSecret, 'iv' | 'data' | 'tag'>): string | null {
  try {
    const decipher = createDecipheriv(CIPHER, key, Buffer.from(stored.iv, 'base64'));
    decipher.setAAD(associated);
    decipher.setAuthTag(Buffer.from(stored.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(stored.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** A file this store would never write — unknown shape, unknown version — is refused, not trusted. */
export function parseSecretFile(text: string): SecretFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SecretsError('the store file is corrupt — not JSON');
  }
  const parsed = secretFileSchema.safeParse(json);
  if (!parsed.success) throw new SecretsError('the store file is corrupt — not a shape this cezar writes');
  return parsed.data;
}

async function canonicalRoot(root: string): Promise<string> {
  try {
    return await fs.realpath(root);
  } catch {
    return resolve(root);
  }
}
