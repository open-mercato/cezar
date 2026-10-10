import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  lifecycleIdSchema, lifecycleOperationSchema, lifecycleOutputFrameSchema,
  runIdParamSchema, worktreeLifecycleRecordSchema,
  type LifecycleOperation, type LifecycleOutputFrame, type LifecycleOutputResponse,
  type WorktreeLifecycleRecord,
} from '@open-mercato/cezar-contract';

const OUTPUT_CAP = 10 * 1024 * 1024;
const HISTORY_TTL = 7 * 24 * 60 * 60 * 1000;
const terminalStates = new Set(['completed', 'bypassed', 'cancelled', 'kept']);
export class LifecycleConflictError extends Error {}
export class LifecycleStoreError extends Error {}

function safeRunId(value: string): string {
  const id = runIdParamSchema.shape.id.parse(value);
  if (id === '.' || id === '..') throw new LifecycleStoreError('Invalid run ID');
  return id;
}
function contained(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel);
}

/** Refuse symlinked storage paths before reading, writing or locking any state. */
export async function assertLifecyclePath(path: string, root: string): Promise<void> {
  const base = await fs.realpath(root);
  const target = resolve(path);
  const declaredRoot = resolve(root);
  if (target !== declaredRoot && !contained(declaredRoot, target)) throw new LifecycleStoreError('Lifecycle path is outside the project');
  const rel = relative(declaredRoot, target);
  let cursor = base;
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, part);
    const stat = await fs.lstat(cursor).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (stat?.isSymbolicLink()) throw new LifecycleStoreError('Lifecycle path contains a symbolic link');
  }
}

export async function atomicLifecycleWrite(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await fs.open(temporary, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
    finally { await file.close(); }
    await fs.rename(temporary, path);
    // Durable rename on platforms that support directory fsync.
    const directory = await fs.open(dirname(path), 'r').catch(() => null);
    if (directory) { try { await directory.sync(); } catch {} finally { await directory.close(); } }
  } finally { await fs.unlink(temporary).catch(() => undefined); }
}

/** Same atomic mkdir + PID-owner lease used by tracker-association, with unique owner tokens. */
export async function withLifecycleFileLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const ownerName = `${process.pid}-${randomUUID()}`;
  const owner = join(path, ownerName);
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.mkdir(path, { mode: 0o700 });
      try { await fs.writeFile(owner, '', { flag: 'wx', mode: 0o600 }); }
      catch (error) { await fs.rmdir(path).catch(() => undefined); throw error; }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (attempt >= 250) throw new LifecycleConflictError('Worktree lifecycle is busy in another operation');
      const stat = await fs.lstat(path).catch(() => null);
      if (!stat) continue;
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LifecycleStoreError('Invalid lifecycle lock');
      const owners = await fs.readdir(path);
      const match = owners.length === 1 ? /^([1-9][0-9]*)-[0-9a-f-]{36}$/.exec(owners[0]!) : null;
      if (match) {
        try { process.kill(Number(match[1]), 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            // The unique owner filename elects one reaper. Never unlink a replacement lease.
            try { await fs.unlink(join(path, owners[0]!)); await fs.rmdir(path); } catch {}
          }
        }
      } else if (owners.length === 0 && Date.now() - stat.mtimeMs > 60_000) {
        await fs.rmdir(path).catch(() => undefined);
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try { return await action(); }
  finally { await fs.unlink(owner).catch(() => undefined); await fs.rmdir(path).catch(() => undefined); }
}

export class LifecycleStore {
  readonly directory: string;
  constructor(readonly dataDir: string, readonly projectRoot: string) { this.directory = join(dataDir, 'lifecycle'); }

  private async path(kind: string, id: string, extension = 'json'): Promise<string> {
    const path = join(this.directory, kind, `${id}.${extension}`);
    await assertLifecyclePath(path, this.projectRoot);
    return path;
  }
  async withWorktreeLock<T>(runId: string, action: () => Promise<T>): Promise<T> {
    return withLifecycleFileLock(await this.path('locks', safeRunId(runId), 'lock'), action);
  }
  async validateContext(record: WorktreeLifecycleRecord): Promise<void> {
    const root = await fs.realpath(this.projectRoot);
    if (record.projectRoot !== root) throw new LifecycleStoreError('Lifecycle record belongs to another project');
    const expected = join(root, '.ai', 'cezar', 'worktrees', safeRunId(record.runId));
    if (resolve(record.worktreePath) !== expected) throw new LifecycleStoreError('Lifecycle worktree path does not match the managed task directory');
    await assertLifecyclePath(expected, root);
  }
  async readWorktree(runId: string): Promise<WorktreeLifecycleRecord | null> {
    const path = await this.path('worktrees', safeRunId(runId));
    try {
      const record = worktreeLifecycleRecordSchema.parse(JSON.parse(await fs.readFile(path, 'utf8')));
      if (record.runId !== runId) throw new LifecycleStoreError('Lifecycle record ID mismatch');
      await this.validateContext(record);
      return record;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async writeWorktree(record: WorktreeLifecycleRecord): Promise<void> {
    const parsed = worktreeLifecycleRecordSchema.parse(record);
    await this.validateContext(parsed);
    const path = await this.path('worktrees', safeRunId(parsed.runId));
    const previous = await this.readWorktree(parsed.runId);
    if (previous && previous.worktreeId !== parsed.worktreeId) throw new LifecycleConflictError('A logical worktree identity cannot be replaced');
    const preserved = { ...previous };
    for (const key of Object.keys(worktreeLifecycleRecordSchema.shape)) delete preserved[key];
    await atomicLifecycleWrite(path, { ...preserved, ...parsed });
  }
  async readOperation(id: string): Promise<LifecycleOperation | null> {
    const path = await this.path('operations', lifecycleIdSchema.parse(id));
    try {
      const record = lifecycleOperationSchema.parse(JSON.parse(await fs.readFile(path, 'utf8')));
      if (record.id !== id) throw new LifecycleStoreError('Lifecycle operation ID mismatch');
      return record;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  /** expectedRevision null means create-only; a number atomically compares an existing revision. */
  async writeOperation(operation: LifecycleOperation, expectedRevision?: number | null): Promise<void> {
    const parsed = lifecycleOperationSchema.parse(operation);
    const path = await this.path('operations', parsed.id);
    await withLifecycleFileLock(await this.path('locks', `operation-${parsed.id}`, 'lock'), async () => {
      const previous = await this.readOperation(parsed.id);
      if (expectedRevision === null && previous) throw new LifecycleConflictError('Lifecycle operation already exists');
      if (typeof expectedRevision === 'number' && previous?.revision !== expectedRevision) throw new LifecycleConflictError('Lifecycle operation changed; refresh and try again');
      if (previous && (previous.worktreeId !== parsed.worktreeId || previous.generation !== parsed.generation)) throw new LifecycleConflictError('Lifecycle operation identity cannot change');
      if (previous && parsed.revision <= previous.revision) throw new LifecycleConflictError('Lifecycle operation revision must advance');
      const preserved = { ...previous };
      for (const key of Object.keys(lifecycleOperationSchema.shape)) delete preserved[key];
      await atomicLifecycleWrite(path, { ...preserved, ...parsed });
    });
  }
  async listWorktrees(): Promise<{ records: WorktreeLifecycleRecord[]; errors: { id: string; error: string }[] }> {
    const directory = join(this.directory, 'worktrees');
    await assertLifecyclePath(directory, this.projectRoot);
    const names = await fs.readdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; });
    const records: WorktreeLifecycleRecord[] = [];
    const errors: { id: string; error: string }[] = [];
    for (const name of names.filter(name => name.endsWith('.json')).sort()) {
      const id = name.slice(0, -5);
      try { const record = await this.readWorktree(id); if (record) records.push(record); }
      catch { errors.push({ id, error: 'Lifecycle metadata is invalid or unreadable; the worktree is retained' }); }
    }
    return { records, errors };
  }
  async listOperations(worktreeId?: string): Promise<LifecycleOperation[]> {
    if (worktreeId !== undefined) lifecycleIdSchema.parse(worktreeId);
    const directory = join(this.directory, 'operations');
    await assertLifecyclePath(directory, this.projectRoot);
    const names = await fs.readdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; });
    const result: LifecycleOperation[] = [];
    for (const name of names.filter(name => name.endsWith('.json')).sort()) {
      try { const operation = await this.readOperation(name.slice(0, -5)); if (operation && (!worktreeId || operation.worktreeId === worktreeId)) result.push(operation); }
      catch { /* Independent records survive corruption; active record lookup still fails closed. */ }
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  /** Frames MUST already have passed the shared stream redactor. */
  async appendOutput(operationId: string, frame: Omit<LifecycleOutputFrame, 'seq'> & { seq?: number }): Promise<LifecycleOutputFrame> {
    const id = lifecycleIdSchema.parse(operationId);
    const path = await this.path('output', id, 'ndjson');
    return withLifecycleFileLock(await this.path('locks', `output-${id}`, 'lock'), async () => {
      const current = await fs.readFile(path, 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; });
      const lines = current.trimEnd().split('\n').filter(Boolean);
      const last = lines.length ? lifecycleOutputFrameSchema.parse(JSON.parse(lines.at(-1)!)) : null;
      const parsed = lifecycleOutputFrameSchema.parse({ ...frame, seq: frame.seq ?? (last?.seq ?? 0) + 1 });
      if (last && parsed.seq <= last.seq) throw new LifecycleConflictError('Lifecycle output sequence must advance');
      lines.push(JSON.stringify(parsed));
      let bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
      while (bytes > OUTPUT_CAP && lines.length > 1) bytes -= Buffer.byteLength(lines.shift()!) + 1;
      await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, `${lines.join('\n')}\n`, { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, path); }
      finally { await fs.unlink(temporary).catch(() => undefined); }
      return parsed;
    });
  }
  async readOutput(operationId: string, afterSeq = 0, limit = 100): Promise<LifecycleOutputResponse> {
    const path = await this.path('output', lifecycleIdSchema.parse(operationId), 'ndjson');
    const text = await fs.readFile(path, 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; });
    const frames = text.split('\n').filter(Boolean).flatMap(line => {
      try { return [lifecycleOutputFrameSchema.parse(JSON.parse(line))]; } catch { return []; }
    });
    const items = frames.filter(frame => frame.seq > afterSeq).slice(0, Math.min(200, Math.max(1, limit)));
    return { items, nextSeq: items.at(-1)?.seq ?? afterSeq, truncated: (frames[0]?.seq ?? 1) > afterSeq + 1 };
  }
  /** Reclaimed identities survive forever while their task exists. Active history never expires. */
  async pruneHistory(taskExists: (runId: string) => boolean | Promise<boolean>, now = Date.now()): Promise<void> {
    const { records } = await this.listWorktrees();
    for (const record of records) {
      const operations = await this.listOperations(record.worktreeId);
      const active = record.activeOperationId ? await this.readOperation(record.activeOperationId).catch(() => null) : undefined;
      if (record.activeOperationId && !active) continue;
      const allTerminal = operations.every(operation => terminalStates.has(operation.state));
      const onDisk = await fs.lstat(record.worktreePath).then(() => true, () => false);
      for (const operation of operations) {
        if (!terminalStates.has(operation.state) || operation.id === record.activeOperationId) continue;
        if (onDisk && operation.generation >= record.generation) continue;
        if (now - Date.parse(operation.finishedAt ?? operation.updatedAt) < HISTORY_TTL) continue;
        await fs.unlink(await this.path('operations', operation.id)).catch(() => undefined);
        await fs.unlink(await this.path('output', operation.id, 'ndjson')).catch(() => undefined);
      }
      if (!onDisk && allTerminal && !await taskExists(record.runId) && now - Date.parse(record.updatedAt) >= HISTORY_TTL) {
        await fs.unlink(await this.path('worktrees', safeRunId(record.runId))).catch(() => undefined);
      }
    }
  }
}
