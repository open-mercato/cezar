/** Account holds outlive their source tasks. Immutable entries avoid cross-process lost updates. */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { assertCezarHomeWriteIsSandboxed, cezarHomeDir } from '../paths.ts';
import { atomicWriteJsonSync } from './config.ts';

const holdSchema = z.object({ account: z.string().min(1), until: z.string().datetime() });
type Hold = z.infer<typeof holdSchema>;
const keyOf = (hold: Hold) => createHash('sha256').update(JSON.stringify([hold.account, hold.until])).digest('hex') + '.json';

export class AgentUsageHolds {
  // Pin the home once, including the in-memory fallback for an unwritable home.
  private readonly directory = join(cezarHomeDir(), 'agent-usage-holds');
  private readonly memory = new Map<string, Hold>();
  private warned = false;

  remember(hold: Hold): void {
    if (!holdSchema.safeParse(hold).success || Date.parse(hold.until) <= Date.now()) return;
    const key = keyOf(hold);
    if (this.memory.has(key)) return;
    this.memory.set(key, hold);
    try {
      // Equal keys always contain identical data; simultaneous writers cannot shorten a hold.
      atomicWriteJsonSync(join(this.directory, key), hold);
    } catch {
      if (!this.warned) console.warn('[cez] account usage hold could not be persisted; keeping it in memory');
      this.warned = true;
    }
  }

  active(now = Date.now()): Hold[] {
    let files: string[] = [];
    try { files = readdirSync(this.directory); } catch { /* absent/read-only home: use memory */ }
    for (const file of files) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      try {
        const parsed = holdSchema.safeParse(JSON.parse(readFileSync(join(this.directory, file), 'utf8')));
        if (!parsed.success || keyOf(parsed.data) !== file) continue;
        this.memory.set(file, parsed.data);
      } catch { /* salvage other entries independently */ }
    }
    for (const [file, hold] of this.memory) {
      if (Date.parse(hold.until) > now) continue;
      this.memory.delete(file);
      try {
        const path = join(this.directory, file);
        assertCezarHomeWriteIsSandboxed(path);
        rmSync(path, { force: true });
      } catch { /* expiry is honored even when cleanup cannot write */ }
    }
    return [...this.memory.values()];
  }
}
