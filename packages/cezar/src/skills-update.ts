import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CHECK_TTL_MS = 6 * 60 * 60 * 1_000;
const COMMAND_TIMEOUT_MS = 30_000;
const OUTPUT_CAP = 64 * 1_024;
const LOCK_STALE_MS = 2 * 60 * 1_000;

export type SkillsUpdateScope = 'project' | 'global';
export type SkillsUpdateStatus = 'idle' | 'checking' | 'available' | 'updating' | 'current' | 'unavailable' | 'error';

export interface SkillsUpdateScopeState {
  scope: SkillsUpdateScope;
  status: SkillsUpdateStatus;
  available: boolean;
  skills: string[];
  checkedAt: string | null;
  updatedAt: string | null;
  reason?: string;
}

export interface SkillsUpdateState {
  status: SkillsUpdateStatus;
  available: boolean;
  autoUpdateEnabled: boolean;
  inherited: boolean;
  checkedAt: string | null;
  updatedAt: string | null;
  scopes: SkillsUpdateScopeState[];
  needsUpgradeNotes: boolean;
}

interface CommandResult { stdout: string; stderr: string }
export interface SkillsUpdateServiceOptions {
  homeDir?: string;
  now?: () => number;
  timeoutMs?: number;
  run?: (file: string, args: readonly string[], cwd: string, timeoutMs: number) => Promise<CommandResult>;
  resolveNpx?: () => Promise<string | null>;
  invalidateCatalog?: (repoRoot: string) => Promise<unknown> | unknown;
}

/** A manual apply distinguishes contention from ordinary unavailable state. */
export class SkillsUpdateConflictError extends Error {
  constructor() { super('another skills update operation is running'); this.name = 'SkillsUpdateConflictError'; }
}

type LockRead = { kind: 'ok'; names: string[] } | { kind: 'missing' } | { kind: 'invalid' };
type LockEntry = { source?: unknown; sourceUrl?: unknown };

/** Accept only GitHub's canonical host and the documented owner/repo shorthand. */
export function isOpenMercatoSkillsSource(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const source = value.trim().replace(/\/$/, '');
  if (/^open-mercato\/skills(?:\.git)?$/i.test(source)) return true;
  try {
    const url = new URL(source);
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'github.com'
      && /^\/open-mercato\/skills(?:\.git)?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

async function readLock(path: string): Promise<LockRead> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'invalid' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'invalid' };
  const root = parsed as Record<string, unknown>;
  if (root.version !== undefined && (!Number.isInteger(root.version) || Number(root.version) < 1 || Number(root.version) > 3)) {
    return { kind: 'invalid' };
  }
  if (!root.skills || typeof root.skills !== 'object' || Array.isArray(root.skills)) return { kind: 'invalid' };
  const names = Object.entries(root.skills as Record<string, unknown>).flatMap(([name, raw]) => {
    if (!name || !raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const entry = raw as LockEntry;
    return isOpenMercatoSkillsSource(entry.source) || isOpenMercatoSkillsSource(entry.sourceUrl) ? [name] : [];
  });
  return { kind: 'ok', names: [...new Set(names)].sort() };
}

function blankScope(scope: SkillsUpdateScope): SkillsUpdateScopeState {
  return { scope, status: 'idle', available: false, skills: [], checkedAt: null, updatedAt: null };
}

function reasonFor(error: unknown): string {
  const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
  const text = String(err.message ?? '').toLowerCase();
  if (err.code === 'ENOENT') return 'npx is unavailable';
  if (err.killed || err.signal === 'SIGTERM' || text.includes('timed out')) return 'update check timed out';
  if (/(enotfound|eai_again|network|offline|fetch failed)/.test(text)) return 'update check is offline';
  return 'update check failed';
}

async function defaultResolveNpx(): Promise<string | null> {
  const name = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const adjacent = join(dirname(process.execPath), name);
  try { await access(adjacent, constants.X_OK); return adjacent; } catch { return name; }
}

async function defaultRun(file: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<CommandResult> {
  const result = await execFileAsync(file, [...args], {
    cwd, shell: false, timeout: timeoutMs, maxBuffer: OUTPUT_CAP,
    env: { ...process.env, npm_config_yes: 'true', GIT_TERMINAL_PROMPT: '0' },
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

/** Parse only explicit update lines naming a lock-authorized skill. */
function availableNames(output: string, names: readonly string[]): string[] {
  const lines = output.split(/\r?\n/);
  return names.filter((name) => lines.some((line) =>
    line.toLowerCase().includes(name.toLowerCase()) && /update|out.of.date|new version/i.test(line)));
}

export class SkillsUpdateService {
  private readonly home: string;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly runCommand: NonNullable<SkillsUpdateServiceOptions['run']>;
  private readonly resolveNpx: NonNullable<SkillsUpdateServiceOptions['resolveNpx']>;
  private readonly invalidateCatalog: NonNullable<SkillsUpdateServiceOptions['invalidateCatalog']>;
  private readonly states = new Map<string, SkillsUpdateState>();
  private readonly pending = new Map<string, Promise<SkillsUpdateState>>();
  private globalScopeCache?: SkillsUpdateScopeState;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(options: SkillsUpdateServiceOptions = {}) {
    this.home = options.homeDir ?? homedir();
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
    this.runCommand = options.run ?? defaultRun;
    this.resolveNpx = options.resolveNpx ?? defaultResolveNpx;
    this.invalidateCatalog = options.invalidateCatalog ?? (() => undefined);
  }

  snapshot(repoRoot: string): SkillsUpdateState {
    return this.states.get(repoRoot) ?? this.makeState();
  }

  check(repoRoot: string, force = false): Promise<SkillsUpdateState> {
    const cached = this.states.get(repoRoot);
    if (!force && cached?.checkedAt && this.now() - Date.parse(cached.checkedAt) < CHECK_TTL_MS) return Promise.resolve(cached);
    const active = this.pending.get(repoRoot);
    if (active) return active;
    const task = this.serialized(() => this.performCheck(repoRoot, force)).finally(() => this.pending.delete(repoRoot));
    this.pending.set(repoRoot, task);
    return task;
  }

  /** Apply only names proven available by the latest check. Browser callers
   * cannot widen this list: ownership is re-read from the lock immediately
   * before each fixed-argument invocation. */
  update(repoRoot: string, rejectIfBusy = false): Promise<SkillsUpdateState> {
    const active = this.pending.get(repoRoot);
    if (active) return rejectIfBusy ? Promise.reject(new SkillsUpdateConflictError()) : active;
    const task = this.serialized(() => this.performUpdate(repoRoot, rejectIfBusy)).finally(() => this.pending.delete(repoRoot));
    this.pending.set(repoRoot, task);
    return task;
  }

  evict(repoRoot: string): void {
    this.states.delete(repoRoot);
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try { return await operation(); } finally { release(); }
  }

  private makeState(scopes = [blankScope('project'), blankScope('global')]): SkillsUpdateState {
    return { status: 'idle', available: false, autoUpdateEnabled: true, inherited: true,
      checkedAt: null, updatedAt: null, scopes, needsUpgradeNotes: false };
  }

  private async performCheck(repoRoot: string, force = false, rejectIfBusy = false): Promise<SkillsUpdateState> {
    if (process.env.CEZ_DRY_RUN === '1') {
      const checkedAt = new Date(this.now()).toISOString();
      const scopes = [blankScope('project'), blankScope('global')].map((scope) => ({ ...scope, status: 'current' as const, checkedAt }));
      const state = { ...this.makeState(scopes), status: 'current' as const, checkedAt };
      this.states.set(repoRoot, state); return state;
    }
    const lockPath = join(this.home, '.cache', 'cez', 'skills-update.lock');
    let release: (() => Promise<void>) | undefined;
    try {
      release = await this.acquireLock(lockPath, rejectIfBusy);
      const npx = await this.resolveNpx();
      if (!npx) throw Object.assign(new Error('missing executable'), { code: 'ENOENT' });
      const pairs: Array<[SkillsUpdateScope, string]> = [
        ['project', join(repoRoot, 'skills-lock.json')],
        ['global', join(this.home, '.agents', '.skill-lock.json')],
      ];
      const scopes: SkillsUpdateScopeState[] = [];
      for (const [scope, path] of pairs) {
        if (scope === 'global' && !force && this.globalScopeCache?.checkedAt
          && this.now() - Date.parse(this.globalScopeCache.checkedAt) < CHECK_TTL_MS) {
          scopes.push(this.globalScopeCache);
        } else {
          const result = await this.checkScope(scope, path, repoRoot, npx);
          if (scope === 'global') this.globalScopeCache = result;
          scopes.push(result);
        }
      }
      const available = scopes.some((scope) => scope.available);
      const checkedAt = new Date(this.now()).toISOString();
      const status: SkillsUpdateStatus = available ? 'available'
        : scopes.some((scope) => scope.status === 'error') ? 'error'
        : scopes.every((scope) => scope.status === 'unavailable') ? 'unavailable' : 'current';
      const state = { ...this.makeState(scopes), status, available, checkedAt };
      this.states.set(repoRoot, state); return state;
    } catch (error) {
      if (error instanceof SkillsUpdateConflictError) throw error;
      const checkedAt = new Date(this.now()).toISOString();
      const reason = reasonFor(error);
      const scopes = [blankScope('project'), blankScope('global')].map((scope) => ({ ...scope, status: 'unavailable' as const, checkedAt, reason }));
      const state = { ...this.makeState(scopes), status: 'unavailable' as const, checkedAt };
      this.states.set(repoRoot, state); return state;
    } finally { await release?.(); }
  }

  private async performUpdate(repoRoot: string, rejectIfBusy: boolean): Promise<SkillsUpdateState> {
    if (process.env.CEZ_DRY_RUN === '1') {
      const updatedAt = new Date(this.now()).toISOString();
      const scopes = [blankScope('project'), blankScope('global')].map((scope) => ({ ...scope, status: 'current' as const, checkedAt: updatedAt, updatedAt }));
      const state = { ...this.makeState(scopes), status: 'current' as const, checkedAt: updatedAt, updatedAt, needsUpgradeNotes: true };
      this.states.set(repoRoot, state);
      return state;
    }
    let current = this.states.get(repoRoot);
    if (!current?.checkedAt) current = await this.performCheck(repoRoot, false, rejectIfBusy);
    if (!current.available) return current;

    const lockPath = join(this.home, '.cache', 'cez', 'skills-update.lock');
    let release: (() => Promise<void>) | undefined;
    const completed = new Set<SkillsUpdateScope>();
    const outcomes: SkillsUpdateScopeState[] = [];
    try {
      release = await this.acquireLock(lockPath, rejectIfBusy);
      const npx = await this.resolveNpx();
      if (!npx) throw Object.assign(new Error('missing executable'), { code: 'ENOENT' });
      for (const scope of ['project', 'global'] as const) {
        const prior = current.scopes.find((entry) => entry.scope === scope) ?? blankScope(scope);
        if (!prior.available || prior.skills.length === 0) { outcomes.push(prior); continue; }
        const path = scope === 'project' ? join(repoRoot, 'skills-lock.json') : join(this.home, '.agents', '.skill-lock.json');
        const owned = await readLock(path);
        const names = owned.kind === 'ok' ? prior.skills.filter((name) => owned.names.includes(name)).sort() : [];
        if (names.length === 0) {
          outcomes.push({ ...prior, status: 'unavailable', reason: 'installation metadata is unsupported' });
          continue;
        }
        try {
          await this.runCommand(npx, ['--yes', 'skills', 'update', ...names, scope === 'project' ? '-p' : '-g', '-y'], repoRoot, this.timeoutMs);
          completed.add(scope);
          outcomes.push({ ...prior, status: 'current', available: false, skills: [], updatedAt: new Date(this.now()).toISOString(), reason: undefined });
        } catch (error) {
          outcomes.push({ ...prior, status: 'error', reason: reasonFor(error) });
        }
      }
    } catch (error) {
      if (error instanceof SkillsUpdateConflictError) throw error;
      const reason = reasonFor(error);
      for (const scope of ['project', 'global'] as const) {
        const prior = current.scopes.find((entry) => entry.scope === scope) ?? blankScope(scope);
        outcomes.push({ ...prior, status: prior.available ? 'error' : prior.status, reason: prior.available ? reason : prior.reason });
      }
    } finally {
      await release?.();
    }

    // Recheck after releasing the cross-process lock: performCheck owns the
    // same lock and must observe the files written by every successful scope.
    this.states.set(repoRoot, { ...current, scopes: outcomes, status: outcomes.some((s) => s.status === 'error') ? 'error' : 'current' });
    if (completed.size > 0) await Promise.resolve(this.invalidateCatalog(repoRoot)).catch(() => undefined);
    const checked = await this.performCheck(repoRoot, true);
    const failedByScope = new Map(outcomes.filter((s) => s.status === 'error').map((s) => [s.scope, s]));
    const scopes = checked.scopes.map((scope) => failedByScope.get(scope.scope) ?? (completed.has(scope.scope) ? { ...scope, updatedAt: outcomes.find((s) => s.scope === scope.scope)?.updatedAt ?? null } : scope));
    const available = scopes.some((scope) => scope.available);
    const status: SkillsUpdateStatus = scopes.some((scope) => scope.status === 'error') ? 'error' : available ? 'available' : 'current';
    const updatedAt = completed.size > 0 ? new Date(this.now()).toISOString() : current.updatedAt;
    const final = { ...checked, scopes, available, status, updatedAt, needsUpgradeNotes: current.needsUpgradeNotes || completed.size > 0 };
    this.states.set(repoRoot, final);
    return final;
  }

  private async checkScope(scope: SkillsUpdateScope, path: string, cwd: string, npx: string): Promise<SkillsUpdateScopeState> {
    const checkedAt = new Date(this.now()).toISOString();
    const lock = await readLock(path);
    if (lock.kind === 'missing') return { ...blankScope(scope), status: 'current', checkedAt, reason: 'installation is not tracked' };
    if (lock.kind === 'invalid') return { ...blankScope(scope), status: 'unavailable', checkedAt, reason: 'installation metadata is unsupported' };
    if (lock.names.length === 0) return { ...blankScope(scope), status: 'current', checkedAt, reason: 'Open Mercato installation is not tracked' };
    try {
      const args = ['--yes', 'skills', 'check', ...lock.names, ...(scope === 'project' ? ['-p'] : ['-g'])];
      const result = await this.runCommand(npx, args, cwd, this.timeoutMs);
      const skills = availableNames(`${result.stdout}\n${result.stderr}`, lock.names);
      return { ...blankScope(scope), status: skills.length ? 'available' : 'current', available: skills.length > 0, skills, checkedAt };
    } catch (error) {
      return { ...blankScope(scope), status: 'error', checkedAt, reason: reasonFor(error) };
    }
  }

  private async acquireLock(path: string, rejectIfBusy = false): Promise<() => Promise<void>> {
    await mkdir(dirname(path), { recursive: true });
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n${this.now()}\n`); await handle.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const metadata = await this.readLockMetadata(path);
      const age = this.now() - metadata.timestamp;
      if (age <= LOCK_STALE_MS && metadata.alive) {
        if (rejectIfBusy) throw new SkillsUpdateConflictError();
        throw new Error('another skills update check is running');
      }
      await rm(path, { force: true });
      const handle = await open(path, 'wx', 0o600); await handle.writeFile(`${process.pid}\n${this.now()}\n`); await handle.close();
    }
    return () => rm(path, { force: true });
  }

  private async readLockMetadata(path: string): Promise<{ timestamp: number; alive: boolean }> {
    const fallback = (await stat(path)).mtimeMs;
    try {
      const [pidText, timestampText] = (await readFile(path, 'utf8')).trim().split(/\s+/);
      const pid = Number(pidText); const timestamp = Number(timestampText);
      if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(timestamp)) return { timestamp: fallback, alive: false };
      try { process.kill(pid, 0); return { timestamp, alive: true }; }
      catch (error) { return { timestamp, alive: (error as NodeJS.ErrnoException).code === 'EPERM' }; }
    } catch { return { timestamp: fallback, alive: false }; }
  }
}

export interface SkillsUpdateProject { id: string; root: string; status?: string }

/** Post-listen owner for background checks. Its tail deliberately swallows
 * failures: update availability can never reject or delay server startup. */
export class SkillsUpdateCoordinator {
  private readonly roots = new Map<string, string>();
  private tail: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly service: SkillsUpdateService,
    private readonly autoUpdateEnabled: () => Promise<boolean>,
  ) {}

  start(projects: readonly SkillsUpdateProject[]): void {
    for (const project of projects) {
      if (project.status !== 'missing') this.add(project.id, project.root);
    }
  }

  add(id: string, root: string): void {
    if (this.stopped) return;
    this.roots.set(id, root);
    this.tail = this.tail.then(async () => {
      if (this.stopped || this.roots.get(id) !== root) return;
      const state = await this.service.check(root);
      if (state.available && await this.autoUpdateEnabled()) await this.service.update(root);
    }).catch(() => undefined);
  }

  remove(id: string): void {
    const root = this.roots.get(id);
    this.roots.delete(id);
    if (root) this.service.evict(root);
  }

  stop(): void {
    this.stopped = true;
    for (const root of this.roots.values()) this.service.evict(root);
    this.roots.clear();
  }

  /** Test/lifecycle hook: resolves after all work queued so far. */
  settled(): Promise<void> { return this.tail; }
}
