import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { managerMessageSchema, managerSchema, type Manager, type ManagerMessage } from '@open-mercato/cezar-contract';
import { collectSecretValues, redactDeep } from '../core/secret-redaction.ts';
import { assertCezarHomeWriteIsSandboxed, managersDir, managersPath } from '../paths.ts';
import { atomicWriteJsonSync } from '../workspace/config.ts';

/**
 * `~/.cezar/managers.json` plus `~/.cezar/managers/<id>/` (spec 2026-10-31-managers § Model).
 *
 * Nothing is cached across calls except the chat tail, and that is re-synced from the file before
 * every read: `~/.cezar` is shared by every cezar process on the machine, so a second cockpit's
 * write must show up here without an event.
 */

const stateSchema = z
  .object({
    sessionId: z.string().optional().catch(undefined),
    /** `runner|account` the session belongs to: a transcript does not follow either change. */
    sessionKey: z.string().optional().catch(undefined),
    lastCheckAt: z.string().optional().catch(undefined),
    /** Attention keys already spoken about, → when. A key that disappears is forgotten. */
    reported: z.record(z.string(), z.string()).catch({}),
    costUsd: z.number().min(0).catch(0),
    /** Highest `seq` the user has opened; -1 so a first message at seq 0 still counts as unread. */
    readSeq: z.number().int().min(-1).catch(-1),
    watchFailures: z.number().int().min(0).catch(0),
    /** What happened since the agent's last turn (a merge it proposed…), folded into the next. */
    notes: z.array(z.string()).catch([]),
  })
  .passthrough();

export type ManagerState = z.infer<typeof stateSchema>;

const EMPTY_STATE = (): ManagerState => stateSchema.parse({});

const managersFileSchema = z.object({ managers: z.array(z.unknown()).catch([]) }).passthrough();

interface Row {
  raw: Record<string, unknown>;
  manager?: Manager;
}

/** A newer cezar's keys survive an older one: only the keys this version knows are overwritten. */
function mergeRow(row: Row): Record<string, unknown> {
  if (!row.manager) return row.raw;
  const extras = Object.fromEntries(Object.entries(row.raw).filter(([key]) => !(key in managerSchema.shape)));
  return { ...extras, ...row.manager };
}

class ChatLog {
  private readonly messages = new Map<string, ManagerMessage>();
  private offset = 0;
  private tail = '';

  constructor(
    private readonly path: string,
    private readonly warn: (message: string) => void,
  ) {}

  /** Read what was appended since last time, by anyone. Unparseable lines are skipped. */
  private sync(): void {
    let fd: number;
    try {
      fd = openSync(this.path, 'r');
    } catch {
      return;
    }
    try {
      const { size } = fstatSync(fd);
      if (size < this.offset) {
        this.messages.clear();
        this.offset = 0;
        this.tail = '';
      }
      if (size === this.offset) return;
      const buffer = Buffer.alloc(size - this.offset);
      readSync(fd, buffer, 0, buffer.length, this.offset);
      this.offset = size;
      const lines = `${this.tail}${buffer.toString('utf8')}`.split('\n');
      this.tail = lines.pop() ?? '';
      let corrupt = 0;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = managerMessageSchema.safeParse(JSON.parse(line));
          if (parsed.success) this.messages.set(parsed.data.id, parsed.data);
          else corrupt += 1;
        } catch {
          corrupt += 1;
        }
      }
      if (corrupt > 0) this.warn(`[cezar] ${this.path}: skipped ${corrupt} unreadable line(s)`);
    } finally {
      closeSync(fd);
    }
  }

  all(): ManagerMessage[] {
    this.sync();
    return [...this.messages.values()].sort((a, b) => a.seq - b.seq);
  }

  get(id: string): ManagerMessage | undefined {
    this.sync();
    return this.messages.get(id);
  }

  nextSeq(): number {
    this.sync();
    let max = -1;
    for (const message of this.messages.values()) if (message.seq > max) max = message.seq;
    return max + 1;
  }

  /** The newest write of an id wins on replay, so a replace is one more appended line. */
  persist(message: ManagerMessage): void {
    this.sync();
    assertCezarHomeWriteIsSandboxed(this.path);
    appendFileSync(this.path, `${JSON.stringify(message)}\n`, { encoding: 'utf8', mode: 0o600 });
    this.messages.set(message.id, message);
  }

  /** A streaming frame: visible to this process now, written when the turn settles. */
  setLive(message: ManagerMessage): void {
    this.messages.set(message.id, message);
  }
}

export class ManagerStore {
  private readonly logs = new Map<string, ChatLog>();
  private readonly warned = new Set<string>();
  private readonly secrets = collectSecretValues();

  constructor(private readonly warn: (message: string) => void = (message) => console.warn(message)) {}

  private warnOnce(message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    this.warn(message);
  }

  private readRows(): { file: Record<string, unknown>; rows: Row[]; corrupt: boolean } {
    const path = managersPath();
    if (!existsSync(path)) return { file: {}, rows: [], corrupt: false };
    let parsed: z.infer<typeof managersFileSchema>;
    try {
      parsed = managersFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      this.warnOnce(`[cezar] ${path} is unreadable; managers start empty`);
      return { file: {}, rows: [], corrupt: true };
    }
    const { managers, ...file } = parsed;
    const rows = managers.flatMap((entry): Row[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const result = managerSchema.safeParse(entry);
      if (!result.success) this.warnOnce(`[cezar] ${path}: skipped an invalid manager entry`);
      return [{ raw: entry as Record<string, unknown>, ...(result.success ? { manager: result.data } : {}) }];
    });
    return { file, rows, corrupt: false };
  }

  list(): Manager[] {
    return this.readRows().rows.flatMap((row) => (row.manager ? [row.manager] : []));
  }

  get(id: string): Manager | undefined {
    return this.list().find((manager) => manager.id === id);
  }

  /** Read-modify-write in one tick, atomic rename. A corrupt file is kept aside, never overwritten. */
  mutate(change: (managers: Manager[]) => Manager[]): Manager[] {
    const { file, rows, corrupt } = this.readRows();
    const path = managersPath();
    if (corrupt) renameSync(path, `${path}.corrupt-${Date.now()}`);
    const invalid = rows.filter((row) => !row.manager);
    const byId = new Map(rows.flatMap((row) => (row.manager ? [[row.manager.id, row] as const] : [])));
    const next = change(rows.flatMap((row) => (row.manager ? [row.manager] : [])));
    atomicWriteJsonSync(path, {
      ...file,
      managers: [...next.map((manager) => mergeRow({ raw: byId.get(manager.id)?.raw ?? {}, manager })), ...invalid.map(mergeRow)],
    });
    return next;
  }

  update(id: string, change: (manager: Manager) => Manager): Manager | undefined {
    let updated: Manager | undefined;
    this.mutate((managers) => managers.map((manager) => (manager.id === id ? (updated = change(manager)) : manager)));
    return updated;
  }

  dir(id: string): string {
    return join(managersDir(), id);
  }

  /** The agent's cwd. Created on demand: deleting the directory loses history, never a turn. */
  workdir(id: string): string {
    const dir = join(this.dir(id), 'workdir');
    assertCezarHomeWriteIsSandboxed(dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private log(id: string): ChatLog {
    let log = this.logs.get(id);
    if (!log) {
      assertCezarHomeWriteIsSandboxed(this.dir(id));
      mkdirSync(this.dir(id), { recursive: true, mode: 0o700 });
      try {
        chmodSync(this.dir(id), 0o700);
      } catch {
        // best effort on filesystems without modes
      }
      log = new ChatLog(join(this.dir(id), 'chat.ndjson'), (message) => this.warnOnce(message));
      this.logs.set(id, log);
    }
    return log;
  }

  messages(id: string): ManagerMessage[] {
    return this.log(id).all();
  }

  message(id: string, messageId: string): ManagerMessage | undefined {
    return this.log(id).get(messageId);
  }

  nextSeq(id: string): number {
    return this.log(id).nextSeq();
  }

  /** Command output and agent text can quote a token; the chat file outlives the turn. */
  persistMessage(id: string, message: ManagerMessage): ManagerMessage {
    const clean = redactDeep(message, this.secrets) as ManagerMessage;
    this.log(id).persist(clean);
    return clean;
  }

  setLiveMessage(id: string, message: ManagerMessage): void {
    this.log(id).setLive(message);
  }

  state(id: string): ManagerState {
    const path = join(this.dir(id), 'state.json');
    if (!existsSync(path)) return EMPTY_STATE();
    try {
      return stateSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      this.warnOnce(`[cezar] ${path} is unreadable; starting from an empty manager state`);
      return EMPTY_STATE();
    }
  }

  updateState(id: string, change: (state: ManagerState) => ManagerState): ManagerState {
    const next = change(this.state(id));
    atomicWriteJsonSync(join(this.dir(id), 'state.json'), next);
    return next;
  }

  removeFiles(id: string): void {
    this.logs.delete(id);
    assertCezarHomeWriteIsSandboxed(this.dir(id));
    rmSync(this.dir(id), { recursive: true, force: true });
  }
}
