import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import type { TrackerCredentials } from '@open-mercato/cezar-contract';
import { cezarHomeDir, assertCezarHomeWriteIsSandboxed } from '../../paths.ts';
import { connectionRecordSchema, decodeConnectionEnv, encodeConnectionEnv, type StoredTrackerConnection } from './connection-env.ts';
export type { StoredTrackerConnection } from './connection-env.ts';

/** Private per-project dotenv storage. Not an OS-user/sandbox boundary. */
export class TrackerConnections {
  private readonly directory: string;
  private readonly demo: boolean;
  constructor(env: NodeJS.ProcessEnv = process.env) {
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
      if (!stat.isFile() || stat.size > 32_768 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error('Invalid credential file');
      // Bound the actual read, too: the file can grow after fstat.
      const buffer = Buffer.alloc(32_769);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > 32_768) throw new Error('Invalid credential file');
      return buffer.subarray(0, offset).toString('utf8');
    } finally { await file.close(); }
  }
  private async save(path: string, text: string): Promise<void> {
    const temporary = path + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, path);
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
  private async readId(id: string): Promise<StoredTrackerConnection> {
    const record = decodeConnectionEnv(await this.readFile(join(this.directory, id + '.env')));
    if (!isAbsolute(record.projectRoot) || this.id(record.projectRoot) !== id) throw new Error('Invalid credential owner');
    return record;
  }
  async inspect(root: string): Promise<{ record: StoredTrackerConnection | null; error?: string }> {
    if (this.demo) return { record: null };
    try {
      const canonical = await fs.realpath(root);
      await this.checkDirectory();
      return { record: await this.readId(this.id(canonical)) };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { record: null }
        : { record: null, error: 'Cannot read project credentials. Re-save in Settings or use cez tracker-connections list/remove for local cleanup.' };
    }
  }
  async read(root: string): Promise<StoredTrackerConnection | null> {
    return (await this.inspect(root)).record;
  }
  async write(root: string, credentials: TrackerCredentials): Promise<StoredTrackerConnection | null> {
    if (this.demo) return null;
    try {
      const projectRoot = await fs.realpath(root);
      const record = connectionRecordSchema.parse({ id: randomUUID(), projectRoot, credentials });
      const text = encodeConnectionEnv(record);
      const id = this.id(projectRoot);
      await this.locked(id, () => this.save(join(this.directory, id + '.env'), text));
      return record;
    } catch { return null; }
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
      return await Promise.all(entries.filter(name => /^[a-f0-9]{64}\.env$/.test(name)).sort().map(async name => {
        const id = name.slice(0, -4);
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
        await fs.unlink(join(this.directory, id + '.env')).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot remove tracker credentials. Check local storage permissions.');
    }
  }
}
