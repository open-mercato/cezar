import { constants, closeSync, openSync, renameSync, writeSync } from 'node:fs';
import { open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { atomicWrite, readState, statePath, syncDirectory, prepareText } from './storage.ts';
import { webhookSourceSchema, type WebhookSource } from './source.ts';

const headerSchema = z.strictObject({ version: z.literal(1), segment: z.string().uuid(), installationId: z.string(), highWater: z.number().int().nonnegative() });
const cursorSchema = z.strictObject({ segment: z.string(), offset: z.number().int().nonnegative() });
type Entry = { source: WebhookSource; start: number; end: number };
export class OutboxIntegrityError extends Error {}
export class Outbox {
  get needsRecovery(): boolean { return this.unavailable; }
  highWater = 0;
  captureGap = false;
  private unavailable = false;
  private generation = 0;
  private bytes = 0;
  private offset = 0;
  private headerEnd = 0;
  private segment: string = randomUUID();
  private entries: Entry[] = [];
  private constructor(private readonly directory: string, private readonly installationId: string, private readonly capacity: number) {}

  static async open(directory: string, installationId: string, highWater = 0, capacity = 50 * 1024 * 1024): Promise<Outbox> {
    const box = new Outbox(directory, installationId, capacity);
    const path = statePath(directory, 'outbox.ndjson');
    let data: Buffer;
    try {
      if ((await stat(path)).size > capacity) throw new OutboxIntegrityError('Webhook outbox exceeds capacity');
      data = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      data = Buffer.from(box.header(highWater));
      await writeFile(path, data, { flag: 'wx', mode: 0o600 });
    }
    const firstEnd = data.indexOf(10) + 1;
    if (!firstEnd) throw new OutboxIntegrityError('Invalid webhook outbox header');
    let header: z.infer<typeof headerSchema>;
    try { header = headerSchema.parse(JSON.parse(data.subarray(0, firstEnd).toString())); }
    catch { throw new OutboxIntegrityError('Invalid webhook outbox header'); }
    if (header.installationId !== installationId) throw new OutboxIntegrityError('Webhook outbox installation mismatch');
    box.segment = header.segment; box.highWater = Math.max(highWater, header.highWater); box.headerEnd = firstEnd;
    let cursor = firstEnd;
    let previousSequence = 0;
    while (cursor < data.length) {
      const end = data.indexOf(10, cursor) + 1;
      if (!end) {
        const evidence = await prepareText(directory, 'outbox-tail-latest.quarantine', data.subarray(cursor, cursor + 65536));
        try { evidence.publish(); await evidence.finish(); } finally { await evidence.discard(); }
        const file = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW);
        try { await file.truncate(cursor); await file.sync(); } finally { await file.close(); }
        data = data.subarray(0, cursor); box.captureGap = true; break;
      }
      let source: WebhookSource;
      try { source = webhookSourceSchema.parse(JSON.parse(data.subarray(cursor, end).toString())); }
      catch { throw new OutboxIntegrityError('Invalid webhook outbox record'); }
      if (source.installationId !== installationId || source.sequence <= previousSequence) throw new OutboxIntegrityError('Invalid webhook outbox order');
      previousSequence = source.sequence;
      box.highWater = Math.max(box.highWater, source.sequence);
      box.entries.push({ source, start: cursor, end }); cursor = end;
    }
    box.bytes = data.length;
    const saved = await readState(directory, 'cursor.json', cursorSchema).catch(() => undefined);
    box.offset = saved?.segment === box.segment && (saved.offset === firstEnd || box.entries.some(entry => entry.end === saved.offset)) ? saved.offset : firstEnd;
    return box;
  }
  private header(highWater: number, segment = this.segment): string {
    return JSON.stringify({ version: 1, segment, installationId: this.installationId, highWater }) + '\n';
  }
  /** Runs synchronously inside a transition observer: no fsync, Promise, lock or exception. */
  append(input: WebhookSource): boolean {
    if (this.unavailable) return false;
    let fd: number | undefined;
    let writing = false;
    try {
      const source = webhookSourceSchema.parse(input);
      if (source.installationId !== this.installationId || source.sequence !== this.highWater + 1) throw new Error('Invalid source sequence');
      const bytes = Buffer.from(JSON.stringify(source) + '\n');
      if (bytes.length > 64 * 1024 || this.bytes + bytes.length > this.capacity) { this.captureGap = true; return false; }
      writing = true;
      fd = openSync(statePath(this.directory, 'outbox.ndjson'), constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
      let written = 0;
      while (written < bytes.length) {
        const amount = writeSync(fd, bytes, written, bytes.length - written);
        if (!amount) throw new Error('Incomplete source append');
        written += amount;
      }
      this.entries.push({ source, start: this.bytes, end: this.bytes + bytes.length });
      this.bytes += bytes.length; this.highWater = source.sequence; this.generation++;
      return true;
    } catch (error) {
      this.captureGap = true;
      // A write error can leave a partial line: stop until startup repairs it.
      if (writing) this.unavailable = true;
      return false;
    } finally { if (fd !== undefined) { try { closeSync(fd); } catch { this.unavailable = true; } } }
  }
  sources(): WebhookSource[] { return this.entries.map(entry => structuredClone(entry.source)); }
  get compactedThrough(): number { return this.entries[0] ? this.entries[0].source.sequence - 1 : this.highWater; }
  /** Whether compaction has anything to drop: an unconsumed-only segment is already compact. */
  get consumed(): boolean { return this.offset > this.headerEnd; }
  peek(): Entry | undefined { return this.entries.find(entry => entry.start >= this.offset); }
  async advance(end: number): Promise<void> {
    if (this.peek()?.end !== end) throw new Error('Invalid webhook outbox cursor');
    await atomicWrite(this.directory, 'cursor.json', { segment: this.segment, offset: end });
    this.offset = end;
  }
  /** Caller serializes cursor mutation and persists failure identity before compaction. */
  async compact(): Promise<boolean> {
    if (this.unavailable) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const generation = this.generation, length = this.bytes, offset = this.offset, segment = this.segment;
      const remaining = this.entries.filter(entry => entry.start >= offset);
      const nextSegment = randomUUID();
      const header = this.header(this.highWater, nextSegment);
      const bytes = Buffer.from(header + remaining.map(entry => JSON.stringify(entry.source) + '\n').join(''));
      const temporary = statePath(this.directory, `outbox-${randomUUID()}.tmp`);
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      } catch (error) { await rm(temporary, { force: true }); throw error; }
      // Nothing may yield between comparison, rename and publication of the new append target.
      if (this.generation !== generation || this.bytes !== length || this.offset !== offset || this.segment !== segment) {
        await rm(temporary, { force: true }); continue;
      }
      try {
        renameSync(temporary, statePath(this.directory, 'outbox.ndjson'));
        this.segment = nextSegment; this.headerEnd = Buffer.byteLength(header); this.offset = this.headerEnd; this.bytes = bytes.length;
        let start = this.headerEnd;
        this.entries = remaining.map(entry => { const end = start + Buffer.byteLength(JSON.stringify(entry.source) + '\n'); const next = { source: entry.source, start, end }; start = end; return next; });
        this.generation++;
        await syncDirectory(this.directory);
        await atomicWrite(this.directory, 'cursor.json', { segment: this.segment, offset: this.headerEnd });
        return true;
      } catch (error) { this.unavailable = true; this.captureGap = true; throw error; }
      finally { await rm(temporary, { force: true }); }
    }
    return false; // Coordinator retries after 30s, never spins under sustained capture.
  }
}
