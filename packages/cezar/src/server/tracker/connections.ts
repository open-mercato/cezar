import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { renameWithRetry } from '../../fs-rename.ts';
import type { TrackerCredentials } from '@open-mercato/cezar-contract';
import { cezarHomeDir, assertCezarHomeWriteIsSandboxed } from '../../paths.ts';
import { connectionRecordSchema, decodeConnectionEnv, type StoredTrackerConnection } from './connection-env.ts';
import { SecretStore, SecretsError, type SecretStoreOptions } from '../../workspace/secrets.ts';
export type { StoredTrackerConnection } from './connection-env.ts';

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
  private validateOwner(id: string, record: StoredTrackerConnection): StoredTrackerConnection {
    if (!isAbsolute(record.projectRoot) || this.id(record.projectRoot) !== id) throw new Error('Invalid credential owner');
    return record;
  }
  private async readEncrypted(id: string): Promise<StoredTrackerConnection> {
    const text = await this.readFile(join(this.directory, id + '.vault'));
    return this.validateOwner(id, connectionRecordSchema.parse(JSON.parse(await this.vault.openManaged('tracker', id, text))));
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
  private async sealWithinBound(id: string, record: StoredTrackerConnection): Promise<string> {
    const text = await this.vault.sealManaged('tracker', id, JSON.stringify(record));
    if (Buffer.byteLength(text, 'utf8') > MAX_RECORD_BYTES) throw new Error('Credentials are too large to store');
    return text;
  }
  private async readId(id: string): Promise<StoredTrackerConnection> {
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
  private async readAndMigrate(id: string, persist = true): Promise<StoredTrackerConnection> {
    let encrypted: StoredTrackerConnection | undefined;
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
    if (!encrypted) await this.saveEncrypted(id, record);
    if (legacy && encrypted) await this.save(join(this.directory, id + '.migrated'), '1\n');
    if (legacy) await fs.unlink(join(this.directory, id + '.env'));
    return record;
  }

  async inspect(root: string): Promise<{ record: StoredTrackerConnection | null; error?: string }> {
    if (this.demo) return { record: null };
    try {
      const canonical = await fs.realpath(root);
      await this.checkDirectory();
      return { record: await this.readId(this.id(canonical)) };
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
  /** `error` names a reason worth showing; `null` is the generic storage failure. */
  async saveCredentials(root: string, credentials: TrackerCredentials): Promise<{ record: StoredTrackerConnection } | { error: string | null }> {
    if (this.demo) return { error: null };
    let committing: { id: string; record: StoredTrackerConnection } | undefined;
    try {
      const projectRoot = await fs.realpath(root);
      const record = connectionRecordSchema.parse({ id: randomUUID(), projectRoot, credentials });
      if (Object.values(record.credentials).some(value => /[\x00-\x1f\x7f]/.test(value))) throw new Error('Invalid credential characters');
      const id = this.id(projectRoot);
      await this.locked(id, async () => {
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
          let existing: StoredTrackerConnection | undefined;
          try { existing = await this.readEncrypted(id); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          const migrated = await fs.lstat(join(this.directory, id + '.migrated')).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return null; });
          if (legacy && !existing && !migrated) await this.saveEncrypted(id, legacy);
          await fs.unlink(join(this.directory, id + '.env'));
        }
        const text = await this.sealWithinBound(id, record);
        if (await this.vault.openManaged('tracker', id, text) !== JSON.stringify(record)) throw new Error('Credential verification failed');
        // All housekeeping precedes the atomic credential commit.
        await this.save(join(this.directory, id + '.migrated'), '1\n');
        committing = { id, record };
        await this.save(join(this.directory, id + '.vault'), text);
      });
      return { record };
    } catch (error) {
      // A failure after the rename (directory fsync, lock cleanup) must not report a replacement
      // that is already on disk as failed: the new UUID has invalidated the old bindings.
      const failed = { error: error instanceof SecretsError ? error.message : null };
      if (!committing) return failed;
      const committed = committing as { id: string; record: StoredTrackerConnection };
      const persisted = await this.readEncrypted(committed.id).catch(() => null);
      return persisted?.id === committed.record.id ? { record: committed.record } : failed;
    }
  }
  async remove(root: string): Promise<boolean> {
    if (this.demo) return false;
    try { await this.removeId(this.id(await fs.realpath(root))); return true; }
    catch { return false; }
  }
  async inventory(): Promise<Array<{ id: string; root: string | null; provider: string | null; status: 'valid' | 'invalid' }>> {
    if (this.demo) return [];
    try { await this.checkDirectory(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new Error('Cannot read tracker credential storage.'); }
    try {
      const entries = await fs.readdir(this.directory);
      return await Promise.all([...new Set(entries.filter(name => /^[a-f0-9]{64}\.(env|vault)$/.test(name)).map(name => name.split('.')[0]!))].sort().map(async id => {
        try { const record = await this.readId(id); return { id, root: record.projectRoot, provider: record.credentials.kind, status: 'valid' as const }; }
        catch { return { id, root: null, provider: null, status: 'invalid' as const }; }
      }));
    } catch { throw new Error('Cannot read tracker credential storage.'); }
  }
  async removeId(id: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Expected a 64-character lowercase hexadecimal connection ID.');
    if (this.demo) return;
    try {
      await this.checkDirectory();
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
