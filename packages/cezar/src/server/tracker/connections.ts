import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { z } from 'zod';
import { renameWithRetry } from '../../fs-rename.ts';
import { trackerCredentialsSchema, type TrackerCredentials, type TrackerKind } from '@open-mercato/cezar-contract';
import { cezarHomeDir, assertCezarHomeWriteIsSandboxed } from '../../paths.ts';
import { connectionRecordSchema, decodeConnectionEnv, type StoredTrackerConnection } from './connection-env.ts';
import { SecretStore, SecretsError, type SecretStoreOptions } from '../../workspace/secrets.ts';
export type { StoredTrackerConnection } from './connection-env.ts';

// Spec 2026-11-18-shared-tracker-connections. A shared record holds credentials any project may
// explicitly pick; the picking project stores a link (its own revision id) instead of credentials.
const sharedRecordSchema = z.object({ id: z.uuid(), credentials: trackerCredentialsSchema, createdAt: z.iso.datetime() }).strict();
type SharedRecord = z.infer<typeof sharedRecordSchema>;
const linkRecordSchema = z.object({ id: z.uuid(), projectRoot: z.string().min(1), sharedId: z.uuid() }).strict();
type LinkRecord = z.infer<typeof linkRecordSchema>;
type ProjectEntry = StoredTrackerConnection | LinkRecord;
const isLink = (entry: ProjectEntry): entry is LinkRecord => 'sharedId' in entry;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SHARED_FILE = new RegExp(`^shared-(${UUID})\\.vault$`);
const SHARED_ID = new RegExp(`^shared-(${UUID})$`);
const SHARED_MISSING = 'The shared connection this project used was removed. Pick another shared connection or save credentials.';
const SHARED_INVALID = 'Cannot read the shared connection this project uses. Pick another one, or remove it with cez tracker-connections list/remove.';
export interface SharedConnectionSummary { id: string; kind: TrackerKind; credentials: { origin?: string; email?: string }; createdAt: string }
export type ConnectionOutcome = { record: StoredTrackerConnection } | { error: string | null };
export interface ConnectionInspection { record: StoredTrackerConnection | null; shared?: true; sharedId?: string; error?: string }

/** Encrypted managed records; legacy dotenv migrates under the same mutation lock. Not an OS-user/sandbox boundary. */
/** Recovery needs every ciphertext under a lost key gone before a new key may exist (secrets.ts). */
const KEY_UNAVAILABLE = 'The secrets data key is unavailable. Unlock the OS keychain or restore ~/.cezar/secrets. If the key is lost, remove every tracker connection (cez tracker-connections list/remove) and unset the unreadable secrets (cezar secrets list/unset), then save again.';
/** The reader's bound; a write that would exceed it is refused before anything is replaced. */
const MAX_RECORD_BYTES = 32_768;

export class TrackerConnections {
  private readonly directory: string;
  private readonly demo: boolean;
  private readonly vault: SecretStore;
  constructor(env: NodeJS.ProcessEnv = process.env, options: SecretStoreOptions = {}) {
    this.vault = new SecretStore(env, options);
    this.demo = env.CEZ_DRY_RUN === '1';
    this.directory = join(cezarHomeDir(env), 'tracker-connections');
  }
  private id(root: string): string { return createHash('sha256').update(root).digest('hex'); }
  private async checkDirectory(): Promise<void> {
    const directory = await fs.lstat(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (process.platform !== 'win32' && (directory.mode & 0o077) !== 0)) throw new Error('Invalid credential directory');
  }
  private async prepare(path: string): Promise<void> {
    assertCezarHomeWriteIsSandboxed(path);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.checkDirectory();
    // This directory is entirely managed private state, including locks and temporary files.
    // Atomic replacement also avoids following an existing .gitignore symlink.
    await this.save(join(this.directory, '.gitignore'), '# Managed private tracker credentials; never commit this directory.\n*\n');
  }
  private async readFile(path: string): Promise<string> {
    const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_RECORD_BYTES || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error('Invalid credential file');
      // Bound the actual read, too: the file can grow after fstat.
      const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > MAX_RECORD_BYTES) throw new Error('Invalid credential file');
      return buffer.subarray(0, offset).toString('utf8');
    } finally { await file.close(); }
  }
  private async save(path: string, text: string): Promise<void> {
    const temporary = path + '.' + randomUUID() + '.tmp';
    try {
      const file = await fs.open(temporary, 'wx', 0o600);
      try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
      await renameWithRetry(temporary, path);
      if (process.platform !== 'win32') {
        const directory = await fs.open(this.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  private async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    await this.prepare(this.directory);
    const lock = join(this.directory, id + '.lock');
    // Atomic mkdir serializes cockpit/CLI mutations. Never steal from a live owner.
    for (let attempt = 0; ; attempt++) {
      try { await fs.mkdir(lock, { mode: 0o700 }); await fs.writeFile(join(lock, String(process.pid)), '', { flag: 'wx', mode: 0o600 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 100) throw error;
        const age = await fs.lstat(lock).catch(() => null);
        if (!age) continue;
        const owners = await fs.readdir(lock).catch(() => []);
        if (owners.length === 1 && /^[1-9][0-9]*$/.test(owners[0]!)) {
          try { process.kill(Number(owners[0]), 0); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
              // Exclusive unlink elects one reaper. Other contenders may not remove a
              // replacement owner's directory.
              try { await fs.unlink(join(lock, owners[0]!)); await fs.rmdir(lock); } catch {}
            }
          }
        } else if (owners.length === 0 && Date.now() - age.mtimeMs > 60_000) {
          await fs.rmdir(lock).catch(() => {});
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    try { return await action(); } finally { await fs.unlink(join(lock, String(process.pid))); await fs.rmdir(lock); }
  }
  private validateOwner<T extends ProjectEntry>(id: string, record: T): T {
    if (!isAbsolute(record.projectRoot) || this.id(record.projectRoot) !== id) throw new Error('Invalid credential owner');
    return record;
  }
  private async readEncrypted(id: string): Promise<ProjectEntry> {
    const text = await this.readFile(join(this.directory, id + '.vault'));
    const value: unknown = JSON.parse(await this.vault.openManaged('tracker', id, text));
    const link = linkRecordSchema.safeParse(value);
    return this.validateOwner(id, link.success ? link.data : connectionRecordSchema.parse(value));
  }
  private async saveEncrypted(id: string, record: StoredTrackerConnection): Promise<void> {
    const text = await this.sealWithinBound(id, record);
    const verified = connectionRecordSchema.parse(JSON.parse(await this.vault.openManaged('tracker', id, text)));
    if (JSON.stringify(verified) !== JSON.stringify(record)) throw new Error('Credential verification failed');
    await this.save(join(this.directory, id + '.vault'), text);
    await this.readEncrypted(id);
    // Retain this non-secret format marker even on removal: an old writer must not
    // resurrect plaintext after encrypted storage became authoritative.
    await this.save(join(this.directory, id + '.migrated'), '1\n');
  }
  private async sealWithinBound(id: string, record: ProjectEntry): Promise<string> {
    const text = await this.vault.sealManaged('tracker', id, JSON.stringify(record));
    if (Buffer.byteLength(text, 'utf8') > MAX_RECORD_BYTES) throw new Error('Credentials are too large to store');
    return text;
  }
  private sharedPath(sharedId: string): string { return join(this.directory, `shared-${sharedId}.vault`); }
  private async readShared(sharedId: string): Promise<SharedRecord> {
    const text = await this.readFile(this.sharedPath(sharedId));
    // Own AAD namespace: a renamed project ciphertext never opens as a shared record.
    const record = sharedRecordSchema.parse(JSON.parse(await this.vault.openManaged('tracker-shared', sharedId, text)));
    if (record.id !== sharedId) throw new Error('Invalid shared credential owner');
    return record;
  }
  /** A fresh shared record; never overwrites one (UUID collision or retried promote). */
  private async createShared(credentials: TrackerCredentials): Promise<SharedRecord> {
    const record = sharedRecordSchema.parse({ id: randomUUID(), credentials, createdAt: new Date().toISOString() });
    const text = await this.vault.sealManaged('tracker-shared', record.id, JSON.stringify(record));
    if (Buffer.byteLength(text, 'utf8') > MAX_RECORD_BYTES) throw new Error('Credentials are too large to store');
    if (await this.vault.openManaged('tracker-shared', record.id, text) !== JSON.stringify(record)) throw new Error('Credential verification failed');
    await this.prepare(this.directory);
    const exists = await fs.lstat(this.sharedPath(record.id)).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return false; });
    if (exists) throw new Error('Shared connection already exists');
    await this.save(this.sharedPath(record.id), text);
    return record;
  }
  private async readId(id: string): Promise<ProjectEntry> {
    // Ordinary encrypted reads require no writes, so a read-only home remains usable.
    try {
      await fs.lstat(join(this.directory, id + '.env'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return this.readEncrypted(id);
    }
    try { return await this.locked(id, () => this.readAndMigrate(id)); }
    catch (error) {
      // A read-only home or a locked data key degrades to reading without migrating (AGENTS.md
      // § Zero config); an existing ciphertext still never falls back to plaintext.
      if (!(error instanceof SecretsError) && !['EROFS', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      return this.readAndMigrate(id, false);
    }
  }
  private async readAndMigrate(id: string, persist = true): Promise<ProjectEntry> {
    let encrypted: ProjectEntry | undefined;
    // Only an absent ciphertext permits migration. A damaged/locked store never falls back.
    try { encrypted = await this.readEncrypted(id); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    let legacy: StoredTrackerConnection | undefined;
    try { legacy = this.validateOwner(id, decodeConnectionEnv(await this.readFile(join(this.directory, id + '.env')))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (encrypted && legacy && JSON.stringify(encrypted) !== JSON.stringify(legacy)) {
      throw new Error('Conflicting credential versions. Stop older cezar processes and save the connection again.');
    }
    if (!encrypted) {
      try { await fs.lstat(join(this.directory, id + '.migrated')); throw new Error('Encrypted credentials were removed; an old plaintext writer cannot restore them. Re-save in Settings.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const record = encrypted ?? legacy;
    if (!record) throw Object.assign(new Error('No credentials'), { code: 'ENOENT' });
    if (!persist) return record;
    if (!encrypted && legacy) await this.saveEncrypted(id, legacy);
    if (legacy && encrypted) await this.save(join(this.directory, id + '.migrated'), '1\n');
    if (legacy) await fs.unlink(join(this.directory, id + '.env'));
    return record;
  }

  async inspect(root: string): Promise<ConnectionInspection> {
    if (this.demo) return { record: null };
    try {
      const canonical = await fs.realpath(root);
      await this.checkDirectory();
      const entry = await this.readId(this.id(canonical));
      if (!isLink(entry)) return { record: entry };
      let shared: SharedRecord;
      try { shared = await this.readShared(entry.sharedId); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { record: null, error: SHARED_MISSING };
        // The key just opened the link, so this is a damaged/renamed record, not a lost key.
        return { record: null, error: SHARED_INVALID };
      }
      // The link's own revision, not the shared id: re-linking later must not revive old bindings.
      return { record: { id: entry.id, projectRoot: entry.projectRoot, credentials: shared.credentials }, shared: true, sharedId: shared.id };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { record: null };
      if (error instanceof SecretsError) return { record: null, error: KEY_UNAVAILABLE };
      return { record: null, error: 'Cannot read project credentials. Re-save in Settings or use cez tracker-connections list/remove for local cleanup.' };
    }
  }
  async read(root: string): Promise<StoredTrackerConnection | null> {
    return (await this.inspect(root)).record;
  }
  async write(root: string, credentials: TrackerCredentials): Promise<StoredTrackerConnection | null> {
    const outcome = await this.saveCredentials(root, credentials);
    return 'record' in outcome ? outcome.record : null;
  }
  /**
   * `error` names a reason worth showing; `null` is the generic storage failure.
   * `shared: true` stores the credentials as a new shared record and links this project to it.
   */
  async saveCredentials(root: string, credentials: TrackerCredentials, options: { shared?: boolean } = {}): Promise<ConnectionOutcome> {
    if (this.demo) return { error: null };
    let created: SharedRecord | undefined;
    try {
      const projectRoot = await fs.realpath(root);
      const record = connectionRecordSchema.parse({ id: randomUUID(), projectRoot, credentials });
      if (Object.values(record.credentials).some(value => /[\x00-\x1f\x7f]/.test(value))) throw new Error('Invalid credential characters');
      if (!options.shared) return await this.commit(record, record);
      // Shared record first, outside the project lock; a failed link leaves no orphan behind.
      created = await this.createShared(record.credentials);
      return await this.withShared(created, this.commit({ id: record.id, projectRoot, sharedId: created.id }, record));
    } catch (error) {
      if (created) await this.discardShared(created.id);
      return { error: error instanceof SecretsError ? error.message : null };
    }
  }
  /** Explicit consent: this project uses shared record `sharedId`, replacing its own entry. */
  async link(root: string, sharedId: string): Promise<ConnectionOutcome | { missing: true }> {
    if (this.demo) return { error: null };
    try {
      const projectRoot = await fs.realpath(root);
      if (!z.uuid().safeParse(sharedId).success) return { missing: true };
      let shared: SharedRecord;
      try { shared = await this.readShared(sharedId); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true };
        // A renamed/forged record or a storage failure: refuse, but do not claim it is gone.
        return { error: error instanceof SecretsError && /data key unavailable/.test(error.message) ? error.message : null };
      }
      // Picking the connection already in use keeps its revision, so a retry never disconnects the scope.
      const current = await this.readEncrypted(this.id(projectRoot)).catch(() => null);
      if (current && isLink(current) && current.sharedId === shared.id) {
        return { record: { id: current.id, projectRoot, credentials: shared.credentials } };
      }
      const id = randomUUID();
      return await this.commit({ id, projectRoot, sharedId: shared.id }, { id, projectRoot, credentials: shared.credentials });
    } catch (error) {
      return { error: error instanceof SecretsError ? error.message : null };
    }
  }
  /** Moves this project's own credentials into a new shared record; its revision id is kept. */
  async promote(root: string): Promise<ConnectionOutcome> {
    if (this.demo) return { error: null };
    let created: SharedRecord | undefined;
    try {
      const projectRoot = await fs.realpath(root);
      const id = this.id(projectRoot);
      await this.checkDirectory();
      const entry = await this.readId(id);
      if (isLink(entry)) return { error: 'This project already uses a shared connection.' };
      created = await this.createShared(entry.credentials);
      // The link keeps the record's revision, so saved scopes and automations stay connected.
      return await this.withShared(created, this.commit({ id: entry.id, projectRoot, sharedId: created.id }, entry, current =>
        isLink(current) || JSON.stringify(current) !== JSON.stringify(entry) ? 'These credentials changed while sharing. Reload and try again.' : null));
    } catch (error) {
      if (created) await this.discardShared(created.id);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { error: 'This project has no credentials of its own to share.' };
      return { error: error instanceof SecretsError ? error.message : null };
    }
  }
  /** Removes a new shared record only when its link certainly never reached disk. */
  private async withShared(created: SharedRecord, pending: Promise<ConnectionOutcome & { uncertain?: true }>): Promise<ConnectionOutcome> {
    const outcome = await pending;
    if ('error' in outcome) {
      if (!outcome.uncertain) await this.discardShared(created.id);
      return { error: outcome.error };
    }
    return outcome;
  }
  /** An orphan is recoverable (list/remove); deleting a record some project links to loses credentials. */
  private async discardShared(sharedId: string): Promise<void> {
    const names = await fs.readdir(this.directory).catch(() => [] as string[]);
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.vault$/.test(name)) continue;
      const entry = await this.readEncrypted(name.slice(0, 64)).catch(() => null);
      // Unreadable entries might link to it; keep the record rather than guess.
      if (!entry || (isLink(entry) && entry.sharedId === sharedId)) return;
    }
    await fs.unlink(this.sharedPath(sharedId)).catch(() => {});
  }
  /**
   * Atomically replaces the project's entry (own credentials or link); spec 2026-09-18 § storage.
   * `record` is what the entry resolves to, so nothing is re-read after the rename. `uncertain`
   * marks a failure after which the new entry may be on disk.
   */
  private async commit(entry: ProjectEntry, record: StoredTrackerConnection, refuse?: (current: ProjectEntry) => string | null): Promise<ConnectionOutcome & { uncertain?: true }> {
    let committing = false;
    let refused: string | null = null;
    const id = this.id(entry.projectRoot);
    try {
      await this.locked(id, async () => {
        if (refuse && (refused = refuse(await this.readEncrypted(id)))) return;
        // Finish an old format's migration first, preserving its complete record if
        // the subsequent credential replacement fails. Do not commit a new UUID while
        // a stale plaintext file can still make the connection ambiguous.
        let legacyPresent = false;
        try { await fs.lstat(join(this.directory, id + '.env')); legacyPresent = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (legacyPresent) {
          // A deliberate Settings replacement also resolves an old-writer conflict.
          // Preserve a valid legacy record as ciphertext before removing its plaintext.
          const legacyText = await this.readFile(join(this.directory, id + '.env'));
          let legacy: StoredTrackerConnection | undefined;
          // Explicit replacement may discard malformed content, but never read failures.
          try { legacy = this.validateOwner(id, decodeConnectionEnv(legacyText)); } catch {}
          let existing: ProjectEntry | undefined;
          try { existing = await this.readEncrypted(id); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          const migrated = await fs.lstat(join(this.directory, id + '.migrated')).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return null; });
          if (legacy && !existing && !migrated) await this.saveEncrypted(id, legacy);
          await fs.unlink(join(this.directory, id + '.env'));
        }
        const text = await this.sealWithinBound(id, entry);
        if (await this.vault.openManaged('tracker', id, text) !== JSON.stringify(entry)) throw new Error('Credential verification failed');
        // All housekeeping precedes the atomic credential commit.
        await this.save(join(this.directory, id + '.migrated'), '1\n');
        committing = true;
        await this.save(join(this.directory, id + '.vault'), text);
      });
      return refused ? { error: refused } : { record };
    } catch (error) {
      // A failure after the rename (directory fsync, lock cleanup) must not report a replacement
      // that is already on disk as failed: the new UUID has invalidated the old bindings. Compare
      // the whole entry: a promoted link keeps the id of the record it replaces.
      const failed = { error: error instanceof SecretsError ? error.message : null };
      if (!committing) return failed;
      const persisted = await this.readEncrypted(id).then(value => JSON.stringify(value), (error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : undefined);
      if (persisted === JSON.stringify(entry)) return { record };
      return persisted === undefined ? { ...failed, uncertain: true } : failed;
    }
  }
  async remove(root: string): Promise<boolean> {
    if (this.demo) return false;
    try { await this.removeId(this.id(await fs.realpath(root))); return true; }
    catch { return false; }
  }
  /** Metadata only, for the picker: never a token. Unreadable records are omitted. */
  async listShared(): Promise<SharedConnectionSummary[]> {
    if (this.demo) return [];
    try { await this.checkDirectory(); } catch { return []; }
    const names = await fs.readdir(this.directory).catch(() => [] as string[]);
    const records = await Promise.all(names.map(name => SHARED_FILE.exec(name)?.[1]).filter((id): id is string => !!id)
      .map(id => this.readShared(id).catch(() => null)));
    return records.filter((record): record is SharedRecord => !!record)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map(record => ({
        id: record.id, kind: record.credentials.kind, createdAt: record.createdAt,
        credentials: record.credentials.kind === 'jira' ? { origin: record.credentials.origin, email: record.credentials.email } : {},
      }));
  }
  async inventory(): Promise<Array<{ id: string; root: string | null; provider: string | null; status: 'valid' | 'invalid'; shared?: string; links?: number }>> {
    if (this.demo) return [];
    try { await this.checkDirectory(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new Error('Cannot read tracker credential storage.'); }
    try {
      const entries = await fs.readdir(this.directory);
      const projects = await Promise.all([...new Set(entries.filter(name => /^[a-f0-9]{64}\.(env|vault)$/.test(name)).map(name => name.split('.')[0]!))].sort().map(async id => {
        try {
          const entry = await this.readId(id);
          if (!isLink(entry)) return { id, root: entry.projectRoot, provider: entry.credentials.kind, status: 'valid' as const };
          // A link reads valid only when it resolves, so `status != valid` cleanup never drops a working one.
          const shared = await this.readShared(entry.sharedId).catch(() => null);
          return { id, root: entry.projectRoot, provider: shared?.credentials.kind ?? null, status: shared ? 'valid' as const : 'invalid' as const, shared: `shared-${entry.sharedId}` };
        } catch { return { id, root: null, provider: null, status: 'invalid' as const }; }
      }));
      const shared = await Promise.all(entries.map(name => SHARED_FILE.exec(name)?.[1]).filter((id): id is string => !!id).sort().map(async sharedId => {
        const record = await this.readShared(sharedId).catch(() => null);
        const links = projects.filter(project => project.shared === `shared-${sharedId}`).length;
        return { id: `shared-${sharedId}`, root: null, provider: record?.credentials.kind ?? null, status: record ? 'valid' as const : 'invalid' as const, links };
      }));
      return [...projects, ...shared];
    } catch { throw new Error('Cannot read tracker credential storage.'); }
  }
  async removeId(id: string): Promise<void> {
    const sharedId = SHARED_ID.exec(id)?.[1];
    if (!sharedId && !/^[a-f0-9]{64}$/.test(id)) throw new Error('Expected a 64-character lowercase hexadecimal connection ID or shared-<uuid>.');
    if (this.demo) return;
    try {
      await this.checkDirectory();
      if (sharedId) {
        // No tombstone: shared records never had a plaintext format. Links then read as removed.
        await this.locked(id, () => fs.unlink(this.sharedPath(sharedId)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        }));
        return;
      }
      await this.locked(id, async () => {
        const encrypted = await fs.lstat(join(this.directory, id + '.vault')).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        });
        // Interrupted migration may have committed ciphertext without its marker.
        // Persist the tombstone before deleting either version, even if unreadable.
        if (encrypted) await this.save(join(this.directory, id + '.migrated'), '1\n');
        for (const suffix of ['.env', '.vault']) await fs.unlink(join(this.directory, id + suffix)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot remove tracker credentials. Check local storage permissions.');
    }
  }
}
